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

// merge 冲突自动恢复链（L0/L1/L2，core/lib/conflicto.mjs）性质断言（硬门）：
// A1 纯追加对撞（base 与分支同文件末尾各追加不同行）→ merge.auto-resolved{level:semantic-union}
//    + merge.done + base 尖含双侧行；
// A2 双侧改写同段 → 块级不安全 → 无 judge 时照旧 eject（reason 含 rebase-conflict）——零 LLM 缺省面回归；
// A3 L2 custom judge runner=node 夹具：adopt-theirs 真应用（合并结果==分支侧）+ merge.resolved 事件；
// A4 L2 merge-both：files 内容真应用（分支侧全文+裁决标记）；
// A5 L2 垃圾输出 → fail-closed eject（reason 含 judge-escalate）且 rebase 已 abort、
//    分支仍在、合并工作树干净无半态；
// A6 L2 wsl 桥真机形态（P-20261118-11）：stdout=UTF-16 警告字节前缀+reasoning 草稿 JSON（合法
//    verdict=adopt-ours）+尾行终答（adopt-theirs≠草稿）→ 取末个带 verdict 者胜：应用终答；
// A7 L2 本轮真实失败形态：reasoning 含「可解析但无 verdict」片段+尾行终答 → 解析成功应用；
// A8 L2 全程无合法 verdict（有 JSON 无 verdict 字段）→ 仍 unparseable fail-closed eject；
//    A6/A8 分断言 merge-judge/<时间戳>.txt 证据落盘（成败两路都落）且含「原始输出」段与结论行。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, tmpdir, mkToyRepo, addTask, writeProfile, pollFold, PKG_ROOT } from '../helpers.mjs';

const git = (repo, ...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// rebase --continue 会重放提交——CI 干净环境可能无 git 身份，测试侧全量注入（同 helpers.mjs mkToyRepo 写法）
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'schflow-test', GIT_AUTHOR_EMAIL: 'test@schflow.local',
  GIT_COMMITTER_NAME: 'schflow-test', GIT_COMMITTER_EMAIL: 'test@schflow.local',
};

const judgeArgs = (fixture) => [
  '--judge-resolve', '--judge-runner', 'custom', '--judge-runner-cmd',
  JSON.stringify([process.execPath, path.join(PKG_ROOT, 'core', 'test', 'fixtures', fixture), '{prompt}']),
];

/** 造一台对撞机：fake 执行器落一笔提交后，分支侧与主线侧各自改 README.md（形态由调用方注入） */
async function setupCollision(prefix, id, { branchEdit, mainEdit }) {
  const dir = tmpdir(prefix);
  const home = path.join(dir, 'home');
  const repo = mkToyRepo(dir);
  fs.mkdirSync(home, { recursive: true });
  writeProfile(home, 'toy', `repo: ${repo.replaceAll('\\', '/')}\ndefault-base: main\nrunner: fake\n`);
  await addTask(home, { id, project: 'toy', title: '对撞任务', status: 'approved' });
  run('dispatch', ['--task', id], { home });
  await pollFold(home, { expectCount: 1 });
  // 分支侧（fold 已移除执行工作树——分支无检出，可在 repo 主工作树临时检出提交后切回）
  git(repo, 'checkout', `schflow/${id}`);
  branchEdit(repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'branch side edit');
  git(repo, 'checkout', 'main');
  // 主线侧
  mainEdit(repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'main side edit');
  return { dir, home, repo, id };
}

