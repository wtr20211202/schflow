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

// result.json 形态规范化器（宿主代收 L0）：白名单机械修正——只修「语义无歧义」的形态偏差，
// 修不动的一律留给回炉。白名单全量三则，封死外溢：
//   ① deliverables：string[] → [{path: s}]（每项皆字符串才修，混合形态不猜）；单对象 → [对象]；
//   ② status：trim + 小写归一，仅当归一后仍落在合法四态枚举内（'RUNNING' 之类不修）；
//   ③ summary：非字符串但为数字/布尔 → String()（null/undefined/空串仍违规，不在本则内）。
// 明确不修（不可机械判定）：unknown-field（可能是语义信息）、commit-required（不可凭空造哈希）、
// freshness 语义类错配、flags 数组形态（猜语义）、deliverables-item 缺 path。
// 修正后必须重跑 validateResult 全绿才算修成——仍有违规即视为修不动，changed:false 原样返回。
import { validateResult, RESULT_STATUSES } from './result.mjs';

/**
 * @param {object} result executor 原件 result.json 对象（不修改入参）
 * @param {{gitTrack?: boolean}} ctx 与 validateResult 同口径
 * @returns {{result: object, fixes: Array<{field: string, from: unknown, to: unknown}>, changed: boolean}}
 *          changed=true 时 result 为修正后对象；否则 result 原样返回（可能为 null 等不可解析形态）
 */
export function normalizeResult(result, ctx = {}) {
  const fixes = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { result, fixes, changed: false }; // 非 object 形态：无可修面
  }
  const r = { ...result };

  // ① deliverables 包装形态：string[] → [{path: s}]；单对象 → [对象]（缺 path 等留给校验器判死）
  if (Array.isArray(r.deliverables)) {
    if (r.deliverables.length && r.deliverables.every((d) => typeof d === 'string')) {
      fixes.push({ field: 'deliverables', from: 'string[]', to: '[{path}]' });
      r.deliverables = r.deliverables.map((s) => ({ path: s }));
    }
  } else if (r.deliverables !== undefined && r.deliverables && typeof r.deliverables === 'object') {
    fixes.push({ field: 'deliverables', from: 'object', to: 'array' });
    r.deliverables = [r.deliverables];
  }

  // ② status 归一：trim + 小写，仅当归一后落在合法枚举内（枚举外形态如 'running' 不猜）
  if (typeof r.status === 'string') {
    const norm = r.status.trim().toLowerCase();
    if (norm !== r.status && RESULT_STATUSES.includes(norm)) {
      fixes.push({ field: 'status', from: r.status, to: norm });
      r.status = norm;
    }
  }

  // ③ summary 字符串化：数字/布尔 → String()（空串/null/undefined 非本则覆盖，仍违规）
  if (typeof r.summary === 'number' || typeof r.summary === 'boolean') {
    fixes.push({ field: 'summary', from: r.summary, to: String(r.summary) });
    r.summary = String(r.summary);
  }

  if (!fixes.length) return { result, fixes, changed: false };
  // 修正后重跑全量校验：仍有违规=修不动（白名单只消形态，消不了语义）——原样返回走回炉
  if (validateResult(r, ctx).length) return { result, fixes: [], changed: false };
  return { result: r, fixes, changed: true };
}
