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

// 金场景 #G1 全链（无 LLM）：提案→批准→dispatch（假执行器 worktree 并行）→fold 收编
// →merge 队列串行 --no-ff 合入 base→删支→归档。性质断言（硬门）：
// P1 派发先于折叠（seq 序）；P2 同 (repo,base) FIFO 按 folded seq；P3 待合即合（队列一次排空）；
// P4 合并提交双亲（base 前尖+任务支）；P5 删支安全阀（分支消失、任务归档 done/<月>/）；
// P6 dispatched 事件含 family/launcher/promptVersion/mounts（防漂移审计面）。
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

test('全链：两任务同 base 并行执行、串行合并、FIFO 顺序成立', async () => {
  const dir = tmpdir('schflow-g1-');
  const home = path.join(dir, 'home');
  const repo = mkToyRepo(dir);
  fs.mkdirSync(home, { recursive: true });
  writeProfile(home, 'toy', `repo: ${repo.replaceAll('\\', '/')}\ndefault-base: main\nrunner: fake\nconcurrency: 2\n`);
  const baseTipBefore = git(repo, 'rev-parse', 'main');

  const a = await addTask(home, { id: 'P-20261117-1', project: 'toy', title: '任务甲', status: 'approved' });
  const b = await addTask(home, { id: 'P-20261117-2', project: 'toy', title: '任务乙', status: 'approved' });

  const d = run('dispatch', ['--auto', '--json'], { home });
  assert.equal(d.code, 0);
  assert.equal(d.json.dispatched.length, 2, '空槽+可派必须填满（清单⑦）');
  for (const x of d.json.dispatched) {
    assert.match(x.branch, /^schflow\/P-\d{8}-\d+$/);
    assert.ok(fs.existsSync(x.worktree), 'worktree 已建');
  }

  // P6：dispatched 事件审计面
  const { readEvents } = await import('../../lib/events.mjs');
  const dispatched = readEvents(home, { types: ['dispatched'] });
  assert.equal(dispatched.length, 2);
  for (const e of dispatched) {
    assert.equal(e.family, 'subprocess');
    assert.equal(e.launcher, 'fake');
    assert.ok(e.promptVersion, 'promptVersion 必记（P1-14）');
    assert.ok(Array.isArray(e.mounts));
  }

  await pollFold(home, { expectCount: 2 });
  const merged = run('merge', ['--json'], { home });
  assert.ok(merged.json.results.filter((r) => r.outcome === 'merge.done').length === 2, `两支都要合入: ${merged.stdout}`);

  // P1/P2：事件序性质
  const evts = readEvents(home);
  const seqOf = (pred) => evts.filter(pred).map((e) => e.seq);
  for (const id of [a.id, b.id]) {
    const dis = seqOf((e) => e.type === 'dispatched' && e.taskId === id)[0];
    const fold = seqOf((e) => e.type === 'folded' && e.taskId === id)[0];
    const ms = seqOf((e) => e.type === 'merge.started' && e.taskId === id)[0];
    const md = seqOf((e) => e.type === 'merge.done' && e.taskId === id)[0];
    assert.ok(dis < fold && fold < ms && md, `${id} 事件序 派发<折叠<合并起<合并毕`);
  }
  // P2 FIFO：folded 顺序=merge.done 顺序
  const foldOrder = evts.filter((e) => e.type === 'folded' && e.outcome === 'done').map((e) => e.taskId);
  const mergeOrder = evts.filter((e) => e.type === 'merge.done').map((e) => e.taskId);
  assert.deepEqual(mergeOrder, foldOrder, '同 (repo,base) FIFO');

  // P4（结构化断言）：base 上新增恰两笔 merge commit，且先合是后合的祖先（串行证据——
  // 不假设行序：第二任务 rebase 后自身提交会夹在两笔 merge 之间）
  const merges = git(repo, 'rev-list', '--merges', '--reverse', `${baseTipBefore}..main`).split('\n').filter(Boolean);
  assert.equal(merges.length, 2, `恰两笔 merge commit（实际：${git(repo, 'log', '--oneline', '-6')}）`);
  const anc = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', merges[0], merges[1]]);
  assert.equal(anc.status, 0, '先合是后合的祖先（串行）');
  // 两任务的交付都在 main 上（fake/<id>.md）
  for (const id of [a.id, b.id]) {
    assert.equal(spawnSync('git', ['-C', repo, 'cat-file', '-e', `main:fake/${id}.md`]).status, 0, `${id} 交付在 main`);
  }

  // P5：分支删除、任务归档、worktree 清理
  assert.equal(git(repo, 'branch', '--list', 'schflow/*'), '', '任务分支全删');
  const doneDir = fs.readdirSync(path.join(home, 'tasks', 'done'));
  assert.equal(doneDir.length, 1);
  const ids = fs.readdirSync(path.join(home, 'tasks', 'done', doneDir[0]));
  assert.deepEqual(ids.sort(), [a.id, b.id].sort());
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').split('\n\n').length - 1, 1, '只剩主工作树');

  // 任务卡 result 回填
  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');
  const cardA = loadCard(findTaskDir(home, a.id));
  assert.equal(cardA.status, 'done');
  assert.match(cardA.result.commit, /^[0-9a-f]{40}$/);
});