test('A1 L1 纯追加对撞：双侧同文件末尾各追加 → semantic-union 自愈、base 尖含双侧行', async () => {
  const { home, repo, id } = await setupCollision('schflow-ar1-', 'P-20261118-9', {
    branchEdit: (r) => fs.appendFileSync(path.join(r, 'README.md'), 'branch appended line\n'),
    mainEdit: (r) => fs.appendFileSync(path.join(r, 'README.md'), 'main appended line\n'),
  });
  const m = run('merge', ['--json'], { home, env: GIT_IDENTITY });
  assert.ok(m.json.results.some((r) => r.task === id && r.outcome === 'merge.done'), `纯追加对撞应自愈合入：${m.stdout}`);

  const { readEvents } = await import('../../lib/events.mjs');
  const auto = readEvents(home, { types: ['merge.auto-resolved'] }).find((e) => e.taskId === id);
  assert.ok(auto, 'merge.auto-resolved 事件在');
  assert.equal(auto.level, 'semantic-union', `L1 语义并集：${JSON.stringify(auto)}`);
  assert.ok(auto.files.includes('README.md'), '事件带冲突文件清单');
  const readme = git(repo, 'show', 'main:README.md');
  assert.match(readme, /branch appended line/, 'base 尖含分支侧行');
  assert.match(readme, /main appended line/, 'base 尖含主线侧行');
});

test('A2 L1 双侧改写同段：块级不安全 → 无 judge 照旧 eject（零 LLM 缺省面回归）', async () => {
  const { home, repo, id } = await setupCollision('schflow-ar2-', 'P-20261118-9', {
    branchEdit: (r) => fs.writeFileSync(path.join(r, 'README.md'), '# toy (branch edited)\n'),
    mainEdit: (r) => fs.writeFileSync(path.join(r, 'README.md'), '# toy (main edited)\n'),
  });
  const m = run('merge', ['--json'], { home, env: GIT_IDENTITY });
  const row = m.json.results.find((r) => r.task === id);
  assert.equal(row.outcome, 'ejected', `双侧改写同段应 eject：${m.stdout}`);
  assert.match(row.reason, /rebase-conflict/, 'reason 沿用 rebase-conflict 前缀族');

  const { readEvents } = await import('../../lib/events.mjs');
  assert.equal(readEvents(home, { types: ['merge.auto-resolved', 'merge.resolved'] }).length, 0, '零 LLM 缺省面：无自动恢复事件');
  assert.match(git(repo, 'branch', '--list', `schflow/${id}`), new RegExp(`schflow/${id}`), '分支仍在（回炉面保全）');
  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');
  assert.equal(loadCard(findTaskDir(home, id)).status, 'blocked', 'ejected → 回炉受阻');
});

test('A3 L2 adopt-theirs：custom judge（node 夹具）真应用 + merge.resolved 事件', async () => {
  const { home, repo, id } = await setupCollision('schflow-ar3-', 'P-20261118-9', {
    branchEdit: (r) => fs.writeFileSync(path.join(r, 'README.md'), '# toy (branch edited)\n'),
    mainEdit: (r) => fs.writeFileSync(path.join(r, 'README.md'), '# toy (main edited)\n'),
  });
  const m = run('merge', ['--json', ...judgeArgs('judge-adopt-theirs.mjs')], { home, env: GIT_IDENTITY });
  assert.ok(m.json.results.some((r) => r.task === id && r.outcome === 'merge.done'), `adopt-theirs 应合入：${m.stdout}`);

  const { readEvents } = await import('../../lib/events.mjs');
  const resolved = readEvents(home, { types: ['merge.resolved'] }).find((e) => e.taskId === id);
  assert.ok(resolved, 'merge.resolved 事件在');
  assert.equal(resolved.verdict, 'adopt-theirs');
  assert.equal(resolved.judge, 'custom', '事件带 launcher 名');
  assert.ok(resolved.rationale, '裁决理由必记');
  assert.equal(git(repo, 'show', 'main:README.md'), '# toy (branch edited)', '合并结果==分支侧全文');
});

