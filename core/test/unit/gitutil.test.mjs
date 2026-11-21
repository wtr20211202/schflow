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

// gitutil 子进程缓冲上限（P-20261120-5）：merge ④ 出口扫描取完整 diff 文本做 secret 扫描，
// 大变更集超 Node 默认 1MB 会 ENOBUFS 掀翻合并队列——git() 缺省 64MB；超限须给可读错误
// （明确「输出超过缓冲上限」，不得误报成 PATH 问题）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { git, GIT_MAX_BUFFER, ensureWorktree, worktreeList, canonKey } from '../../lib/gitutil.mjs';
import { mkToyRepo, tmpdir } from '../helpers.mjs';

test('缓冲上限常量：GIT_MAX_BUFFER = 64MB', () => {
  assert.equal(GIT_MAX_BUFFER, 64 * 1024 * 1024);
});

test('>1MB diff 真机复现：约 2MB 新增文件的 diff 全量返回不抛错（修复前必 ENOBUFS）', () => {
  const repo = mkToyRepo(tmpdir('schflow-gitutil-big-'));
  // 每行 80 字节（79 字符 + LF），26214 行 ≈ 2.0MB；末尾哨兵行证明输出未被截断在前 1MB
  const line = `${'y'.repeat(79)}\n`;
  const lineCount = 26_214;
  const sentinel = 'TAIL-SENTINEL-2MB-END';
  fs.writeFileSync(path.join(repo, 'big.txt'), line.repeat(lineCount) + `${sentinel}\n`);
  git(repo, ['add', '--', 'big.txt']);
  git(repo, ['commit', '-m', 'test: 2MB 大文件']);

  const diff = git(repo, ['diff', 'HEAD^', 'HEAD']).stdout;
  assert.ok(diff.length > 2 * 1024 * 1024, `diff 应超 2MB，实为 ${diff.length} 字节`);
  assert.ok(diff.includes(`+${sentinel}`), '尾部哨兵行必须出现在 diff 中（证明非前 1MB 截断）');
  assert.equal(diff.split('\n').filter((l) => l === `+${'y'.repeat(79)}`).length, lineCount, '新增行应逐行齐全');
});

test('ENOBUFS 分支：小 maxBuffer 抛可读错误（明示缓冲上限，不误导为 PATH 问题）', () => {
  const repo = mkToyRepo(tmpdir('schflow-gitutil-enobufs-'));
  let err = null;
  try {
    git(repo, ['log', '--oneline'], { maxBuffer: 16 });
  } catch (e) {
    err = e;
  }
  assert.ok(err, '超出 maxBuffer 必须抛错');
  assert.match(err.message, /输出超过缓冲上限/);
  assert.match(err.message, /ENOBUFS/);
  assert.ok(!err.message.includes('git 是否在 PATH'), '不得误报成 PATH 问题');
});

// P-20261121-1：复用校验（手动切分支/多 HOME 撞 id 会让提交落到别处，合并侧误判「已合」静默归档）
test('ensureWorktree 复用校验：检出分支不符（含 detached）→ worktree-branch-mismatch（含期望/实际）', () => {
  const dir = tmpdir('schflow-gitutil-reuse-');
  const repo = mkToyRepo(dir);
  const wt = path.join(dir, 'wt-reuse');
  ensureWorktree(repo, wt, 'schflow/P-20261121-1', 'main');

  git(repo, ['branch', 'other']);
  git(wt, ['checkout', 'other']);
  assert.throws(
    () => ensureWorktree(repo, wt, 'schflow/P-20261121-1', 'main'),
    (e) => e.message.startsWith('worktree-branch-mismatch')
      && e.message.includes('schflow/P-20261121-1') && e.message.includes('other') && e.message.includes(wt),
    '分支不符须抛 worktree-branch-mismatch 且带期望/实际/路径',
  );

  git(wt, ['checkout', '--detach']);
  assert.throws(
    () => ensureWorktree(repo, wt, 'schflow/P-20261121-1', 'main'),
    (e) => e.message.startsWith('worktree-branch-mismatch: 期望 schflow/P-20261121-1，实际 detached'),
    'detached 按不符处理',
  );
});

// P-20261121-1：-f 收紧——既有分支挂接失败不得用 -f 顶出第二个 checkout
test('ensureWorktree 双 checkout 拒绝：同分支已在另一工作树检出 → 抛错且不产生第二检出', () => {
  const dir = tmpdir('schflow-gitutil-dup-');
  const repo = mkToyRepo(dir);
  const wt1 = path.join(dir, 'wt-one');
  const wt2 = path.join(dir, 'wt-two');
  ensureWorktree(repo, wt1, 'schflow/P-20261121-2', 'main');

  assert.throws(
    () => ensureWorktree(repo, wt2, 'schflow/P-20261121-2', 'main'),
    /worktree-add-failed/,
    '同分支二次检出须响亮失败（-f 兜底仅限新建分支形态）',
  );
  const holdings = worktreeList(repo).filter((w) => w.branch === 'schflow/P-20261121-2');
  assert.equal(holdings.length, 1, '同分支只允许一个工作树检出');
  assert.equal(canonKey(holdings[0].path), canonKey(wt1), '唯一检出仍是首个工作树');
  assert.ok(!worktreeList(repo).some((w) => canonKey(w.path) === canonKey(wt2)), '第二工作树未注册');
});

// P-20261121-7：路径同一性（POSIX）——真实路径已注册的工作树，经符号链接路径再次 ensureWorktree
// 必须判定为同一工作树并复用（模拟 macOS /var→/private/var；CI 上短名/符号链接形态差异会让
// 字符串比较误判「未注册」→ 对已注册树 worktree add 失败）。Windows 由 8.3 短名在 CI 同键覆盖。
test('ensureWorktree 路径同一性（POSIX 符号链接）：经符号链接路径复用已注册工作树', { skip: process.platform === 'win32' && 'Windows 无符号链接场景（8.3 短名由 CI 覆盖）' }, () => {
  const dir = tmpdir('schflow-gitutil-symlink-');
  const repo = mkToyRepo(dir);
  const linkDir = path.join(dir, 'link');
  fs.symlinkSync(dir, linkDir, 'dir');
  const realWt = path.join(dir, 'wt-sym');
  const viaLink = path.join(linkDir, 'wt-sym');

  const first = ensureWorktree(repo, realWt, 'schflow/P-20261121-7', 'main');
  assert.equal(first.reused, false, '首次以真实路径创建');
  const second = ensureWorktree(repo, viaLink, 'schflow/P-20261121-7', 'main');
  assert.equal(second.reused, true, '符号链接形态与真实路径必须判定为同一工作树（不得走 worktree add）');

  const holdings = worktreeList(repo).filter((w) => w.branch === 'schflow/P-20261121-7');
  assert.equal(holdings.length, 1, '同一工作树只注册一次');
  assert.equal(canonKey(holdings[0].path), canonKey(realWt));
});
