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

// 执行器产物 result.json 契约（docs/spec/result.md）。解析失败=interrupted 由 fold 程序处置。
export const RESULT_STATUSES = ['done', 'blocked', 'stale', 'dirty'];

const ALL_KEYS = new Set(['status', 'summary', 'commit', 'deliverables', 'flags', 'freshness', 'specs']);

/**
 * @param {object} r result.json 对象
 * @param {{gitTrack?: boolean}} ctx gitTrack=true 时 done 必带 commit（git 轨道提交哈希即交付）
 * @returns {string[]} 违规清单（空=通过）
 */
export function validateResult(r, ctx = {}) {
  const v = [];
  const push = (code, detail) => v.push(`${code}: ${detail}`);
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['schema: result is not an object'];
  for (const k of Object.keys(r)) if (!ALL_KEYS.has(k)) push('unknown-field', k);
  if (!RESULT_STATUSES.includes(r.status)) push('status-enum', String(r.status));
  if (typeof r.summary !== 'string' || !r.summary.trim()) push('summary-required', '');
  if (r.commit !== undefined && typeof r.commit !== 'string') push('commit-type', '');
  if (ctx.gitTrack && r.status === 'done' && !r.commit) push('commit-required', 'git 轨道任务 done 必带提交哈希');
  if (r.freshness !== undefined && !['valid', 'adapted', 'stale'].includes(r.freshness)) push('freshness-enum', String(r.freshness));
  if (r.freshness === 'stale' && r.status !== 'stale') push('freshness-stale-mismatch', 'freshness=stale 时 status 必为 stale');
  if (r.flags !== undefined && (typeof r.flags !== 'object' || Array.isArray(r.flags))) push('flags-type', '');
  if (r.specs !== undefined && (!Array.isArray(r.specs) || r.specs.some((s) => typeof s !== 'string'))) push('specs-type', '');
  if (r.deliverables !== undefined) {
    if (!Array.isArray(r.deliverables)) push('deliverables-type', '');
    else r.deliverables.forEach((d, i) => {
      if (!d || typeof d !== 'object') return push('deliverables-item', `[${i}]`);
      for (const k of Object.keys(d)) if (!['path', 'type'].includes(k)) push('deliverables-unknown-field', `[${i}].${k}`);
      if (typeof d.path !== 'string' || !d.path) push('deliverables-path', `[${i}]`);
    });
  }
  return v;
}
