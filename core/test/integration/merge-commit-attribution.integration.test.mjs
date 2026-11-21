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

// 工作树/合并安全加固（P-20261121-1）定向验证：
// C0 dispatch：任务工作树被手动切到别的分支 → 暂缓原因 worktree-branch-mismatch（不是笼统 worktree-failed）；
// C1 merge：分支缺 result.commit 且无 (<id>) 尾注 → merge.failed/commit-not-on-branch + blocked + 停队列
//    （旧实现会把停在 base 祖先的任务支当「已合」静默归档，工作丢失）；
// C2 merge：rebase 重试（提交被重写、尾注仍在）→ 正常合入——尾注兜底不误报。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, tmpdir, mkToyRepo, addTask, writeProfile, pollFold } from '../helpers.mjs';

const git = (repo, args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const isAncestor = (repo, maybeAncestor, ref) =>
  spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', maybeAncestor, ref], { encoding: 'utf8', windowsHide: true }).status === 0;

/** 玩具 HOME + fake 执行器跑完 n 个 git 任务至 folded done（工作树已由 fold 移除） */
async function setupFolded(prefix, ids) {
  const dir = tmpdir(prefix);
  const home = path.join(dir, 'home');
  const repo = mkToyRepo(dir);
  fs.mkdirSync(home, { recursive: true });
  writeProfile(home, 'toy', `repo: ${repo.replaceAll('\\', '/')}\ndefault-base: main\nrunner: fake\n`);
  for (const id of ids) await addTask(home, { id, project: 'toy', title: `数据面任务 ${id}`, status: 'approved' });
  for (const id of ids) run('dispatch', ['--task', id], { home });
  await pollFold(home, { expectCount: ids.length });
  return { dir, home, repo };
}

test('C0 dispatch：任务工作树检出分支不符 → 暂缓 worktree-branch-mismatch（候选受控跳过）', async () => {
  const dir = tmpdir('schflow-attrib0-');
  const home = path.join(dir, 'home');
  const repo = mkToyRepo(dir);
  const id = 'P-20261121-90';
  fs.mkdirSync(home, { recursive: true });
  writeProfile(home, 'toy', `repo: ${repo.replaceAll('\\', '/')}\ndefault-base: main\nrunner: fake\n`);
  await addTask(home, { id, project: 'toy', title: '工作树错位任务', status: 'approved' });

  // 预置同路径工作树但检出别的分支（模拟手动切分支/多 HOME 撞 id）
  const wt = path.join(dir, '.schflow-worktrees', 'toyrepo', id);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, ['worktree', 'add', '-b', 'wrong-branch', wt, 'main']);

  const d = run('dispatch', ['--task', id, '--json'], { home, expectFail: true });
  const row = d.json.deferred.find((r) => r.id === id);
  assert.ok(row, `应暂缓该候选：${d.stdout}`);
  assert.equal(row.reason, 'worktree-branch-mismatch', '按前缀映射为专用暂缓原因');
  assert.match(row.detail, /^worktree-branch-mismatch: 期望 schflow\//, 'detail 保留期望/实际信息');
  assert.equal(d.json.dispatched.length, 0, '不派发');

  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');
  assert.equal(loadCard(findTaskDir(home, id)).status, 'approved', '任务未被翻转（候选跳过不阻塞）');
});

test('C1 merge：提交不在任务分支且无 id 尾注 → commit-not-on-branch + blocked + 停队列', async () => {
  const idA = 'P-20261121-91';
  const idB = 'P-20261121-92';
  const { home, repo } = await setupFolded('schflow-attrib1-', [idA, idB]);
  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');
  const commit = loadCard(findTaskDir(home, idA)).result.commit;
  assert.ok(commit, 'fake 执行器回报提交');

  // 错位现场：提交被挪到旁支，任务支退回 main（已是 base 祖先——旧实现会走 already-ancestor 静默归档）
  git(repo, ['branch', `keep-${idA}`, commit]);
  git(repo, ['branch', '-f', `schflow/${idA}`, 'main']);
  assert.equal(isAncestor(repo, commit, `schflow/${idA}`), false, '提交不在任务支');
  assert.equal(git(repo, ['log', '--format=%H', `schflow/${idA}`, '--grep', `(${idA})`]), '', '任务支历史无 id 尾注');

  const m = run('merge', ['--json'], { home });
  const row = m.json.results.find((r) => r.task === idA);
  assert.ok(row, `结果须含 ${idA}：${m.stdout}`);
  assert.equal(row.outcome, 'merge.failed');
  assert.match(row.reason, /commit-not-on-branch/);
  assert.equal(loadCard(findTaskDir(home, idA)).status, 'blocked', '数据可疑 → blocked');

  const { readEvents } = await import('../../lib/events.mjs');
  const failed = readEvents(home, { types: ['merge.failed'] }).find((e) => e.taskId === idA);
  assert.equal(failed?.reason, 'commit-not-on-branch');
  assert.ok(failed.detail.startsWith(commit), `detail 记 <commit>@<branch 头>：${failed.detail}`);
  assert.ok(!readEvents(home, { types: ['merge.started'] }).some((e) => e.taskId === idA), '校验在合并启动之前');
  assert.ok(!readEvents(home, { types: ['merge.done'] }).some((e) => e.taskId === idA), '不得静默归档');

  // 停本队列：后续候选不被越过
  assert.ok(!readEvents(home, { types: ['merge.done'] }).some((e) => e.taskId === idB), `队列已停，${idB} 不得合入`);
  assert.equal(loadCard(findTaskDir(home, idB)).status, 'done', '第二任务保持待合');
  assert.ok(findTaskDir(home, idB).includes(`${path.sep}open${path.sep}`), '第二任务未被归档');
});

test('C2 merge：rebase 重试后原提交被重写、尾注仍在 → 正常合入（尾注兜底不误报）', async () => {
  const id = 'P-20261121-93';
  const { home, repo } = await setupFolded('schflow-attrib2-', [id]);
  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');
  const commit = loadCard(findTaskDir(home, id)).result.commit;

  // 模拟合并重试的既有资产形态：base 前移 + 分支已 rebase（提交重写，尾注不变）
  fs.writeFileSync(path.join(repo, 'main-advance.txt'), 'advanced\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'main advance']);
  git(repo, ['checkout', `schflow/${id}`]);
  git(repo, ['rebase', 'main']);
  git(repo, ['checkout', 'main']);
  assert.notEqual(git(repo, ['rev-parse', `schflow/${id}`]), commit, '提交已被 rebase 重写');
  assert.equal(isAncestor(repo, commit, `schflow/${id}`), false, '原 result.commit 不再在分支上');
  assert.notEqual(git(repo, ['log', '--format=%H', `schflow/${id}`, '--grep', `(${id})`]), '', '尾注仍在分支历史（兜底条件）');

  const m = run('merge', ['--json'], { home });
  assert.ok(m.json.results.some((r) => r.task === id && r.outcome === 'merge.done'), `尾注兜底应正常合入：${m.stdout}`);
  assert.match(git(repo, ['show', `main:fake/${id}.md`]), new RegExp(`fake deliverable for ${id}`), '提交内容随合并进 base');
});
