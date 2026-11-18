#!/usr/bin/env node

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

// 八程序⑦ merge：per-(repo,base) 合并队列推进（tick 第 5 步全过程）。
// 序列：per-branch lock → 守卫（合并工作树净）→ rebase → 复验（零交集跳过）→ --no-ff 合并
//   → 出口扫描（secret-scan，§5.2 对策 7）→ 快进推送（树等价消解，ADR-0023）→ 删支 → 归档。
// 两条失败分支：复验失败=ejected（该支回炉受阻，队列继续——不队头阻塞）；推送非快进=树等价消解
//   否则挂起人工。rebase 冲突按 ejected 同族处置（本支回炉，队列继续）。secret-scan 命中/分支失踪/
//   未知谓词=挂起人工停本队列（清单见 core/README）。
// 物理机制（§8）：专用合并工作树（detached）——用户主 checkout 与合并零交互；base 恰被主 checkout
//   持有时回退现语义：主树干净守卫 + 在主树 ff-only 推进。
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveHome, paths } from '../lib/home.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { listOpenCards, loadCard, findTaskDir, transition, saveCard, archiveTask } from '../lib/store.mjs';
import { routeProfile, resolveRepo, resolveBase } from '../lib/profile.mjs';
import { readEvents, appendEvent } from '../lib/events.mjs';
import {
  git, gitOk, worktreeList, mergeWorktree, branchExists, isAncestor, removeWorktree, taskWorktree,
} from '../lib/gitutil.mjs';
import { resolveRebase } from '../lib/conflicto.mjs';
import { emit, die, EXIT } from '../lib/out.mjs';

// 出口扫描特征集（§5.2 对策 7——gitleaks 类的内置最小集；接入外部扫描器留位 Profile）
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];

const { values } = parseArgs({ options: {
  home: { type: 'string' }, json: { type: 'boolean' }, 'no-push': { type: 'boolean' },
  // judge② 裁决旗标（--judge-resolve 才启用 L2；缺省零 LLM 面——拨盘模型不变）
  'judge-resolve': { type: 'boolean' },
  'judge-runner': { type: 'string' }, // claude | dsh | custom
  'judge-runner-cmd': { type: 'string' }, // custom 的 argv JSON 数组，含 {prompt} 占位
  'judge-model': { type: 'string' },
  'judge-timeout-sec': { type: 'string' },
} });
const home = resolveHome(values.home);
const p = paths(home);
const judge = buildJudge(values); // 参数校验先于取锁——拒绝面不残留锁目录
const writeLock = acquireLock(p.writeLock);
if (!writeLock) die(EXIT.BUSY, { text: 'merge: HOME 写锁忙——稍后重试' });

const results = [];
try {
  const queues = buildQueues(home);
  for (const [key, entries] of queues) {
    const { repo, base } = entries.meta;
    const lockName = `merge-${hashOf(repo, base)}.lock`;
    const lock = acquireLock(path.join(p.locks, lockName));
    if (!lock) { results.push({ queue: key, outcome: 'lock-busy' }); continue; }
    try {
      results.push(...drainQueue(home, repo, base, entries.list, { push: !values['no-push'], judge }));
    } finally {
      lock.release();
    }
  }
} finally {
  writeLock.release();
}

emit({
  json: values.json ? { ok: true, results } : null,
  text: values.json ? '' : (results.length
    ? `merge: ${results.length} 项——\n${results.map((r) => `  - ${r.task ?? r.queue} ${r.outcome}${r.sha ? ` ${r.sha.slice(0, 10)}` : ''}${r.reason ? `（${r.reason}）` : ''}`).join('\n')}`
    : 'merge: 队列空'),
});

