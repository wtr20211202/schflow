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

// git 工具面：子进程调用（args 数组、零 shell 拼接——跨平台红线）+ worktree 约定。
// worktree 布局正典：<repo 父目录>/.schflow-worktrees/<repo 名>/<id>；合并工作树 .../merge-<base>。
//
// 缓冲上限：git 工具面统一 maxBuffer=64MB（GIT_MAX_BUFFER，可经 options 覆盖）。
// merge ④ 出口扫描取 `git diff <mergeTip>^1 <mergeTip>` 的完整增量文本做 secret 扫描——安全
// 咽喉必须看全量，大变更集（数百文件/数万行）轻松超 Node 默认 1MB，旧实现会 ENOBUFS 掀翻
// 整个合并队列。超限错误单独给可读信息（明确「输出超过缓冲上限」），不得误报成 PATH 问题。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export function git(repoDir, args, { allowFail = false, maxBuffer = GIT_MAX_BUFFER } = {}) {
  const r = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer });
  if (r.error) {
    if (r.error.code === 'ENOBUFS') {
      throw new Error(`git -C ${repoDir} ${args.join(' ')} 输出超过缓冲上限（maxBuffer=${maxBuffer} 字节，ENOBUFS）——大变更集请调大 options.maxBuffer`);
    }
    throw new Error(`git 调用失败（${r.error.message}）——git 是否在 PATH？`);
  }
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git -C ${repoDir} ${args.join(' ')} 失败（${r.status}）：${(r.stderr || '').trim()}`);
  }
  return { ok: r.status === 0, code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function gitOk(repoDir, args) {
  return git(repoDir, args).stdout.trim();
}

export function isGitRepo(dir) {
  try { git(dir, ['rev-parse', '--git-dir']); return true; } catch { return false; }
}

/** repo 默认分支：origin/HEAD → 本地 HEAD（base 解析序第三跳，免注册任务缺省有源） */
export function defaultBranch(repoDir) {
  const r = git(repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (r.ok) return r.stdout.trim().replace(/^origin\//, '');
  return gitOk(repoDir, ['symbolic-ref', '--short', 'HEAD']);
}

export function worktreeRoot(repoDir) {
  return path.join(path.dirname(path.resolve(repoDir)), '.schflow-worktrees', path.basename(path.resolve(repoDir)));
}

export function taskWorktree(repoDir, id) {
  return path.join(worktreeRoot(repoDir), id);
}

export function mergeWorktree(repoDir, base) {
  return path.join(worktreeRoot(repoDir), `merge-${sanitizeName(base)}`);
}

export function sanitizeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

export function worktreeList(repoDir) {
  const out = gitOk(repoDir, ['worktree', 'list', '--porcelain']);
  const list = [];
  for (const block of out.split('\n\n')) {
    const entry = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) entry.path = line.slice(9);
      if (line.startsWith('branch ')) entry.branch = line.slice(7).replace('refs/heads/', '');
      if (line.startsWith('detached')) entry.detached = true;
    }
    if (entry.path) list.push(entry);
  }
  return list;
}

/** 建/占 worktree：已存在=复用（WIP 保全，决策 18）——复用前校验检出分支 == 期望分支：
 *  手动切分支/多 HOME 撞 id 会让提交落到别处，合并侧 already-ancestor 恢复再把它当「已合」静默归档。
 *  分支存在=挂到工作树；否则从 base 新建。
 *  残局自愈（CI 干净环境暴露）：目录在而注册不在（rm 半途）→ 清目录再建；注册在而目录不在
 *  （missing but registered）→ prune 注册再建。
 *  -f 收紧：既有分支挂接形态重试一次仍失败即抛错（附 git stderr 摘要）——-f 会让同一分支被两个
 *  工作树检出（双 checkout）；仅新建分支（-b）形态最后一次允许 -f（只影响本任务新分支）。 */
export function ensureWorktree(repoDir, wpath, branch, base) {
  const entry = worktreeList(repoDir).find((w) => path.resolve(w.path) === path.resolve(wpath));
  if (entry) {
    if (entry.branch !== branch) {
      const actual = entry.detached ? 'detached' : (entry.branch ?? '(未知)');
      throw new Error(`worktree-branch-mismatch: 期望 ${branch}，实际 ${actual}（${wpath}）`);
    }
    return { path: wpath, reused: true };
  }
  const existingBranch = git(repoDir, ['rev-parse', '--verify', `refs/heads/${branch}`], { allowFail: true }).ok;
  const addArgs = existingBranch
    ? ['worktree', 'add', wpath, branch]
    : ['worktree', 'add', '-b', branch, wpath, base];
  let r = git(repoDir, addArgs, { allowFail: true });
  if (!r.ok) {
    if (fsSyncExists(wpath)) fsRmSync(wpath);
    else git(repoDir, ['worktree', 'prune'], { allowFail: true });
    r = git(repoDir, addArgs, { allowFail: true });
    if (!r.ok && !existingBranch) {
      r = git(repoDir, [...addArgs.slice(0, 2), '-f', ...addArgs.slice(2)], { allowFail: true });
    }
    if (!r.ok) {
      throw new Error(`worktree-add-failed: ${branch} @ ${wpath}（${(r.stderr || '').trim().slice(0, 300)}）`);
    }
  }
  return { path: wpath, reused: false };
}

export function removeWorktree(repoDir, wpath, { force = false } = {}) {
  return git(repoDir, ['worktree', 'remove', ...(force ? ['--force'] : []), wpath], { allowFail: true });
}

export function branchExists(repoDir, branch) {
  return git(repoDir, ['rev-parse', '--verify', `refs/heads/${branch}`], { allowFail: true }).ok;
}

export function isAncestor(repoDir, maybeAncestor, ref) {
  return git(repoDir, ['merge-base', '--is-ancestor', maybeAncestor, ref], { allowFail: true }).ok;
}

export function statusClean(repoDir, wdir) {
  return git(wdir, ['status', '--porcelain'], { allowFail: true }).stdout.trim() === '';
}

function fsSyncExists(p) { return fs.existsSync(p); }
function fsRmSync(p) { fs.rmSync(p, { recursive: true, force: true }); }
