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

// 查重相似度：双语 token 化（ASCII 词 + CJK 二元组）+ Jaccard。
export function tokenize(s) {
  const out = new Set();
  const lower = String(s ?? '').toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_.-]{2,}/g)) out.add(m[0]);
  const cjk = [...lower.matchAll(/[\u4e00-\u9fff]/g)].map((m) => m[0]);
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk[i] + cjk[i + 1]);
  if (cjk.length === 1) out.add(cjk[0]);
  return out;
}

export function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter++;
  return inter / (aSet.size + bSet.size - inter);
}