/** judge② 旗标组装：未加 --judge-resolve 时恒 null（零 LLM 缺省面）；custom 须给含 {prompt} 占位的 argv JSON 数组 */
function buildJudge(values) {
  if (!values['judge-resolve']) return null;
  const runner = values['judge-runner'];
  if (!['claude', 'dsh', 'custom'].includes(runner)) {
    die(EXIT.REJECT, { text: 'merge: --judge-resolve 需要 --judge-runner <claude|dsh|custom>' });
  }
  let runnerCmd = null;
  if (runner === 'custom') {
    try { runnerCmd = JSON.parse(values['judge-runner-cmd'] ?? 'null'); } catch {
      die(EXIT.REJECT, { text: 'merge: --judge-runner-cmd 须为 JSON 数组（如 ["node","judge.mjs","{prompt}"]）' });
    }
    if (!Array.isArray(runnerCmd) || !runnerCmd.length || !runnerCmd.some((a) => String(a).includes('{prompt}'))) {
      die(EXIT.REJECT, { text: 'merge: --judge-runner-cmd 须为非空 argv 数组且含 {prompt} 占位（提示词文件路径）' });
    }
  }
  return { runner, runnerCmd, model: values['judge-model'] ?? null, timeoutSec: Number(values['judge-timeout-sec'] ?? '600') };
}

/** 队列重建：事件回放（folded done 未 merge.done 的 open 任务）按 (repo,base) 分键，FIFO=folded seq */
function buildQueues(h) {
  const opens = listOpenCards(h).map(({ card }) => card).filter((c) => c.status === 'done');
  if (!opens.length) return new Map();
  const evts = readEvents(h, { types: ['folded', 'merge.done', 'merge.ejected', 'merge.failed'] });
  const foldSeq = new Map(); // id → 最近一次 folded{outcome:done} 的 seq
  const terminal = new Map(); // id → merge.done/ejected/failed 之后的 folded done 是否更晚
  for (const e of evts) {
    if (e.type === 'folded' && e.outcome === 'done') foldSeq.set(e.taskId, e.seq);
  }
  const queues = new Map();
  for (const card of opens) {
    const seq = foldSeq.get(card.id);
    if (seq === undefined) continue; // 无 folded done 事件（人工直改走 reconcile——不在本程序射程）
    const doneAfter = evts.some((e) => e.type === 'merge.done' && e.taskId === card.id && e.seq > seq);
    if (doneAfter) continue; // 已合（崩溃窗恢复：事件已落、归档未做）
    const profile = routeProfile(h, card);
    const repo = resolveRepo(card, profile);
    if (!repo) continue; // done 的非 git 任务本应已归档；异常留观
    const base = resolveBase(card, profile, repo);
    const key = `${repo}|${base}`;
    if (!queues.has(key)) queues.set(key, { meta: { repo, base }, list: [] });
    queues.get(key).list.push({ card, seq });
  }
  for (const q of queues.values()) q.list.sort((a, b) => a.seq - b.seq);
  return queues;
}

