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

// 环境池与资源租约（§8 v1.0.10/11/12）：
// 供给源可插拔（static=envs.yaml 直列 / command=外部命令出 JSON 清单）；
// 引擎只消费租约协议四字段 name/acquire/labels/setup+teardown——其余字段（ref 等）一概不透明（零凭据纪律）。
// 载体=state/leases.json（原子写）+ env.leased/released 事件可重放重建；孤儿兜底 TTL 默认 2h。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths } from './home.mjs';
import { readYamlIfExists } from './yamlfile.mjs';
import { atomicWriteJson } from './atomic.mjs';
import { appendEvent, readEvents } from './events.mjs';

const LEASE_KEYS = new Set(['name', 'acquire', 'capacity', 'labels', 'setup', 'teardown', 'protected', 'ref']);

/** 载入环境池：HOME 层 envs.yaml + 项目层同名覆盖（用户层内部同款覆盖语义） */
export function loadEnvPool(home, projectName = null) {
  const layers = [];
  const homeYaml = readYamlIfExists(paths(home).envsYaml);
  if (homeYaml && Object.keys(homeYaml).length) layers.push(homeYaml);
  if (projectName) {
    const pj = readYamlIfExists(path.join(paths(home).projects, projectName, 'envs.yaml'));
    if (pj && Object.keys(pj).length) layers.push(pj);
  }
  const envs = new Map();
  for (const layer of layers) {
    for (const def of expandProvider(layer)) {
      for (const k of Object.keys(def)) if (!LEASE_KEYS.has(k)) {
        throw new Error(`envs.yaml 未知字段 "${k}"（环境 ${def.name}）——租约协议四字段之外仅 ref 不透明保留`);
      }
      envs.set(def.name, def); // 后层同名覆盖
    }
  }
  return envs;
}

function expandProvider(layer) {
  const provider = layer.provider || 'static';
  if (provider === 'static') {
    const envs = layer.environments || {};
    return Object.entries(envs).map(([name, def]) => ({ name, ...def }));
  }
  if (provider === 'command') {
    if (!layer.list) throw new Error('envs.yaml provider=command 需要 list 命令');
    const r = spawnSync(layer.list, { encoding: 'utf8', shell: true, windowsHide: true });
    if (r.status !== 0) throw new Error(`envs.yaml list 命令失败（${r.status}）：${(r.stderr || '').trim()}`);
    const parsed = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) throw new Error('envs.yaml list 命令输出须为 JSON 数组 [{name, acquire, ...}]');
    return parsed.map((e) => ({ ...e }));
  }
  throw new Error(`envs.yaml 未知 provider "${provider}"（static | command）`);
}

/** 匹配候选：want=串（点名）| 标签数组（全含）；protected 永不匹配；多命中最少占用优先 */
export function matchEnvs(envs, leases, want) {
  const isLabels = Array.isArray(want);
  const candidates = [];
  for (const def of envs.values()) {
    if (def.protected === true) continue; // ADR-0019 红线：真实使用实例永不入池
    const hit = isLabels
      ? (def.labels || []).length >= want.length && want.every((l) => (def.labels || []).includes(l))
      : def.name === want;
    if (hit) candidates.push(def);
  }
  candidates.sort((a, b) => holdersOf(leases, a.name).length - holdersOf(leases, b.name).length);
  return candidates;
}

export function holdersOf(leases, envName) {
  return leases.envs?.[envName]?.holders ?? [];
}

/** 租约容量：exclusive 串行 / shared 计数（capacity 缺省 1）——可得性预判与取约持久化共用一份口径 */
export function leaseCapacity(def) {
  return def.acquire === 'shared' ? (def.capacity ?? 1) : 1;
}

/** 租约可得性只读预判——acquireLease 的 busy 判定同源一份口径（dispatch --plan 预演与真实取约共用，防漂移） */
export function leaseAvailable(leases, def) {
  return holdersOf(leases, def.name).length < leaseCapacity(def);
}

/** 取租约：exclusive 串行 / shared 计数（capacity 缺省 1）；setup 钩子在 0→1 跳变执行（shared）或占用时（exclusive）。
 *  失败语义：busy=有人占；setup-failed=准备命令失败（teardown 保证执行，v1.0.11）。 */
