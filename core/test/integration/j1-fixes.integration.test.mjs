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

// 金场景 #G5 · J1 三缺陷修复回归（性质断言硬门）：
// P14 推送失败=停队列：不删支、不归档、不写 merge.done（任务保持 done 待合；对齐远端后重跑可恢复）；
// P15 原生家族在途条目存活：pid=null 条目不被 readPool 丢弃（二次派发后仍在池、占槽）；
// P16 事件尾行损坏不破坏全局单调：append 回溯到上一条完整行；全卷不可解析=响亮失败拒绝追加。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, tmpdir, mkToyRepo, addTask, writeProfile, pollFold } from '../helpers.mjs';

const git = (repo, ...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

test('P14 推送失败（非快进）：停队列、分支保留、任务待合；对齐远端后重跑恢复', async () => {
  const dir = tmpdir('schflow-g5a-');
  const home = path.join(dir, 'home');
  const repo = mkToyRepo(dir, { origin: true }); // main 已推 origin
  fs.mkdirSync(home, { recursive: true });
  writeProfile(home, 'toy', `repo: ${repo.replaceAll('\\', '/')}\ndefault-base: main\nrunner: fake\n`);
  await addTask(home, { id: 'P-20261117-1', project: 'toy', title: '待合任务', status: 'approved' });
  run('dispatch', ['--task', 'P-20261117-1'], { home });
  await pollFold(home, { expectCount: 1 });

  // 制造远端前移（非快进）：第二克隆提交并推送
  const clone = path.join(dir, 'clone');
  spawnSync('git', ['clone', path.join(dir, 'origin.git'), clone], { encoding: 'utf8', windowsHide: true });
  spawnSync('git', ['-C', clone, 'config', 'user.name', 'o'], { encoding: 'utf8' });
  spawnSync('git', ['-C', clone, 'config', 'user.email', 'o@t.local'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(clone, 'remote.txt'), 'remote advanced\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-m', 'remote commit');
  git(clone, 'push', 'origin', 'HEAD:refs/heads/main');

  const m1 = run('merge', ['--json'], { home });
  const r1 = m1.json.results.filter((r) => r.task === 'P-20261117-1');
  assert.ok(r1.some((r) => r.outcome === 'merge.failed' && /非快进|non-ff/i.test(r.reason)), `应有 merge.failed：${JSON.stringify(r1)}`);
  assert.ok(!r1.some((r) => r.outcome === 'merge.done'), 'P14：不得写 merge.done');
  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');
  const cardDir = findTaskDir(home, 'P-20261117-1');
  assert.ok(cardDir.includes(`${path.sep}open${path.sep}`), 'P14：不得归档');
  assert.equal(loadCard(cardDir).status, 'done', '任务保持 done 待合');
  assert.match(git(repo, 'branch', '--list', 'schflow/P-20261117-1'), /schflow\/P-20261117-1/, 'P14：分支保留');

  // 恢复（人工对齐远端的标准动作）：fetch + 把远端提交并进本地 main；重跑 merge
  // → 任务支已是 main 祖先（already-ancestor 幂等恢复）→ merge.done + 归档 + 删支 + ff 推送成功
  git(repo, 'fetch', 'origin');
  git(repo, 'merge', '--no-edit', 'origin/main');
  const m2 = run('merge', ['--json'], { home });
  assert.ok(m2.json.results.some((r) => r.task === 'P-20261117-1' && r.outcome === 'merge.done'), `重跑应恢复：${JSON.stringify(m2.json.results)}`);
  assert.ok(findTaskDir(home, 'P-20261117-1').includes(`${path.sep}done${path.sep}`), '恢复后归档');
  assert.equal(git(repo, 'branch', '--list', 'schflow/P-20261117-1'), '', '恢复后删支');
});

test('P15 原生家族条目在二次派发后仍存活（pid=null 合法）', async () => {
  const home = path.join(tmpdir('schflow-g5b-', ''), 'home');
  fs.mkdirSync(home, { recursive: true });
  await addTask(home, { id: 'P-20261117-1', kind: 'investigate', title: '原生甲', status: 'approved' });
  await addTask(home, { id: 'P-20261117-2', kind: 'investigate', title: '原生乙', status: 'approved' });

  run('dispatch', ['--task', 'P-20261117-1', '--no-spawn', '--launcher', 'test'], { home });
  run('dispatch', ['--task', 'P-20261117-2', '--no-spawn', '--launcher', 'test'], { home });
  const pool1 = JSON.parse(fs.readFileSync(path.join(home, 'state', 'pool.json'), 'utf8'));
  assert.equal(pool1.inFlight.length, 2);

  // 第三次派发触发 readPool 过滤路径（修复前会把 pid=null 条目全部丢掉）
  await addTask(home, { id: 'P-20261117-3', kind: 'investigate', title: '原生丙', status: 'approved' });
  run('dispatch', ['--task', 'P-20261117-3', '--no-spawn', '--launcher', 'test', '--concurrency', '3'], { home });
  const pool2 = JSON.parse(fs.readFileSync(path.join(home, 'state', 'pool.json'), 'utf8'));
  assert.equal(pool2.inFlight.length, 3, `P15：三次原生派发后池内应 3 条：${JSON.stringify(pool2)}`);
  assert.ok(pool2.inFlight.every((e) => e.pid === null), '全部为原生家族条目');
});

test('P16 事件尾行损坏：append 回溯上一条完整行（seq 不归零）；全卷不可解析=响亮失败', async () => {
  const { appendEvent, lastSeq, readEvents } = await import('../../lib/events.mjs');
  const { resolveHome } = await import('../../lib/home.mjs');
  const home = resolveHome(path.join(tmpdir('schflow-g5c-'), 'home'));

  appendEvent(home, { type: 'heartbeat.tick', actor: 'engine' });
  const e42 = appendEvent(home, { type: 'note.appended', actor: 'human', taskId: 'P-1', note: 'x' });
  assert.equal(e42.seq, 2);

  // 模拟 append 中被杀：追加半截 JSON
  const { paths } = await import('../../lib/home.mjs');
  const vol = paths(home).eventsVolume('2026-11');
  fs.appendFileSync(vol, '{"ts":"2026-11-17T00:00:00Z","seq":3,"schemaVers');

  assert.equal(lastSeq(home), 2, 'P16：回溯到上一条完整行');
  const e3 = appendEvent(home, { type: 'heartbeat.tick', actor: 'engine' });
  assert.equal(e3.seq, 3, 'P16：不归零，续 3');
  const all = readEvents(home);
  assert.equal(all.malformed, 1, '损坏行被读取面跳过并计数');

  // 全卷不可解析 → 响亮失败
  const home2 = resolveHome(path.join(tmpdir('schflow-g5d-'), 'home'));
  const vol2 = paths(home2).eventsVolume('2026-11');
  fs.writeFileSync(vol2, 'garbage line one\nanother garbage\n');
  assert.throws(() => lastSeq(home2), /无任何可解析行/, 'P16：拒绝静默归零');
  assert.throws(() => appendEvent(home2, { type: 'heartbeat.tick', actor: 'engine' }), /无任何可解析行/);
});