function drainQueue(home, repo, base, list, { push, judge }) {
  const out = [];
  const mw = mergeWorktree(repo, base);
  const branch = (id) => `schflow/${id}`;

  for (const { card } of list) {
    const id = card.id;

    // 幂等恢复：分支已被合入（含前次崩溃在事件前中断）
    if (!branchExists(repo, branch(id))) {
      const commit = card.result?.commit;
      if (commit && isAncestor(repo, commit, base)) {
        appendEvent(home, { type: 'merge.done', actor: 'engine', taskId: id, branch: branch(id), sha: gitOk(repo, ['rev-parse', base]), note: 'recovered-already-merged' });
        archiveTask(home, id);
        out.push({ task: id, outcome: 'merge.done', reason: 'recovered' });
        continue;
      }
      appendEvent(home, { type: 'merge.failed', actor: 'engine', taskId: id, branch: branch(id), reason: 'branch-missing' });
      out.push({ task: id, outcome: 'merge.failed', reason: 'branch-missing（挂起人工）' });
      return out; // 数据面可疑：停本队列
    }
    if (isAncestor(repo, branch(id), base)) {
      appendEvent(home, { type: 'merge.done', actor: 'engine', taskId: id, branch: branch(id), sha: gitOk(repo, ['rev-parse', base]), note: 'already-ancestor' });
      deleteBranchAndWorktree(repo, id);
      archiveTask(home, id);
      out.push({ task: id, outcome: 'merge.done', note: 'already-ancestor' });
      continue;
    }

    // 合并工作树：建/复用（detached——与任何 checkout 零互斥）
    ensureMergeWorktree(repo, mw, base);
    if (git(mw, ['status', '--porcelain'], { allowFail: true }).stdout.trim() !== '') {
      appendEvent(home, { type: 'merge.failed', actor: 'engine', taskId: id, branch: branch(id), reason: 'merge-worktree-dirty' });
      out.push({ task: id, outcome: 'merge.failed', reason: 'merge-worktree-dirty（挂起人工）' });
      return out;
    }

    const baseTip = gitOk(repo, ['rev-parse', base]);
    appendEvent(home, { type: 'merge.started', actor: 'engine', taskId: id, branch: branch(id) });

    // 零交集判定（决策 31-④）必须在 rebase 前算原始 fork——rebase 后分支必然坐在 baseTip 上，
    // 后算则谓词恒真（复验被永远跳过——实测抓出的实现伤）。
    const origTip = gitOk(repo, ['rev-parse', branch(id)]);
    const fork = gitOk(repo, ['merge-base', origTip, baseTip]);
    const zeroIntersection = fork === baseTip;

    // ① rebase：detached 检出分支尖 → resolveRebase 三级恢复链（L0 机械重试→L1 非交叠语义合并
    //    →L2 judge② 裁决，core/lib/conflicto.mjs）；三级全败=ejected 同族（本支回炉，队列继续）。
    //    成功后起的既有流程（分支推进/复验/合并/出口扫描/推送）一字不动——复验链是 L1/L2 的语义兜底。
    git(mw, ['checkout', '--detach', branch(id)]);
    const reb = resolveRebase({ home, repo, mw, baseTip, card, judge });
    if (!reb.ok) {
      git(mw, ['rebase', '--abort'], { allowFail: true });
      git(mw, ['checkout', '--detach', baseTip], { allowFail: true });
      eject(home, id, `rebase-conflict:${reb.reason ?? 'unknown'}`, out);
      continue;
    }
    const rebasedTip = gitOk(mw, ['rev-parse', 'HEAD']);
    // 分支推进到 rebase 后尖端（分支此刻不在任何工作树检出——fold 已移除执行工作树）
    const wtHeld = worktreeList(repo).find((w) => w.branch === branch(id));
    if (wtHeld) removeWorktree(repo, wtHeld.path, { force: true });
    git(repo, ['branch', '-f', branch(id), rebasedTip]);

    // ② 复验：零交集跳过（base 自分叉零增量——执行器折前已按同基自检）；否则跑 Profile 链
    if (zeroIntersection) {
      appendEvent(home, { type: 'verify.run', actor: 'engine', taskId: id, cmd: '(skipped: zero-intersection)', exitCode: 0 });
    } else {
      const profile = routeProfile(home, card);
      const verdict = runVerifyChain(home, id, profile?.verify ?? [], mw, card);
      if (!verdict.ok) {
        git(mw, ['checkout', '--detach', baseTip], { allowFail: true });
        appendEvent(home, { type: 'verify.run', actor: 'engine', taskId: id, cmd: verdict.cmd, exitCode: verdict.code });
        eject(home, id, `verify-failed:${verdict.cmd}`.slice(0, 200), out);
        continue;
      }
    }

    // ③ --no-ff 合并（在 detached baseTip 之上）
    git(mw, ['checkout', '--detach', baseTip]);
    const mg = git(mw, ['merge', '--no-ff', branch(id), '-m', `merge: ${card.title} (${id})`], { allowFail: true });
    if (!mg.ok) {
      git(mw, ['merge', '--abort'], { allowFail: true });
      git(mw, ['checkout', '--detach', baseTip], { allowFail: true });
      appendEvent(home, { type: 'merge.failed', actor: 'engine', taskId: id, branch: branch(id), reason: 'merge-conflict' });
      out.push({ task: id, outcome: 'merge.failed', reason: 'merge-conflict（挂起人工）' });
      return out;
    }
    const mergeTip = gitOk(mw, ['rev-parse', 'HEAD']);

    // ④ 出口扫描：合并提交对第一父的增量 diff（推送主体唯一=最便宜的单点防御咽喉）
    const diff = gitOk(mw, ['diff', `${mergeTip}^1`, mergeTip]);
    const hit = secretScan(diff);
    if (hit) {
      git(mw, ['checkout', '--detach', baseTip]); // 撤销合并
      transition(home, id, 'blocked', { extra: { reason: 'secret-scan' } });
      appendEvent(home, { type: 'merge.failed', actor: 'engine', taskId: id, branch: branch(id), reason: 'secret-scan', detail: hit });
      out.push({ task: id, outcome: 'merge.failed', reason: `secret-scan: ${hit}（挂起人工）` });
      return out; // 严重项停队列
    }

    // ⑤ base 推进：不被任何工作树持有 → update-ref（带旧值校验）；被主 checkout 持有 → 主树干净守卫 + 主树 ff-only
    const holder = worktreeList(repo).find((w) => w.branch === base);
    if (holder) {
      if (git(holder.path, ['status', '--porcelain'], { allowFail: true }).stdout.trim() !== '') {
        appendEvent(home, { type: 'merge.failed', actor: 'engine', taskId: id, branch: branch(id), reason: 'main-tree-dirty' });
        out.push({ task: id, outcome: 'merge.failed', reason: 'base 被 checkout 且主树脏（挂起人工）' });
        return out;
      }
      const ffr = git(holder.path, ['merge', '--ff-only', mergeTip], { allowFail: true });
      if (!ffr.ok) {
        appendEvent(home, { type: 'merge.failed', actor: 'engine', taskId: id, branch: branch(id), reason: 'main-tree-ff-failed' });
        out.push({ task: id, outcome: 'merge.failed', reason: '主树 ff-only 失败（挂起人工）' });
        return out;
      }
    } else {
      git(repo, ['update-ref', `refs/heads/${base}`, mergeTip, baseTip]); // 旧值不符=并发改动，失败即重跑
    }

    // ⑥ 推送（快进-only；鉴权全下放 git credential——引擎零凭据）。
    //    推送失败=停本队列（挂起人工）：不删支、不归档、不写 merge.done——「远端已包含合并提交」
    //    才算合入（J1-P1：pushBase 结果必须参与出口判定，否则制造假 done + 丢可恢复分支）。
    if (push) {
      const pr = pushBase(home, repo, base, id, branch(id), mergeTip);
      out.push(...pr.results);
      if (!pr.ok) return out;
    } else {
      appendEvent(home, { type: 'note.appended', actor: 'engine', taskId: id, note: 'push skipped (--no-push)' });
    }

    // ⑦ 删支（-d 安全阀：未合入拒绝删）+ 归档
    deleteBranchAndWorktree(repo, id);
    appendEvent(home, { type: 'merge.done', actor: 'engine', taskId: id, branch: branch(id), sha: mergeTip });
    archiveTask(home, id);
    out.push({ task: id, outcome: 'merge.done', sha: mergeTip });
  }
  return out;
}

