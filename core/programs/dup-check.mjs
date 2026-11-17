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

// 八程序③ dup-check：双通道查重（标题 jaccard + 实锚子串）——告警非拒绝（恒 exit 0）。
// 阈值默认 0.20（P1 标定位：按实跑标定——调参入口保留）。
import { parseArgs } from 'node:util';
import { resolveHome } from '../lib/home.mjs';
import { listOpenCards, loadIndex, rebuildIndex } from '../lib/store.mjs';
import { emit, die, EXIT } from '../lib/out.mjs';
import { tokenize, jaccard } from '../lib/similarity.mjs';

const { values } = parseArgs({
  options: {
    home: { type: 'string' }, json: { type: 'boolean' },
    title: { type: 'string' }, anchor: { type: 'string', multiple: true },
    threshold: { type: 'string' }, self: { type: 'string' },
  },
});
if (!values.title) die(EXIT.MISSING, { text: '用法: dup-check.mjs --title "…" [--anchor 锚点 …] [--threshold 0.2] [--self 排除的自身 id]' });

const home = resolveHome(values.home);
const threshold = Number(values.threshold ?? '0.2');
const anchors = (values.anchor ?? []).filter(Boolean);
const titleTokens = tokenize(values.title);

const idx = loadIndex(home);
if (!idx?.rebuiltAt) rebuildIndex(home);
const cards = listOpenCards(home).map(({ card }) => card);

const hits = [];
for (const card of cards) {
  if (values.self && card.id === values.self) continue;
  const score = jaccard(titleTokens, tokenize(card.title));
  const matched = anchors.filter((a) =>
    a && (card.title.includes(a) || String(card.repo ?? '').includes(a) || String(card.base ?? '').includes(a) || card.id.includes(a))
  );
  if (score >= threshold || matched.length) {
    hits.push({ id: card.id, title: card.title, score: Number(score.toFixed(3)), matchedAnchors: matched, status: card.status });
  }
}
hits.sort((a, b) => b.score - a.score);
emit({
  json: values.json ? { ok: true, hits, threshold } : null,
  text: values.json ? '' : (hits.length
    ? `dup-check: ${hits.length} 命中（阈值 ${threshold}）——\n${hits.map((h) => `  - ${h.id} score=${h.score} 锚=[${h.matchedAnchors.join(',')}] ${h.title}`).join('\n')}`
    : `dup-check: 无命中（阈值 ${threshold}）`),
});
