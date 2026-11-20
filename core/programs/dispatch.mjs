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

// 八程序⑤ dispatch：补位派发（tick 第 4 步的程序化身）。
// 可派 = 已批准 + 依赖解除 + env 租约已获（取不到=跳过该候选，暂缓原因 env-wait——不队头饿死）；
// 多候选循环派发至槽满（满并行纪律+可调并发——清单⑦）。槽满有候选未派=exit 1（报告照出）；
// 白名单拒绝=exit 76。逻辑冲突治理=judge①（拨盘左由 orchestrator 出结论，程序不越权）；
// --plan=只读候选预演（judge①/⑥ 派发前裁决的结构化输入：与真实派发共用同一评估器，同序同原因，
//  全程零状态变更零事件——不取写锁/不回收租约/不建 worktree/不取租约/不翻转，恒 exit 0）。
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { resolveHome, paths } from '../lib/home.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { atomicWriteJson } from '../lib/atomic.mjs';
import { listOpenCards, findTaskDir, transition, saveCard, loadCard } from '../lib/store.mjs';
import { routeProfile, resolveRepo, resolveBase, gitTrackOf, resolveMounts, checkMountWhitelist } from '../lib/profile.mjs';
import { loadEnvPool, matchEnvs, acquireLease, sweepOrphanLeases, readLeases, leaseAvailable } from '../lib/envpool.mjs';
import { ensureWorktree, taskWorktree } from '../lib/gitutil.mjs';
import { buildTaskBook } from '../lib/taskbook.mjs';
import { buildLauncher, spawnExecutor, resolvePromptVersion } from '../lib/runner.mjs';
import { appendEvent } from '../lib/events.mjs';
import { emit, die, EXIT } from '../lib/out.mjs';

const { values } = parseArgs({
  options: {
    home: { type: 'string' }, json: { type: 'boolean' },
    task: { type: 'string' }, auto: { type: 'boolean' }, plan: { type: 'boolean' },
    runner: { type: 'string' }, 'runner-cmd': { type: 'string' }, model: { type: 'string' },    'fake-mode': { type: 'string' }, concurrency: { type: 'string' },
    'no-spawn': { type: 'boolean' }, launcher: { type: 'string' },
    retry: { type: 'string' }, 'max-attempts': { type: 'string' },
  },
});
if (values.plan && values.retry) die(EXIT.MISSING, { text: 'dispatch --plan 与 --retry 互斥（retry 回炉 approved 是状态变更；预演只读不回炉）' });
if (!values.task && !values.auto && !values.retry && !values.plan) die(EXIT.MISSING, { text: '用法: dispatch.mjs --task <id> | --auto [--runner fake|claude|dsh|custom] [--fake-mode done|blocked|…] [--concurrency N] [--no-spawn（宿主原生家族：只记账，执行器由宿主 subagent 派生）] | --plan（只读预演：候选过滤+依赖核对+租约匹配+槽位检查后不派发）\n  custom 的 runner-cmd 在 Profile 里可写 argv 数组（推荐，零 shell），如 ["node", "hosts/dsh/launcher/wsl-dsh.mjs", "{book}"]' });

const home = resolveHome(values.home);
const p = paths(home);
const planMode = !!values.plan;
// --plan 只读预演：不取 HOME 写锁（取锁/写 holder 是状态面动作）——并发 tick 在跑也可安全窥视（advisory only）
const lock = planMode ? null : acquireLock(p.writeLock);
if (!planMode && !lock) die(EXIT.BUSY, { text: 'dispatch: HOME 写锁忙——稍后重试' });