function eject(home, id, reason, out) {
  transition(home, id, 'blocked', { extra: { reason: reason.slice(0, 200) } });
  appendEvent(home, { type: 'merge.ejected', actor: 'engine', taskId: id, branch: `schflow/${id}`, reason: reason.slice(0, 200) });
  out.push({ task: id, outcome: 'ejected', reason });
}

function ensureMergeWorktree(repo, mw, base) {
  if (worktreeList(repo).some((w) => path.resolve(w.path) === path.resolve(mw))) return;
  // 残局自愈（崩溃/半途失败后的三种形态都要接住——CI 干净环境首次暴露）：
  // ① 目录在、注册不在（rm 半途）→ 清目录再建；② 目录不在、注册在（missing but registered）
  // → prune 注册再建；③ 两者都在但 add 仍拒 → add -f 覆盖。合并工作树是引擎私有的临时面，
  // prune/-f 只影响 merge-<base> 一个路径，不触碰用户工作树。
  if (fs.existsSync(mw)) fs.rmSync(mw, { recursive: true, force: true });
  git(repo, ['worktree', 'prune'], { allowFail: true });
  const add = git(repo, ['worktree', 'add', '--detach', mw, base], { allowFail: true });
  if (!add.ok) git(repo, ['worktree', 'add', '--detach', '-f', mw, base]);
}

