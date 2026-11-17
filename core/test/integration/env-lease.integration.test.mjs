// Copyright 2026 schflow contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// 金场景 #G3 环境租约（无 LLM）：声明 env 的任务派发必经租约——exclusive 串行、env-wait 跳过
// 不饿死后续无 env 候选、fold 释放、重派可得。性质断言（硬门）：
// P11 取不到租约=该候选跳过（env-wait 报告），无 env 需求候选照派；
// P12 任务终态（fold done）即释放，第二候选下一轮可得租约；
// P13 setup/teardown 钩子 0→1 / N→0 跳变各执行一次。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, mkToyRepo, addTask, writeProfile, writeEnvs, pollFold } from '../helpers.mjs';

test('env 租约：串行化环境、跳过不饿死、释放后再取', async () => {
  const dir = tmpdir('schflow-g3-');
  const home = path.join(dir, 'home');
  const repo = mkToyRepo(dir);
  fs.mkdirSync(home, { recursive: true });
  writeProfile(home, 'toy', `repo: ${repo.replaceAll('\\', '/')}\ndefault-base: main\nrunner: fake\nconcurrency: 3\n`);
  const hookLog = path.join(home, 'hooks.log').replaceAll('\\', '/');
  writeEnvs(home, `
provider: static
environments:
  staging-a:
    acquire: exclusive
    setup: echo setup >> ${hookLog}
    teardown: echo teardown >> ${hookLog}
    labels: [linux]
    ref: "docs/envs/staging-a.md"
`);

  // 三支：两支要 staging-a（exclusive 一时间一份），一支无 env
  await addTask(home, { id: 'P-20261117-1', project: 'toy', title: '要环境甲', status: 'approved', env: 'staging-a' });
  await addTask(home, { id: 'P-20261117-2', project: 'toy', title: '要环境乙', status: 'approved', env: 'staging-a' });
  await addTask(home, { id: 'P-20261117-3', project: 'toy', title: '无环境丙', status: 'approved' });

  const d1 = run('dispatch', ['--auto', '--json'], { home, expectFail: true });
  // 1+3 派发（2 等 env）；dispatched>0 → exit 0？——本实现 dispatched>0 即 0；expectFail 容错两面
  const got = d1.json.dispatched.map((x) => x.id).sort();
  assert.deepEqual(got, ['P-20261117-1', 'P-20261117-3'], 'P11：租约占用者派、无 env 候选照派、等租约者跳过');
  assert.ok(d1.json.deferred.some((x) => x.id === 'P-20261117-2' && x.reason === 'env-wait'), '暂缓原因 env-wait 入报告');

  await pollFold(home, { expectCount: 2 });
  // P12/P13：fold 释放 → 下一轮 2 号可得
  const d2 = run('dispatch', ['--auto', '--json'], { home });
  assert.deepEqual(d2.json.dispatched.map((x) => x.id), ['P-20261117-2'], '释放后再取');
  await pollFold(home, { expectCount: 3 });

  const hooks = fs.readFileSync(hookLog, 'utf8');
  assert.equal((hooks.match(/setup/g) || []).length, 2, 'setup 各一次（两轮占用）');
  assert.equal((hooks.match(/teardown/g) || []).length, 2, 'teardown 各一次');

  // env.leased/released 事件审计
  const { readEvents } = await import('../../lib/events.mjs');
  const env = readEvents(home, { types: ['env.leased', 'env.released'] });
  assert.equal(env.filter((e) => e.type === 'env.leased').length, 2);
  assert.equal(env.filter((e) => e.type === 'env.released').length, 2);

  const m = run('merge', ['--json'], { home });
  assert.equal(m.json.results.filter((r) => r.outcome === 'merge.done').length, 3, '三支最终全部合入');
});