const dispatched = [];
const deferred = [];
let planReport = null;
try {
  const opens = listOpenCards(home);
  const byId = new Map(opens.map(({ card }) => [card.id, card]));
  const pool = readPool(home);

  // 孤儿租约回收（TTL 2h / 任务不在 running——兜底，与 fold 释放双保险）；--plan 只读预演不回收（写租约=状态变更）
  if (!planMode) sweepOrphanLeases(home, { isRunning: (id) => byId.get(id)?.status === 'running' });

  // --retry <id>：env-retry 受阻的原子重派（judge③ 结论的可执行化——R2 generator 指认的断链）。
  // 仅当 status=blocked ∧ triage=env-retry ∧ attempts<上限；否则 exit 76 给可行动说明。
  if (values.retry) {
    const rid = values.retry;
    const dir = findTaskDir(home, rid);
    if (!dir) die(EXIT.FAIL, { text: `dispatch --retry: 任务 ${rid} 不存在` });
    const card = loadCard(dir);
    if (card.status !== 'blocked') die(EXIT.REJECT, { text: `--retry 仅适用于 blocked 任务（${rid} 是 ${card.status}）` });
    if (card.triage !== 'env-retry') die(EXIT.REJECT, { text: `--retry 仅适用于 env-retry 档（${rid} 分诊=${card.triage ?? '未分诊'}）——${card.triage === 'dep-wait' ? '等外部条件具备后人工回炉' : '需人工裁决（decide 面）'}` });
    const maxAttempts = Number(values['max-attempts'] ?? 10);
    if ((card.attempts ?? 0) >= maxAttempts) die(EXIT.REJECT, { text: `--retry 超过重派上限（attempts=${card.attempts} ≥ ${maxAttempts}）——转人工` });
    transition(home, rid, 'approved', { actor: 'engine', extra: { reason: `retry:${card.triage}` } });
    console.error(`retry: ${rid} 已回炉 approved（attempts=${card.attempts}/${maxAttempts}），继续派发`);
    values.task = rid; // 复用显式单发路径
    // 回炉改变了 status——byId 是回炉前快照，必须重建，否则候选过滤仍看到 blocked
    const refreshed = listOpenCards(home);
    byId.clear();
    for (const { card: rc } of refreshed) byId.set(rc.id, rc);
  }

  // 候选：显式 --task 或 approved 全体（优先级档 → FIFO）；--plan 预演同一候选集（同序）
  const PRIO_RANK = { highest: 0, high: 1, medium: 2, low: 3 };
  let candidates;
  if (values.task) {
    const card = byId.get(values.task);
    if (!card) die(EXIT.FAIL, { text: `dispatch: 任务 ${values.task} 不在 open 区` });
    candidates = [card];
  } else {
    candidates = opens.map(({ card }) => card).filter((c) => c.status === 'approved')
      .sort((a, b) => (PRIO_RANK[a.priority] - PRIO_RANK[b.priority]) || String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
  }

  // --plan：只读候选预演（judge①/⑥ 派发前裁决的结构化输入）——与真实派发共用同一评估器（同序同原因），
  // 输出每候选 将派发/暂缓+原因；advisory only——不预留租约/槽位/worktree，真实派发时重新评估
  if (planMode) {
    planReport = {
      plan: candidates.map((card) => {
        const ev = evaluateCandidate(card, { home, byId, pool, concurrencyHint: values.concurrency });
        return ev.defer
          ? { id: card.id, wouldDispatch: false, reason: ev.reason, ...(ev.detail ? { detail: ev.detail } : {}) }
          : { id: card.id, wouldDispatch: true, reason: null };
      }),
      at: new Date().toISOString(),
      home,
    };
  } else for (const card of candidates) {
    if (dispatched.length && !values.auto && values.task) break; // 显式单发
    const defer = (reason, detail) => deferred.push({ id: card.id, reason, ...(detail ? { detail } : {}) });

    // 前置评估（与 --plan 共用同一份——防双实现漂移）；副作用自此步之后才开始
    const ev = evaluateCandidate(card, { home, byId, pool, concurrencyHint: values.concurrency });
    if (ev.defer) { defer(ev.reason, ev.detail); continue; }
    const { profile, scope, repo, gitTrack, base, envDef } = ev.info;

    // worktree（git 轨道）：评估已过 repo/base 只读校验，此处才建（WIP 保全/分支挂载是副作用）；失败原因码不变
    let worktree = null, branch = null;
    if (gitTrack) {
      branch = `schflow/${card.id}`;
      worktree = taskWorktree(repo, card.id);
      try {
        ensureWorktree(repo, worktree, branch, base);
      } catch (e) {
        defer('worktree-failed', e.message.slice(0, 200)); continue;
      }
    }

    // env 租约：声明即必经（v1.0.10）；评估只匹配不占位——acquire 在真实路径此步执行；
    // 取不到=跳过（env-wait），不阻塞后续候选
    let lease = null;
    if (card.env) {
      try {
        const r = acquireLease(home, envDef, { taskId: card.id, runNo: card.attempts + 1 });
        if (!r.ok) {
          if (r.reason === 'setup-failed') {
            transition(home, card.id, 'blocked', { extra: { reason: 'env-setup-failed', detail: r.detail } });
            deferred.push({ id: card.id, reason: 'env-setup-failed→blocked' });
          } else defer('env-wait', envDef.name);
          continue;
        }
        lease = { name: envDef.name, ref: envDef.ref ?? null };
      } catch (e) {
        defer('env-error', e.message.slice(0, 200)); continue;
      }
    }

    // 挂载面：解析（版本 pin 审计）+ 白名单（登记制存在即强制）
    let mounts = [];
    try { mounts = resolveMounts(profile, home); } catch (e) { defer('mount-missing', e.message.slice(0, 200)); continue; }
    const denied = checkMountWhitelist(home, mounts);
    if (denied) {
      die(EXIT.REJECT, {
        json: values.json ? { ok: false, deniedMounts: denied } : null,
        text: `dispatch: 挂载白名单拒绝——${denied.map((m) => m.path).join(', ')}（state/mount-whitelist.txt 登记制）`,
      });
    }

    // 取号本轮尝试：attempts 在派发时递增（runNo=attempts；interrupted 折叠不再另加——见 core/README）
    const runNo = card.attempts + 1;
    const taskDir = findTaskDir(home, card.id);
    const runDir = path.join(taskDir, 'runs', String(runNo));
    fs.mkdirSync(runDir, { recursive: true });

    const runner = values.runner ?? profile?.runner ?? null;
    const runnerCmd = values['runner-cmd'] ?? profile?.['runner-cmd'] ?? null;
    if (!runner && !values['no-spawn']) { defer('runner-unconfigured', 'Profile runner 或 --runner 二选一（防误用：无静默缺省；原生家族用 --no-spawn）'); continue; }

    const promptVersion = resolvePromptVersion('executor');
    const bookPath = path.join(runDir, 'task-book.md');
    const prevRuns = runNo > 1 ? Array.from({ length: runNo - 1 }, (_, i) => i + 1) : [];
    fs.writeFileSync(bookPath, buildTaskBook({
      card, taskDir, runNo, runDir, worktree, base, lease, promptVersion, prevRuns,
    }));

    // 状态翻转（唯一出口）先于 spawn：spawn 失败留 running 无池记录 → fold 折 interrupted 自愈
    card.attempts = runNo;
    card.branch = branch ?? card.branch ?? null;
    card.status = 'running';
    saveCard(taskDir, card);
    appendEvent(home, { type: 'status.changed', actor: 'engine', taskId: card.id, from: 'approved', to: 'running', runNo });

    try {
      const isNative = !!values['no-spawn']; // 宿主原生家族：记账在此，派生在宿主 subagent（v1.0.2/03 两家族）
      const launcher = isNative
        ? { launcher: values.launcher ?? 'host-native', cli: values.launcher ?? 'host-native' }
        : buildLauncher({ runner, runnerCmd, model: values.model ?? profile?.['model-pool']?.[0], bookPath, cwd: worktree ?? taskDir, repo });
      const env = {
        SCHFLOW_TASK_ID: card.id, SCHFLOW_RUN_NO: String(runNo), SCHFLOW_RUN_DIR: runDir,
        SCHFLOW_TASK_DIR: taskDir, SCHFLOW_WORKTREE: worktree ?? '', SCHFLOW_BASE: base ?? '',
        ...(repo ? { SCHFLOW_REPO: repo } : {}),
        ...(lease ? { SCHFLOW_LEASE_ENV: lease.name, ...(lease.ref ? { SCHFLOW_LEASE_REF: String(lease.ref) } : {}) } : {}),
        ...(runner === 'fake' ? { SCHFLOW_FAKE_MODE: values['fake-mode'] ?? 'done' } : {}),
      };
      const pid = isNative ? null : spawnExecutor({ launcher, runDir, env });
      pool.inFlight.push({
        taskId: card.id, runNo, pid, family: isNative ? 'native' : 'subprocess', launcher: launcher.launcher, cli: launcher.cli,
        worktree: worktree ?? null, branch: branch ?? null, env: lease?.name ?? null, scope,
        startedAt: new Date().toISOString(),
      });
      atomicWriteJson(p.pool, pool);
      appendEvent(home, {
        type: 'dispatched', actor: 'engine', taskId: card.id, runNo,
        family: isNative ? 'native' : 'subprocess', launcher: launcher.launcher, cli: launcher.cli,
        model: values.model ?? profile?.['model-pool']?.[0] ?? null,
        mounts, worktree: worktree ?? null, branch: branch ?? null, promptVersion,
      });
      dispatched.push({
        id: card.id, runNo, pid, family: isNative ? 'native' : 'subprocess',
        taskBook: bookPath, worktree: worktree ?? null, branch: branch ?? null, env: lease?.name ?? null,
      });
    } catch (e) {
      deferred.push({ id: card.id, reason: 'spawn-failed', detail: e.message.slice(0, 200) });
    }
  }
} finally {
  if (lock) lock.release();
}

if (planMode) {
  emit({ json: values.json ? planReport : null, text: values.json ? '' : formatPlan(planReport) });
  // 预演恒 0：暂缓≠业务失败（advisory，不触发队列报告义务的 exit 1 面——参数非法才非 0）
  process.exit(EXIT.OK);
}

const report = { dispatched, deferred, at: new Date().toISOString(), home };
emit({
  json: values.json ? report : null,
  text: values.json ? '' : formatReport(report),
});
// 队列报告义务（ADR-0025③）：有候选未派发（槽满/等租约）≠ 成功占满——exit 1 让 tick 侧可感知
process.exit(dispatched.length === 0 && deferred.length > 0 ? EXIT.FAIL : EXIT.OK);

function readPool(home) {
  const f = paths(home).pool;
  if (!fs.existsSync(f)) return { inFlight: [] };
  const pool = JSON.parse(fs.readFileSync(f, 'utf8'));
  // 只丢弃缺标识的畸形条目；pid=null 的原生家族条目是合法状态（J1-P2：按 pid 过滤会把它丢掉，
  //  二次派发后在途记录消失→永久 running 僵尸+槽位/租约泄漏）
  pool.inFlight = (pool.inFlight ?? []).filter((e) => e.taskId && e.runNo);
  return pool;
}

function entryScope(e) { return e.scope ?? '(global)'; }

/** 依赖状态解析（严格只读）：open 面（byId）→ 归档面（done/<月>，findTaskDir 已覆盖）→ unknown。
 *  归档回退只做 findTaskDir/loadCard，不写卡、不动 byId 的其它用途（sweep/--retry/--task 候选）。 */
function depStatus(home, byId, id) {
  const open = byId.get(id);
  if (open) return open.status ?? 'unknown';
  const dir = findTaskDir(home, id);
  if (!dir) return 'unknown';
  try {
    return loadCard(dir).status ?? 'unknown';
  } catch {
    return 'unknown'; // 损坏卡=状态不可判定（真未知，不阻断其它候选）
  }
}

/** 候选前置评估——--plan 预演与真实派发共用同一份（同源同序同原因，防双实现漂移）。
 *  全程只读：不建 worktree/不取租约/不翻转状态/不落事件。评估序 = 真实派发的暂缓原因序：
 *  status → deps → slots → repo/base（只读解析）→ env 匹配+可得性预判。
 *  返回 { defer: true, reason, detail? } 或 { defer: false, info: { profile, scope, repo, gitTrack, base, envDef } }。 */
function evaluateCandidate(card, { home, byId, pool, concurrencyHint }) {
  const no = (reason, detail) => ({ defer: true, reason, ...(detail ? { detail } : {}) });

  if (card.status !== 'approved') return no(card.status === 'running' ? 'already-running' : `status-${card.status}`);

  // 依赖：目标已终结（done/stale/rejected）即解除。
  // 解析口径：open 面（byId）→ 未命中回退归档面（done/<月>，findTaskDir 覆盖）→ 仍无=unknown。
  // 终态任务 fold 即归档，只查 open 会把「已完成依赖」永久判 unknown（语义反了）；回退严格只读。
  const deps = card.dependsOn ?? [];
  const depStates = deps.map((d) => depStatus(home, byId, d));
  if (depStates.some((s) => s === 'unknown')) return no('deps-unknown');
  if (!depStates.every((s) => ['done', 'stale', 'rejected'].includes(s))) return no('deps-pending', depStates.join(','));

  // 槽位（并发可调；无项目任务吃 HOME 级全局池，互不挤占）
  const profile = routeProfile(home, card);
  const scope = card.project ?? '(global)';
  const cap = Number(concurrencyHint ?? profile?.concurrency ?? 2);
  const used = pool.inFlight.filter((e) => (entryScope(e) === scope)).length;
  if (used >= cap) return no('slots-full', `${scope} ${used}/${cap}`);

  // 仓库/base 解析（git 轨道任务；resolveBase 只读——真建 worktree 在真实派发路径）
  const repo = resolveRepo(card, profile);
  const gitTrack = gitTrackOf(card, repo);
  if (gitTrack && !repo) return no('repo-missing', 'code/fix/chore 需要 task.repo 或 project.repo');
  let base = null;
  if (gitTrack) {
    try {
      base = resolveBase(card, profile, repo);
    } catch (e) {
      return no('worktree-failed', e.message.slice(0, 200));
    }
  }

  // env 租约：匹配 + 可得性预判（leaseAvailable 与 acquireLease 同源口径）；
  // setup 钩子成败不可预演（advisory 边界）——真实派发时由 acquireLease 重新裁决
  let envDef = null;
  if (card.env) {
    try {
      const envs = loadEnvPool(home, card.project ?? null);
      const leases = readLeases(home);
      const cands = matchEnvs(envs, leases, card.env);
      if (!cands.length) return no('env-none-matched', String(card.env));
      envDef = cands[0];
      if (!leaseAvailable(leases, envDef)) return no('env-wait', envDef.name);
    } catch (e) {
      return no('env-error', e.message.slice(0, 200));
    }
  }

  return { defer: false, info: { profile, scope, repo, gitTrack, base, envDef } };
}

function formatPlan(r) {
  const L = [`dispatch --plan：候选 ${r.plan.length}（只读预演 advisory——不预留，真实派发重新评估）`];
  for (const c of r.plan) {
    L.push(c.wouldDispatch ? `  + ${c.id} 将派发` : `  - ${c.id} 暂缓 ${c.reason}${c.detail ? `（${c.detail}）` : ''}`);
  }
  return L.join('\n');
}

function formatReport(r) {
  const L = [];
  if (r.dispatched.length) {
    L.push(`dispatch: 派发 ${r.dispatched.length}——`);
    for (const d of r.dispatched) L.push(`  + ${d.id} runNo=${d.runNo} pid=${d.pid}${d.branch ? ` ${d.branch}` : ''}${d.env ? ` env=${d.env}` : ''}`);
  } else L.push('dispatch: 本轮无派发');
  if (r.deferred.length) {
    L.push(`暂缓 ${r.deferred.length}（原因必报）——`);
    for (const d of r.deferred) L.push(`  - ${d.id} ${d.reason}${d.detail ? `（${d.detail}）` : ''}`);
  }
  return L.join('\n');
}