test('A4 L2 merge-both：files 内容真应用（分支侧全文+裁决标记行）', async () => {
  const { home, repo, id } = await setupCollision('schflow-ar4-', 'P-20261118-9', {
    branchEdit: (r) => fs.writeFileSync(path.join(r, 'README.md'), '# toy (branch edited)\n'),
    mainEdit: (r) => fs.writeFileSync(path.join(r, 'README.md'), '# toy (main edited)\n'),
  });
  const m = run('merge', ['--json', ...judgeArgs('judge-merge-both.mjs')], { home, env: GIT_IDENTITY });
  assert.ok(m.json.results.some((r) => r.task === id && r.outcome === 'merge.done'), `merge-both 应合入：${m.stdout}`);

  const { readEvents } = await import('../../lib/events.mjs');
  const resolved = readEvents(home, { types: ['merge.resolved'] }).find((e) => e.taskId === id);
  assert.equal(resolved?.verdict, 'merge-both');
  assert.equal(
    git(repo, 'show', 'main:README.md'),
    '# toy (branch edited)\njudge-merged README.md',
    '裁决 files 全文被写盘应用',
  );
});

test('A5 L2 垃圾输出：fail-closed eject + rebase 已 abort、分支仍在、合并工作树无半态', async () => {
  const { dir, home, repo, id } = await setupCollision('schflow-ar5-', 'P-20261118-9', {
    branchEdit: (r) => fs.writeFileSync(path.join(r, 'README.md'), '# toy (branch edited)\n'),
    mainEdit: (r) => fs.writeFileSync(path.join(r, 'README.md'), '# toy (main edited)\n'),
  });
  const m = run('merge', ['--json', ...judgeArgs('judge-garbage.mjs')], { home, env: GIT_IDENTITY });
  const row = m.json.results.find((r) => r.task === id);
  assert.equal(row.outcome, 'ejected', `不可解析输出应 fail-closed eject：${m.stdout}`);
  assert.match(row.reason, /judge-escalate/, 'reason 含 judge-escalate');

  // 无半态三面：分支仍在；合并工作树 detached 干净；rebase 已 abort（无 REBASE_HEAD）
  assert.match(git(repo, 'branch', '--list', `schflow/${id}`), new RegExp(`schflow/${id}`), '分支仍在');
  const mw = path.join(dir, '.schflow-worktrees', 'toyrepo', 'merge-main');
  const status = spawnSync('git', ['-C', mw, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
  assert.equal((status.stdout || '').trim(), '', '合并工作树干净（无冲突残留半态）');
  const rebaseHead = spawnSync('git', ['-C', mw, 'rev-parse', '-q', '--verify', 'REBASE_HEAD'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(rebaseHead.status, 0, 'rebase 已 abort（REBASE_HEAD 不存在）');
  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');
  assert.equal(loadCard(findTaskDir(home, id)).status, 'blocked', '回炉受阻（人工接语义纠纷）');
});

/** 读任务目录 merge-judge/ 下全部证据文件（{name, text} 列表；无目录返回 []） */
async function readJudgeEvidence(home, id) {
  const { findTaskDir } = await import('../../lib/store.mjs');
  const dir = findTaskDir(home, id);
  const evDir = dir && path.join(dir, 'merge-judge');
  if (!evDir || !fs.existsSync(evDir)) return [];
  return fs.readdirSync(evDir).filter((f) => f.endsWith('.txt'))
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(evDir, f), 'utf8') }));
}

test('A6 L2 wsl 真机形态：警告字节+草稿 verdict 在前、终答在尾行 → 末个带 verdict 者胜 + 证据落盘（成功路）', async () => {
  const { home, repo, id } = await setupCollision('schflow-ar6-', 'P-20261118-11', {
    branchEdit: (r) => fs.writeFileSync(path.join(r, 'README.md'), '# toy (branch edited)\n'),
    mainEdit: (r) => fs.writeFileSync(path.join(r, 'README.md'), '# toy (main edited)\n'),
  });
  const m = run('merge', ['--json', ...judgeArgs('judge-wsl-noise-draft-then-final.mjs')], { home, env: GIT_IDENTITY });
  assert.ok(m.json.results.some((r) => r.task === id && r.outcome === 'merge.done'), `终答应被采纳合入：${m.stdout}`);

  const { readEvents } = await import('../../lib/events.mjs');
  const resolved = readEvents(home, { types: ['merge.resolved'] }).find((e) => e.taskId === id);
  assert.ok(resolved, 'merge.resolved 事件在');
  assert.equal(resolved.verdict, 'adopt-theirs', '应用尾行终答而非前段草稿（末个带 verdict 者胜）');
  assert.equal(git(repo, 'show', 'main:README.md'), '# toy (branch edited)', '合并结果==分支侧（终答 adopt-theirs 真应用）');

  // 证据落盘（成功路）：四段俱全——提示词全文/原始输出/stderr 摘要/结论行
  const evidence = await readJudgeEvidence(home, id);
  assert.equal(evidence.length, 1, 'merge-judge/ 恰落一份证据');
  assert.ok(evidence[0].text.includes('==== 提示词全文 ===='), '证据含提示词段');
  assert.ok(evidence[0].text.includes('==== 原始输出'), '证据含原始输出段');
  assert.ok(evidence[0].text.includes('verdict=adopt-theirs'), '结论行记终答 verdict');
  assert.match(evidence[0].name, /T\d\d-\d\d-\d\d\.\d+Z/, '文件名=含毫秒时间戳（防同秒覆盖）');
});

