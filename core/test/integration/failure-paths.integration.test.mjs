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

// 金场景 #G2 失败路径（无 LLM）：blocked 折叠 / interrupted 重派（附前次产物引用）/ 复验失败 ejected
// 队列继续 / secret-scan 命中挂起。性质断言（硬门）：
// P7 executor 死亡无 result → interrupted（status→approved，attempts 计派发次数）；
// P8 重派任务书含「前次尝试产物」引用（契约底线④）；
// P9 复验失败=ejected 且队列继续（不队头阻塞）；
// P10 出口扫描命中=merge.failed+任务受阻+队列停止（后续支不动）。
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

function setup(prefix, profileYaml) {
  const dir = tmpdir(prefix);
  const home = path.join(dir, 'home');
  const repo = mkToyRepo(dir);
  fs.mkdirSync(home, { recursive: true });
  writeProfile(home, 'toy', profileYaml.replaceAll('{REPO}', repo.replaceAll('\\', '/')));
  return { dir, home, repo };
}

test('blocked / interrupted：四态折叠 + 重派附前次引用', async () => {
  const { home, repo } = setup('schflow-g2a-', 'repo: {REPO}\ndefault-base: main\nrunner: fake\n');
  await addTask(home, { id: 'P-20261117-1', project: 'toy', title: '受阻任务', status: 'approved' });
  run('dispatch', ['--task', 'P-20261117-1', '--fake-mode', 'blocked'], { home });
  await pollFold(home, { expectCount: 1 });
  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');
  assert.equal(loadCard(findTaskDir(home, 'P-20261117-1')).status, 'blocked');

  const id2 = 'P-20261117-2';
  await addTask(home, { id: id2, project: 'toy', title: '中断任务', status: 'approved' });
  run('dispatch', ['--task', id2, '--fake-mode', 'crash'], { home });
  await pollFold(home, { expectCount: 2 });
  const card2 = loadCard(findTaskDir(home, id2));
  assert.equal(card2.status, 'approved', 'interrupted → 回 approved 待重派');
  assert.equal(card2.attempts, 1, 'attempts=派发计数');

  // 重派：runNo=2，任务书带前次引用；fake 幂等重入（crash 没提交过 → 本次正常 done）
  run('dispatch', ['--task', id2, '--fake-mode', 'done'], { home });
  const book = fs.readFileSync(path.join(home, 'tasks', 'open', id2, 'runs', '2', 'task-book.md'), 'utf8');
  assert.match(book, /前次尝试产物[\s\S]*runs\/1\//, 'P8 前次产物引用');
  assert.match(book, /UNTRUSTED-CONTENT-START/, '不可信围栏在场');
  await pollFold(home, { expectCount: 3 });
  assert.equal(loadCard(findTaskDir(home, id2)).status, 'done');
  assert.equal(loadCard(findTaskDir(home, id2)).attempts, 2);
});

test('ejected：复验失败回炉受阻、队列继续下一支（P9）', async () => {
  const { home, repo } = setup('schflow-g2b-', [
    'repo: {REPO}', 'default-base: main', 'runner: fake', 'concurrency: 2',
    // verify 用免引号形态 `exit 1`——shell 引号经 Windows cmd.exe 二次包装会形变（跨平台教训）
    'verify:', '  - cmd: "exit 1"', '    when: always',
  ].join('\n'));
  await addTask(home, { id: 'P-20261117-1', project: 'toy', title: '先失败支', status: 'approved' });
  run('dispatch', ['--task', 'P-20261117-1'], { home });
  await pollFold(home, { expectCount: 1 });

  await addTask(home, { id: 'P-20261117-2', project: 'toy', title: '后续支', status: 'approved' });
  run('dispatch', ['--task', 'P-20261117-2'], { home });
  await pollFold(home, { expectCount: 2 });

  // 制造 base 漂移（主线增量）——零交集时复验按决策 31-④ 跳过，必须漂移才走复验
  fs.writeFileSync(path.join(repo, 'drift.txt'), 'main advanced\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'chore: base drift');

  const m = run('merge', ['--json'], { home });
  assert.ok(m.json.results.some((r) => r.task === 'P-20261117-1' && r.outcome === 'ejected'), `第一支 ejected（实际：${JSON.stringify(m.json.results)}）`);
  assert.ok(m.json.results.some((r) => r.task === 'P-20261117-2' && r.outcome === 'ejected'), '第二支同因 ejected（verify 链全局红）——队列未队头阻塞');

  const { findTaskDir, loadCard, transition } = await import('../../lib/store.mjs');
  assert.equal(loadCard(findTaskDir(home, 'P-20261117-1')).status, 'blocked', 'ejected → 回炉受阻');
  // 修好 verify 后回炉重走：blocked → approved（人工裁决）→ 重派（fake 幂等重入复用既有提交）→ 折叠 → 合并
  transition(home, 'P-20261117-1', 'approved', { actor: 'human' });
  writeProfile(home, 'toy', `repo: ${repo.replaceAll('\\', '/')}\ndefault-base: main\nrunner: fake\nverify:\n  - cmd: "exit 0"\n`);
  run('dispatch', ['--task', 'P-20261117-1', '--json'], { home });
  await pollFold(home, { expectCount: 3 });
  run('merge', ['--json'], { home });
  const { readEvents } = await import('../../lib/events.mjs');
  const done = readEvents(home, { types: ['merge.done'] }).map((e) => e.taskId);
  assert.ok(done.includes('P-20261117-1'), '修复后重新入队合入');
  assert.equal(git(repo, 'branch', '--list', 'schflow/P-20261117-1'), '', '已合支删除');
});

test('secret-scan：出口扫描命中 → 挂起人工、队列停止（P10）', async () => {
  const { home } = setup('schflow-g2c-', 'repo: {REPO}\ndefault-base: main\nrunner: fake\nconcurrency: 2\n');
  await addTask(home, { id: 'P-20261117-1', project: 'toy', title: '泄密支', status: 'approved' });
  run('dispatch', ['--task', 'P-20261117-1', '--fake-mode', 'secret'], { home });
  await addTask(home, { id: 'P-20261117-2', project: 'toy', title: '干净支', status: 'approved' });
  run('dispatch', ['--task', 'P-20261117-2'], { home });
  await pollFold(home, { expectCount: 2 });

  const m = run('merge', ['--json'], { home });
  assert.ok(m.json.results.some((r) => r.task === 'P-20261117-1' && r.outcome === 'merge.failed' && /secret/.test(r.reason)), '泄密支 merge.failed');
  assert.ok(!m.json.results.some((r) => r.task === 'P-20261117-2' && r.outcome === 'merge.done'), '队列停止：干净支未被推进');

  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');
  assert.equal(loadCard(findTaskDir(home, 'P-20261117-1')).status, 'blocked', '泄密支置受阻');
});
