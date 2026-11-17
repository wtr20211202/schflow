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

// 八程序⑥ fold：折叠在途（tick 第 3 步的程序化身）。
// 活性判定=落盘面证据：result.json 在→按契约四态收编；不在→pid 活=仍在跑 / pid 死=interrupted
// （attempts 已在派发时计——interrupted 折叠不再另加）。解析失败=interrupted 重派（契约底线④：
// 重派任务书自动附前次 runs/ 引用——由 dispatch 组装）。折 done/interrupted/blocked 即释放其租约。
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { resolveHome, paths } from '../lib/home.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { atomicWriteJson } from '../lib/atomic.mjs';
import { findTaskDir, loadCard, saveCard, transition, archiveTask } from '../lib/store.mjs';
import { routeProfile, resolveRepo, gitTrackOf } from '../lib/profile.mjs';
import { releaseAllForTask } from '../lib/envpool.mjs';
import { validateResult } from '../lib/result.mjs';
import { triageBlocked } from '../lib/triage.mjs';
import { pidAlive } from '../lib/runner.mjs';
import { removeWorktree, taskWorktree } from '../lib/gitutil.mjs';
import { appendEvent } from '../lib/events.mjs';
import { emit, EXIT } from '../lib/out.mjs';

const { values } = parseArgs({
  options: {
    home: { type: 'string' }, json: { type: 'boolean' },
    'native-timeout-min': { type: 'string' }, // 原生家族（无 pid）条目超时判定，默认 120min（与租约 TTL 同口径）
    force: { type: 'string' },                // 人工强制折叠指定任务（配额墙/宿主中断等无活性信号的场景）
  },
});
const home = resolveHome(values.home);
const p = paths(home);
const nativeTimeoutMs = Number(values['native-timeout-min'] ?? '120') * 60_000;
const lock = acquireLock(p.writeLock);
if (!lock) { emit({ json: values.json ? { ok: false, error: 'lock-busy' } : null, text: 'fold: HOME 写锁忙——稍后重试' }); process.exit(EXIT.BUSY); }