test('A7 L2 真实失败形态回归：reasoning 无 verdict 片段在前、终答在尾行 → 解析成功应用', async () => {
  const { home, repo, id } = await setupCollision('schflow-ar7-', 'P-20261118-11', {
    branchEdit: (r) => fs.writeFileSync(path.join(r, 'README.md'), '# toy (branch edited)\n'),
    mainEdit: (r) => fs.writeFileSync(path.join(r, 'README.md'), '# toy (main edited)\n'),
  });
  const m = run('merge', ['--json', ...judgeArgs('judge-fragment-no-verdict.mjs')], { home, env: GIT_IDENTITY });
  assert.ok(m.json.results.some((r) => r.task === id && r.outcome === 'merge.done'), `无 verdict 片段应被跳过、终答应用：${m.stdout}`);

  const { readEvents } = await import('../../lib/events.mjs');
  const resolved = readEvents(home, { types: ['merge.resolved'] }).find((e) => e.taskId === id);
  assert.equal(resolved?.verdict, 'adopt-theirs', '终答被提取应用（旧首个可解析形态会 unparseable）');
  assert.equal(git(repo, 'show', 'main:README.md'), '# toy (branch edited)', '合并结果==分支侧全文');
});

test('A8 L2 全程无合法 verdict：fail-closed eject + 证据落盘（失败路，含结论行 reason）', async () => {
  const { home, repo, id } = await setupCollision('schflow-ar8-', 'P-20261118-11', {
    branchEdit: (r) => fs.writeFileSync(path.join(r, 'README.md'), '# toy (branch edited)\n'),
    mainEdit: (r) => fs.writeFileSync(path.join(r, 'README.md'), '# toy (main edited)\n'),
  });
  const m = run('merge', ['--json', ...judgeArgs('judge-no-verdict-anywhere.mjs')], { home, env: GIT_IDENTITY });
  const row = m.json.results.find((r) => r.task === id);
  assert.equal(row.outcome, 'ejected', `有 JSON 无 verdict 应 fail-closed eject：${m.stdout}`);
  assert.match(row.reason, /judge-escalate:unparseable-output/, 'reason 精确到 unparseable-output');
  assert.match(git(repo, 'branch', '--list', `schflow/${id}`), new RegExp(`schflow/${id}`), '分支仍在（回炉面保全）');

  // 证据落盘（失败路）：原始输出段+失败结论行——unparseable 归因不再手工重造现场
  const evidence = await readJudgeEvidence(home, id);
  assert.equal(evidence.length, 1, '失败路同样落一份证据');
  assert.ok(evidence[0].text.includes('==== 原始输出'), '证据含原始输出段');
  assert.ok(evidence[0].text.includes('==== 解析结论 ===='), '证据含结论段');
  assert.ok(evidence[0].text.includes('失败 reason=unparseable-output'), '结论行记失败 reason');
  assert.ok(evidence[0].text.includes('{"step":1'), '原始输出段保留裁决器原文（审计可归因）');
});