export function acquireLease(home, def, { taskId, runNo }) {
  const leases = readLeases(home);
  const holders = holdersOf(leases, def.name);
  const mode = def.acquire === 'shared' ? 'shared' : 'exclusive';
  if (holders.length >= leaseCapacity(def)) return { ok: false, reason: 'busy', holders };

  const entry = leases.envs[def.name] ?? { mode, capacity: leaseCapacity(def), holders: [] };
  const isFirst = entry.holders.length === 0;
  if (def.setup && isFirst) {
    const r = spawnSync(def.setup, { encoding: 'utf8', shell: true, windowsHide: true });
    if (r.status !== 0) {
      if (def.teardown) spawnSync(def.teardown, { encoding: 'utf8', shell: true, windowsHide: true });
      return { ok: false, reason: 'setup-failed', detail: (r.stderr || r.stdout || '').trim().slice(0, 500) };
    }
  }
  entry.holders.push({ taskId, runNo, acquiredAt: new Date().toISOString() });
  leases.envs[def.name] = entry;
  atomicWriteJson(paths(home).leases, leases);
  appendEvent(home, { type: 'env.leased', actor: 'engine', env: def.name, taskId });
  return { ok: true, env: def.name };
}

/** 释放租约：N→0（shared）/最后持有（exclusive）跳变执行 teardown；幂等。 */
export function releaseLease(home, envName, taskId, { reason = 'fold' } = {}) {
  const leases = readLeases(home);
  const entry = leases.envs?.[envName];
  if (!entry) return false;
  const before = entry.holders.length;
  entry.holders = entry.holders.filter((h) => h.taskId !== taskId);
  if (entry.holders.length === before) return false; // 未持有=幂等
  const def = loadEnvPool(home).get(envName);
  if (def?.teardown && entry.holders.length === 0) {
    spawnSync(def.teardown, { encoding: 'utf8', shell: true, windowsHide: true }); // 尽力而为
  }
  if (entry.holders.length === 0) delete leases.envs[envName];
  else leases.envs[envName] = entry;
  atomicWriteJson(paths(home).leases, leases);
  appendEvent(home, { type: 'env.released', actor: 'engine', env: envName, taskId, reason });
  return true;
}

/** 释放任务名下全部租约（fold 折叠 done/interrupted/blocked 时强制释放——v1.0.11） */
export function releaseAllForTask(home, taskId, { reason } = {}) {
  const leases = readLeases(home);
  const names = Object.entries(leases.envs || {})
    .filter(([, e]) => e.holders.some((h) => h.taskId === taskId))
    .map(([n]) => n);
  for (const n of names) releaseLease(home, n, taskId, { reason });
  return names;
}

/** 孤儿回收：holder 任务已不在 running 或超 TTL（默认 2h）→ 强制释放并记事件 */
export function sweepOrphanLeases(home, { isRunning, ttlMs = 2 * 60 * 60_000 } = {}) {
  const leases = readLeases(home);
  const swept = [];
  for (const [name, entry] of Object.entries(leases.envs || {})) {
    for (const h of [...entry.holders]) {
      const tooOld = Date.now() - Date.parse(h.acquiredAt) > ttlMs;
      const notRunning = isRunning ? !isRunning(h.taskId) : false;
      if (tooOld || notRunning) {
        releaseLease(home, name, h.taskId, { reason: tooOld ? 'ttl' : 'not-running' });
        swept.push({ env: name, taskId: h.taskId, reason: tooOld ? 'ttl' : 'not-running' });
      }
    }
  }
  return swept;
}

export function readLeases(home) {
  const f = paths(home).leases;
  if (!fs.existsSync(f)) return { envs: {} };
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/** 崩溃恢复：由 env.leased/released 事件重放重建租约表（状态文件不可信时） */
export function rebuildLeasesFromEvents(home) {
  const evts = readEvents(home, { types: ['env.leased', 'env.released'] });
  const table = { envs: {} };
  for (const e of evts) {
    const entry = table.envs[e.env] ?? { holders: [] };
    if (e.type === 'env.leased') entry.holders.push({ taskId: e.taskId, acquiredAt: e.ts });
    else entry.holders = entry.holders.filter((h) => h.taskId !== e.taskId);
    if (entry.holders.length) table.envs[e.env] = entry;
    else delete table.envs[e.env];
  }
  atomicWriteJson(paths(home).leases, table);
  return table;
}