const outcomes = [];
try {
  const poolPath = p.pool;
  const pool = fs.existsSync(poolPath) ? JSON.parse(fs.readFileSync(poolPath, 'utf8')) : { inFlight: [] };
  const remaining = [];

  for (const entry of pool.inFlight ?? []) {
    const taskDir = findTaskDir(home, entry.taskId);
    if (!taskDir) { outcomes.push({ id: entry.taskId, outcome: 'pool-dropped', reason: 'task-not-found' }); continue; }
    const card = loadCard(taskDir);
    const runDir = path.join(taskDir, 'runs', String(entry.runNo));
    const resultFile = path.join(runDir, 'result.json');
    const gitTrack = gitTrackOf(card, resolveRepo(card, routeProfile(home, card)));
    const forced = values.force === entry.taskId;

    if (card.status !== 'running') {
      // 状态已被旁路翻转（人工干预/前次崩溃残留）——只清池记录+兜底释放租约
      releaseAllForTask(home, entry.taskId, { reason: 'not-running' });
      outcomes.push({ id: entry.taskId, outcome: 'pool-dropped', reason: `status=${card.status}` });
      continue;
    }

    if (fs.existsSync(resultFile)) {
      let result = null;
      let violations = [];
      try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { violations = ['result-unparsable']; }
      if (result) violations = validateResult(result, { gitTrack });

      if (violations.length) {
        // 契约底线④：解析失败=interrupted 重派（附前次产物引用由 dispatch 负责）
        releaseAllForTask(home, entry.taskId, { reason: 'fold' });
        transition(home, card.id, 'approved');
        appendEvent(home, { type: 'folded', actor: 'engine', taskId: card.id, runNo: entry.runNo, outcome: 'interrupted', reason: violations.join(';').slice(0, 300) });
        outcomes.push({ id: card.id, outcome: 'interrupted', reason: 'result-invalid' });
        continue;
      }

      releaseAllForTask(home, entry.taskId, { reason: 'fold' });
      if (result.status === 'done') {
        card.result = result;
        saveCard(taskDir, card);
        transition(home, card.id, 'done', { extra: { commit: result.commit ?? null } });
        appendEvent(home, { type: 'folded', actor: 'engine', taskId: card.id, runNo: entry.runNo, outcome: 'done', commit: result.commit ?? null });
        if (gitTrack && entry.worktree) {
          const repo = resolveRepo(card, routeProfile(home, card));
          if (repo) removeWorktree(repo, entry.worktree, { force: false }); // done=已提交，净移除；失败不阻塞（merge 兜底可重建）
        }
        if (!gitTrack) archiveTask(home, card.id); // 非 git 任务：done 即终态归档
        outcomes.push({ id: card.id, outcome: 'done' });
      } else if (result.status === 'blocked') {
        const t = triageBlocked(result); // judge③ 受阻分诊（M3：程序化判定，结论可审计）
        card.result = result;
        card.triage = t.triage; // 分诊结论落卡（单一事实源，orchestrator 直接消费）
        saveCard(taskDir, card);
        transition(home, card.id, 'blocked', { extra: { reason: result.summary.slice(0, 200), triage: t.triage } });
        appendEvent(home, { type: 'folded', actor: 'engine', taskId: card.id, runNo: entry.runNo, outcome: 'blocked', triage: t.triage, triageSignals: t.signals, triageHint: t.hint });
        outcomes.push({ id: card.id, outcome: 'blocked', triage: t.triage, hint: t.hint });
      } else if (result.status === 'stale') {
        card.result = result;
        saveCard(taskDir, card);
        transition(home, card.id, 'stale', { extra: { reason: result.summary.slice(0, 200) } });
        appendEvent(home, { type: 'folded', actor: 'engine', taskId: card.id, runNo: entry.runNo, outcome: 'stale' });
        outcomes.push({ id: card.id, outcome: 'stale' });
      } else { // dirty：工作树有非预期未提交改动——置受阻（人工清场），WIP 保全不动工作树
        card.result = result;
        saveCard(taskDir, card);
        transition(home, card.id, 'blocked', { extra: { reason: 'dirty' } });
        appendEvent(home, { type: 'folded', actor: 'engine', taskId: card.id, runNo: entry.runNo, outcome: 'dirty' });
        outcomes.push({ id: card.id, outcome: 'dirty' });
      }
      continue;
    }

    if (entry.pid === null || entry.pid === undefined) {
      // 原生家族（无 pid 可察）：只认 result.json 落盘；宿主会话中断（配额墙/崩溃）无活性信号——
      // 超时判定（默认 120min，与租约 TTL 同口径）或 --force 人工强制折叠，否则留在池内。
      const ageMs = Date.now() - Date.parse(entry.startedAt ?? 0);
      if (!forced && !(ageMs > nativeTimeoutMs)) {
        remaining.push(entry);
        continue;
      }
      releaseAllForTask(home, entry.taskId, { reason: forced ? 'forced' : 'native-timeout' });
      transition(home, card.id, 'approved');
      appendEvent(home, { type: 'folded', actor: 'engine', taskId: card.id, runNo: entry.runNo, outcome: 'interrupted', reason: forced ? 'forced' : 'native-timeout' });
      outcomes.push({ id: card.id, outcome: 'interrupted', reason: forced ? 'forced' : 'native-timeout' });
      continue;
    }
    if (pidAlive(entry.pid)) {
      remaining.push(entry); // 仍在跑：留在池内
      continue;
    }
    // pid 死且无 result = interrupted（保留 worktree——WIP 保全，决策 18）
    releaseAllForTask(home, entry.taskId, { reason: 'fold' });
    transition(home, card.id, 'approved');
    appendEvent(home, { type: 'folded', actor: 'engine', taskId: card.id, runNo: entry.runNo, outcome: 'interrupted', reason: 'executor-died' });
    outcomes.push({ id: card.id, outcome: 'interrupted', reason: 'executor-died' });
  }

  atomicWriteJson(poolPath, { inFlight: remaining });
} finally {
  lock.release();
}

emit({
  json: values.json ? { ok: true, outcomes } : null,
  text: values.json ? '' : (outcomes.length
    ? `fold: ${outcomes.length} 项——\n${outcomes.map((o) => `  - ${o.id} ${o.outcome}${o.reason ? `（${o.reason}）` : ''}`).join('\n')}`
    : 'fold: 无在途可折叠'),
});
