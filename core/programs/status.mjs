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

// 八程序② status：任务卡校验（task-card spec 全规则）+ 派生索引重建。
// fail-closed（ADR-0026）：任一卡校验失败 → exit 76 + 清单，且不重建索引（跳过一切状态判定动作的等价物）。
// --version：只打印版本号（不解析 HOME、不自举库）；--json 主输出带 home/version（身份可见）。
import { parseArgs } from 'node:util';
import { resolveHome } from '../lib/home.mjs';
import { pkgVersion } from '../lib/version.mjs';
import { listOpenCards, rebuildIndex } from '../lib/store.mjs';
import { validateTaskCard } from '../lib/taskcard.mjs';
import { loadDirections } from '../lib/directions.mjs';
import { emit, die, EXIT } from '../lib/out.mjs';

const { values } = parseArgs({
  options: { home: { type: 'string' }, json: { type: 'boolean' }, version: { type: 'boolean' } },
});
if (values.version) {
  process.stdout.write(`${pkgVersion()}\n`);
  process.exit(EXIT.OK);
}
const home = resolveHome(values.home);
const directions = loadDirections(home);

const violations = [];
for (const { card } of listOpenCards(home)) {
  for (const v of validateTaskCard(card, { directions })) violations.push(`${card.id ?? '(无 id)'} · ${v}`);
}
if (violations.length) {
  die(EXIT.REJECT, {
    json: values.json ? { ok: false, failClosed: violations } : null,
    text: values.json ? '' : `status: 校验失败（fail-closed，索引未重建）——\n${violations.map((v) => `  - ${v}`).join('\n')}`,
  });
}
const stats = rebuildIndex(home);
emit({
  json: values.json ? { ok: true, home, version: pkgVersion(), tasks: stats.count, rebuiltAt: new Date().toISOString() } : null,
  text: values.json ? '' : `status: 通过，索引重建（${stats.count} 任务）`,
});