function runVerifyChain(home, id, chain, cwd, card) {
  for (const step of chain ?? []) {
    const when = step.when ?? 'always';
    if (when === 'specs-nonempty' && !(card.result?.specs?.length)) continue;
    if (!['always', 'specs-nonempty'].includes(when)) {
      return { ok: false, cmd: `(unknown-predicate:${when})`, code: -1, fatal: true };
    }
    const r = spawnSync(step.cmd, { encoding: 'utf8', shell: true, cwd, windowsHide: true });
    appendEvent(home, { type: 'verify.run', actor: 'engine', taskId: id, cmd: step.cmd, exitCode: r.status });
    if (r.status !== 0) return { ok: false, cmd: step.cmd, code: r.status };
  }
  return { ok: true };
}

function pushBase(home, repo, base, id, branchName, mergeTip) {
  const out = [];
  const ok = (v) => ({ ok: v, results: out });
  const hasOrigin = git(repo, ['remote', 'get-url', 'origin'], { allowFail: true }).ok;
  if (!hasOrigin) {
    appendEvent(home, { type: 'note.appended', actor: 'engine', taskId: id, note: 'push skipped: no origin remote' });
    out.push({ task: id, outcome: 'note', reason: 'push skipped（无 origin）' });
    return ok(true);
  }
  git(repo, ['fetch', 'origin', base], { allowFail: true });
  const remoteRef = `refs/remotes/origin/${base}`;
  const remoteExists = git(repo, ['rev-parse', '--verify', remoteRef], { allowFail: true }).ok;
  if (remoteExists) {
    const remoteTip = gitOk(repo, ['rev-parse', remoteRef]);
    if (!isAncestor(repo, remoteTip, mergeTip)) {
      // 非快进：树等价消解（同父+树一致→对齐远端零损失，ADR-0023）；否则挂起人工
      const sameParent = gitOk(repo, ['rev-parse', `${mergeTip}^`]) === gitOk(repo, ['rev-parse', `${remoteTip}^`]);
      const sameTree = gitOk(repo, ['rev-parse', `${mergeTip}^{tree}`]) === gitOk(repo, ['rev-parse', `${remoteTip}^{tree}`]);
      if (sameParent && sameTree) {
        git(repo, ['update-ref', `refs/heads/${base}`, remoteTip]);
        appendEvent(home, { type: 'note.appended', actor: 'engine', taskId: id, note: 'non-ff resolved: tree-equivalent aligned to remote' });
        out.push({ task: id, outcome: 'note', reason: '树等价对齐远端' });
        return ok(true);
      }
      appendEvent(home, { type: 'merge.failed', actor: 'engine', taskId: id, branch: branchName, reason: 'push-non-ff' });
      out.push({ task: id, outcome: 'merge.failed', reason: '推送非快进且非树等价（挂起人工，本地已推进、分支保留）' });
      return ok(false);
    }
  }
  const pr = git(repo, ['push', 'origin', `refs/heads/${base}:refs/heads/${base}`], { allowFail: true });
  if (!pr.ok) {
    appendEvent(home, { type: 'merge.failed', actor: 'engine', taskId: id, branch: branchName, reason: `push-failed:${(pr.stderr || '').trim().slice(0, 200)}` });
    out.push({ task: id, outcome: 'merge.failed', reason: 'push 失败（挂起人工，本地已推进、分支保留）' });
    return ok(false);
  }
  return ok(true);
}

function deleteBranchAndWorktree(repo, id) {
  const wt = taskWorktree(repo, id);
  if (worktreeList(repo).some((w) => path.resolve(w.path) === path.resolve(wt))) {
    removeWorktree(repo, wt, { force: true });
  }
  git(repo, ['branch', '-d', `schflow/${id}`], { allowFail: true }); // -d 安全阀：未合入拒删
}

function secretScan(diffText) {
  for (const re of SECRET_PATTERNS) {
    const m = diffText.match(re);
    if (m) return `${re.source.slice(0, 40)}… "${m[0].slice(0, 12)}…"`;
  }
  return null;
}

function hashOf(repo, base) {
  return createHash('sha1').update(`${repo}|${base}`).digest('hex').slice(0, 12);
}
