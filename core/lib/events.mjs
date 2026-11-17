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

// 事件流 events-YYYY-MM.jsonl（docs/spec/events.md）：崩溃恢复的正确性来源 + 可观测性唯一原料。
// 只存元数据与引用；分卷按月；seq 全局单调（跨分卷延续）；追加必持 HOME 写锁（进程内重入安全）。
import fs from 'node:fs';
import path from 'node:path';
import { paths, ym } from './home.mjs';
import { acquireLock } from './lock.mjs';

export const SCHEMA_VERSION = 1;
export const ACTORS = ['proposer', 'orchestrator', 'executor', 'fixer', 'patrol', 'improve', 'engine', 'human', 'webhook'];
export const EVENT_TYPES = [
  'task.created', 'status.changed', 'dispatched', 'folded',
  'env.leased', 'env.released', 'verify.run', 'review.recorded',
  'merge.started', 'merge.done', 'merge.failed', 'merge.ejected',
  'lock.acquired', 'lock.released', 'heartbeat.tick', 'note.appended',
];

/** 追加事件：信封自动补 ts/seq/schemaVersion。返回完整事件对象。 */
export function appendEvent(home, evt, { allowUnknownType = false } = {}) {
  if (!evt || typeof evt !== 'object') throw new Error('event: not an object');
  if (!allowUnknownType && !EVENT_TYPES.includes(evt.type)) {
    throw new Error(`event: unknown type "${evt.type}"（封闭枚举；确需新增走 --allow-unknown-type 并遵守 events.md 版本策略）`);
  }
  if (!ACTORS.includes(evt.actor)) throw new Error(`event: unknown actor "${evt.actor}"`);
  const lock = acquireLock(paths(home).writeLock);
  if (!lock) { const e = new Error('event: HOME write lock busy'); e.code = 'LOCK_BUSY'; throw e; }
  try {
    const seq = lastSeq(home) + 1;
    const full = { ts: new Date().toISOString(), seq, schemaVersion: SCHEMA_VERSION, ...evt };
    const file = paths(home).eventsVolume(ym());
    fs.appendFileSync(file, JSON.stringify(full) + '\n');
    return full;
  } finally {
    lock.release();
  }
}

/** 全局最后 seq：按分卷名倒序，从尾部向回找最后一条**可解析**行
 *  （尾行损坏=进程在 append 中被杀——上一条完整行才是真值，J1-P3：归零会破坏全局单调）。
 *  分卷内有行但全部不可解析 → 响亮失败（数据面可疑，挂起人工），绝不静默归零。 */
export function lastSeq(home) {
  const files = fs.readdirSync(home).filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const file = path.join(home, files[i]);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let sawAny = false;
    for (let j = lines.length - 1; j >= 0; j--) {
      const line = lines[j].trim();
      if (!line) continue;
      sawAny = true;
      try {
        const seq = JSON.parse(line).seq;
        if (Number.isInteger(seq) && seq >= 0) return seq;
      } catch { /* 半截行（append 中被杀）：继续向回找上一条完整行 */ }
    }
    if (sawAny) throw new Error(`events: 分卷 ${files[i]} 存在但无任何可解析行——事件流数据面可疑，拒绝追加（挂起人工）`);
    // 空分卷：继续看更早的分卷
  }
  return 0;
}

/** 读取（可过滤类型）；损坏行跳过并计数（前向兼容：消费方忽略未知 type） */
export function readEvents(home, { types = null } = {}) {
  const out = [];
  let malformed = 0;
  const files = fs.readdirSync(home).filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  for (const f of files) {
    const text = fs.readFileSync(path.join(home, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (!types || types.includes(evt.type)) out.push(evt);
      } catch { malformed++; }
    }
  }
  out.malformed = malformed;
  return out;
}

/** 指定类型+taskId 的事件（merge 队列/时间线用） */
export function eventsForTask(home, taskId, types) {
  return readEvents(home, { types }).filter((e) => e.taskId === taskId);
}

