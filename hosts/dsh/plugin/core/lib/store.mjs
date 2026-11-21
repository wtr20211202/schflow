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

// 任务库存取：tasks/open|done 布局、任务卡唯一读写面、状态翻转唯一出口（§17.4：一切转移必经
// transition()，自动落事件——杜绝旁路写）、派生索引重建（§6.2：索引=可重建缓存）。
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './home.mjs';
import { readYaml, writeYaml } from './yamlfile.mjs';
import { atomicWriteJson } from './atomic.mjs';
import { appendEvent } from './events.mjs';
import { canTransition } from './taskcard.mjs';

export function openTaskDir(home, id) {
  return path.join(paths(home).tasksOpen, id);
}

/** 在 open 与 done/<YYYY-MM>/ 归档区查找任务目录；找不到返回 null */
export function findTaskDir(home, id) {
  const open = openTaskDir(home, id);
  if (fs.existsSync(path.join(open, 'task.yaml'))) return open;
  const doneRoot = paths(home).tasksDone;
  if (fs.existsSync(doneRoot)) {
    for (const month of fs.readdirSync(doneRoot).sort().reverse()) {
      const d = path.join(doneRoot, month, id);
      if (fs.existsSync(path.join(d, 'task.yaml'))) return d;
    }
  }
  return null;
}

export function loadCard(dir) {
  return readYaml(path.join(dir, 'task.yaml'));
}

export function saveCard(dir, card) {
  writeYaml(path.join(dir, 'task.yaml'), { ...card, updatedAt: new Date().toISOString() });
}

export function listOpenCards(home) {
  const root = paths(home).tasksOpen;
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const id of fs.readdirSync(root).sort()) {
    const dir = path.join(root, id);
    const y = path.join(dir, 'task.yaml');
    if (!fs.existsSync(y)) continue;
    out.push({ dir, card: readYaml(y) });
  }
  return out;
}

/** done/<YYYY-MM>/ 归档区卡片清单（月分卷遍历，月序升幂等；损坏卡跳过） */
export function listDoneCards(home) {
  const root = paths(home).tasksDone;
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const month of fs.readdirSync(root).sort()) {
    const mdir = path.join(root, month);
    for (const id of fs.readdirSync(mdir).sort()) {
      const y = path.join(mdir, id, 'task.yaml');
      if (!fs.existsSync(y)) continue;
      out.push({ dir: path.join(mdir, id), card: readYaml(y) });
    }
  }
  return out;
}

/** 全量卡片清单：open 活跃 + done 归档（harvest 幂等锚/归档源可见性用——归档不改 status） */
export function listAllCards(home) {
  return [...listOpenCards(home), ...listDoneCards(home)];
}

/** 建任务目录（intake 入库面）：task.yaml + proposal.md + runs/ + task.created 事件 */
export function createTask(home, card, proposalMd = '') {
  const dir = openTaskDir(home, card.id);
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  writeYaml(path.join(dir, 'task.yaml'), card);
  if (proposalMd) fs.writeFileSync(path.join(dir, 'proposal.md'), proposalMd);
  appendEvent(home, { type: 'task.created', actor: card.source?.type === 'human' ? 'human' : 'proposer', taskId: card.id });
  return dir;
}

/** 状态翻转唯一出口：守卫转移表 → 落卡 → status.changed 事件。非法跳转抛错。
 *  patch（可选）：随状态翻转一起写入的字段补丁——与 status 同一次原子写落卡（decide 批准留痕），
 *  事件语义不变（status.changed 仍只记 from/to/actor/extra）。
 */
export function transition(home, id, to, { actor = 'engine', extra = {}, patch } = {}) {
  const dir = findTaskDir(home, id);
  if (!dir) throw new Error(`transition: task ${id} not found`);
  const card = loadCard(dir);
  const from = card.status;
  if (from === to) return { dir, card, from, to }; // 幂等
  if (!canTransition(from, to)) throw new Error(`transition: ${from} → ${to} 不在转移表（task ${id}）`);
  card.status = to;
  if (patch) Object.assign(card, patch);
  saveCard(dir, card);
  appendEvent(home, { type: 'status.changed', actor, taskId: id, from, to, ...extra });
  return { dir, card, from, to };
}

/** 归档：open → done/<YYYY-MM>/<id>（终态任务收尾，月分卷） */
export function archiveTask(home, id) {
  const dir = findTaskDir(home, id);
  if (!dir || !dir.startsWith(path.join(paths(home).tasksOpen))) return dir; // 已归档=幂等
  const dest = path.join(paths(home).tasksDone, ymNow(), id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(dir, dest);
  return dest;
}

export function isArchived(home, id) {
  const dir = findTaskDir(home, id);
  return !!dir && dir.includes(`${path.sep}done${path.sep}`);
}

/** 派生索引重建：open 全量 + done 全量 → index/tasks.json（可由任务目录全量重建的缓存） */
export function rebuildIndex(home) {
  const byId = {};
  const collect = (root, terminal) => {
    if (!fs.existsSync(root)) return;
    for (const id of fs.readdirSync(root)) {
      const y = path.join(root, id, 'task.yaml');
      if (!fs.existsSync(y)) continue;
      try {
        const c = readYaml(y);
        byId[id] = indexEntry(path.join(root, id), c, terminal);
      } catch { /* 损坏卡：status 程序的 fail-closed 清单负责报，索引跳过 */ }
    }
  };
  collect(paths(home).tasksOpen, false);
  for (const month of fs.existsSync(paths(home).tasksDone) ? fs.readdirSync(paths(home).tasksDone) : []) {
    collect(path.join(paths(home).tasksDone, month), true);
  }
  atomicWriteJson(paths(home).index, { rebuiltAt: new Date().toISOString(), tasks: byId });
  return { count: Object.keys(byId).length };
}

export function loadIndex(home) {
  const f = paths(home).index;
  if (!fs.existsSync(f)) return { tasks: {} };
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function indexEntry(dir, c, terminal) {
  return {
    dir, terminal,
    status: c.status, kind: c.kind, title: c.title, priority: c.priority,
    project: c.project ?? null, repo: c.repo ?? null, base: c.base ?? null, env: c.env ?? null,
    attempts: c.attempts ?? 0, updatedAt: c.updatedAt,
  };
}

function ymNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
