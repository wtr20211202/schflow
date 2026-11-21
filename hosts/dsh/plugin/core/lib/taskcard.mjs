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

// 任务卡 task.yaml 校验（docs/spec/task-card.md 逐字段）+ 状态机转移表（规则 3 的显式正典）
// 校验器从严：未知字段拒绝（ADR-0022）；一切违规以清单返回，不抛出。

export const KINDS = ['code', 'fix', 'investigate', 'docs', 'research', 'chore'];
export const STATUSES = ['pending', 'approved', 'running', 'done', 'blocked', 'stale', 'rejected'];
export const PRIORITIES = ['highest', 'high', 'medium', 'low'];
export const SOURCE_TYPES = ['generator', 'human', 'patrol', 'harvest', 'improve', 'webhook'];
// 作者 ≠ 触发源：source.type 决定信任等级（trust），source.author 决定是否必须过评审闸与显式批准。
export const SOURCE_AUTHORS = ['human', 'model'];
export const TRUST_BY_TYPE = {
  human: 'trusted', harvest: 'trusted',
  generator: 'semi', patrol: 'semi', improve: 'semi',
  webhook: 'untrusted',
};

const ID_RE = /^P-\d{8}-\d+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// §4.3 转移表（实现正典——docs/spec/task-card.md 规则 3 回填自此）。
// running→approved = interrupted 重派回炉；done→blocked = 合并复验失败 ejected 回炉；
// stale/rejected→approved = 人工 reopen。
export const TRANSITIONS = {
  pending: ['approved', 'rejected', 'stale'],
  approved: ['running', 'rejected', 'stale'],
  running: ['done', 'blocked', 'stale', 'approved'],
  blocked: ['approved', 'stale', 'rejected'],
  done: ['blocked'],
  stale: ['approved'],
  rejected: ['approved'],
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

const REQUIRED = ['id', 'kind', 'title', 'status', 'priority', 'source', 'dependsOn', 'sessionOnly', 'attempts', 'createdAt', 'updatedAt'];
const OPTIONAL = ['project', 'profile', 'repo', 'parent', 'base', 'env', 'branch', 'deliverables', 'docs', 'result', 'triage', 'harvestSource', 'approvedBy', 'approvedAt'];
const ALL_KEYS = new Set([...REQUIRED, ...OPTIONAL]);

/**
 * @param {object} card 任务卡对象
 * @param {{directions?: Map<string,{exclusiveHuman?:boolean}>, gitTrack?: boolean}} ctx
 *   directions 提供时校验 direction 引用与 exclusive-human（规则 5）；缺省跳过该规则（记录 reminder）。
 * @returns {string[]} 违规清单（空=通过）
 */
export function validateTaskCard(card, ctx = {}) {
  const v = [];
  const push = (code, detail) => v.push(`${code}: ${detail}`);
  if (!card || typeof card !== 'object') return ['schema: task card is not an object'];

  for (const k of REQUIRED) if (!(k in card)) push('missing-field', k);
  for (const k of Object.keys(card)) if (!ALL_KEYS.has(k)) push('unknown-field', k);

  if (typeof card.id === 'string' && !ID_RE.test(card.id)) push('id-format', card.id);
  if (!KINDS.includes(card.kind)) push('kind-enum', String(card.kind));
  if (typeof card.title === 'string') {
    if (!card.title.trim()) push('title-empty', '');
    if (card.title.length > 120) push('title-too-long', `${card.title.length}>120`);
  }
  if (!STATUSES.includes(card.status)) push('status-enum', String(card.status));
  if (!PRIORITIES.includes(card.priority)) push('priority-enum', String(card.priority));

  if (card.source) {
    if (typeof card.source !== 'object') push('source-type', 'not an object');
    else {
      for (const k of Object.keys(card.source)) if (!['type', 'direction', 'trust', 'author'].includes(k)) push('source-unknown-field', k);
      if (!SOURCE_TYPES.includes(card.source.type)) push('source.type-enum', String(card.source.type));
      if (card.source.direction !== undefined && typeof card.source.direction !== 'string') push('source.direction-type', '');
      if (card.source.author !== undefined && !SOURCE_AUTHORS.includes(card.source.author)) push('source.author-enum', String(card.source.author));
      if (!['trusted', 'semi', 'untrusted'].includes(card.source.trust)) push('source.trust-enum', String(card.source.trust));
      else if (card.source.type && TRUST_BY_TYPE[card.source.type] && card.source.trust !== TRUST_BY_TYPE[card.source.type]) {
        push('source.trust-mismatch', `${card.source.type} 应为 ${TRUST_BY_TYPE[card.source.type]}，实为 ${card.source.trust}`);
      }
    }
  }

  if (card.dependsOn !== undefined) {
    if (!Array.isArray(card.dependsOn)) push('dependsOn-type', 'not an array');
    else for (const d of card.dependsOn) if (typeof d !== 'string' || !ID_RE.test(d)) push('dependsOn-id-format', String(d));
  }
  if (card.sessionOnly !== undefined && typeof card.sessionOnly !== 'boolean') push('sessionOnly-type', '');
  for (const k of ['project', 'profile', 'parent', 'base', 'branch']) {
    if (card[k] !== undefined && (typeof card[k] !== 'string' || !card[k])) push(`${k}-type`, '');
  }
  if (card.repo !== undefined) {
    if (typeof card.repo !== 'string' || !card.repo) push('repo-type', '');
    else if (!path_isAbsolute(card.repo)) push('repo-absolute', card.repo);
  }
  if (card.env !== undefined) {
    const ok = typeof card.env === 'string' ? card.env.length > 0 : Array.isArray(card.env) && card.env.every((x) => typeof x === 'string' && x.length > 0);
    if (!ok) push('env-type', 'string 或 string[]');
  }
  if (card.deliverables !== undefined) {
    if (!Array.isArray(card.deliverables)) push('deliverables-type', 'not an array');
    else card.deliverables.forEach((d, i) => {
      if (!d || typeof d !== 'object') return push('deliverables-item', `[${i}]`);
      for (const k of Object.keys(d)) if (!['path', 'type'].includes(k)) push('deliverables-unknown-field', `[${i}].${k}`);
      if (typeof d.path !== 'string' || !d.path) push('deliverables-path', `[${i}]`);
      if (d.type !== undefined && !['report', 'code', 'doc'].includes(d.type)) push('deliverables-type-enum', `[${i}] ${d.type}`);
    });
  }
  if (card.docs !== undefined) {
    if (!Array.isArray(card.docs) || card.docs.some((d) => typeof d !== 'string')) push('docs-type', '');
  }
  if (card.attempts !== undefined) {
    if (!Number.isInteger(card.attempts) || card.attempts < 0) push('attempts-type', String(card.attempts));
  }
  for (const k of ['createdAt', 'updatedAt']) {
    if (card[k] !== undefined && (typeof card[k] !== 'string' || !ISO_RE.test(card[k]))) push(`${k}-iso`, String(card[k]));
  }
  if (card.result !== undefined && (typeof card.result !== 'object' || card.result === null || Array.isArray(card.result))) push('result-type', '');
  // M3 判断钩子字段：分诊结论（fold 落卡）与转生血缘锚（harvest 落卡）
  if (card.triage !== undefined && !['env-retry', 'dep-wait', 'design-human'].includes(card.triage)) push('triage-enum', String(card.triage));
  if (card.harvestSource !== undefined && (typeof card.harvestSource !== 'string' || !/^harvest:P-\d{8}-\d+#\d+$/.test(card.harvestSource))) push('harvestSource-format', String(card.harvestSource));

  // 规则 4：highest 仅 human 合法（P2-2）
  if (card.priority === 'highest' && card.source && card.source.type !== 'human') {
    push('priority-highest-nonhuman', `source.type=${card.source.type}`);
  }
  // 规则 5：exclusive-human 方向机械拒绝（validate-task 防线）
  if (ctx.directions && card.source?.direction) {
    const dir = ctx.directions.get(card.source.direction);
    if (!dir) push('direction-unknown', card.source.direction); // 引用面响亮失败
    else if (dir.exclusiveHuman && card.source.type !== 'human') {
      push('direction-exclusive-human', `${card.source.direction} 仅 human 可用，实为 ${card.source.type}`);
    }
  }
  // 规则 6：批准留痕（trust 属来源，review 属内容）——author=model 的草案在批准后必须有 human 批准痕迹；
  // 旧卡无 author 字段时缺省 human，行为零变化。
  if (card.approvedBy !== undefined && card.approvedBy !== 'human') push('approvedBy-enum', String(card.approvedBy));
  if (card.approvedAt !== undefined && (typeof card.approvedAt !== 'string' || !ISO_RE.test(card.approvedAt))) {
    push('approvedAt-iso', String(card.approvedAt));
  }
  const author = card.source?.author ?? 'human';
  if (author === 'model' && ['approved', 'running', 'done'].includes(card.status) && card.approvedBy !== 'human') {
    push('approval-missing', `author=model 且 status=${card.status} 需 approvedBy: human`);
  }
  return v;
}

/** intake 侧默认值补齐（不覆盖已有值） */
export function normalizeCard(card) {
  return {
    status: 'pending',
    dependsOn: [],
    sessionOnly: false,
    attempts: 0,
    ...card,
    createdAt: card.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function path_isAbsolute(p) {
  // win32 或 POSIX 绝对路径（含盘符 /UNC/斜杠开头）
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}
