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

// 八程序④ validate-task：intake 格式门禁（task-card spec 全规则，含 highest/exclusive-human 机械拒绝）。
// 违规 exit 76 + 清单（exit 1 保留给「任务不存在」）。
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { resolveHome } from '../lib/home.mjs';
import { loadCard, findTaskDir } from '../lib/store.mjs';
import { validateTaskCard } from '../lib/taskcard.mjs';
import { loadDirections } from '../lib/directions.mjs';
import { emit, die, EXIT } from '../lib/out.mjs';

const { values } = parseArgs({
  options: { home: { type: 'string' }, json: { type: 'boolean' }, task: { type: 'string' } },
});
if (!values.task) die(EXIT.MISSING, { text: '用法: validate-task.mjs --task <任务目录|task.yaml 路径|任务 id>' });

const home = resolveHome(values.home);
const directions = loadDirections(home);

let dir = values.task;
if (/^P-\d{8}-\d+$/.test(values.task)) {
  dir = findTaskDir(home, values.task);
  if (!dir) die(EXIT.FAIL, { text: `validate-task: 任务 ${values.task} 不存在` });
} else if (values.task.endsWith('.yaml')) {
  dir = path.dirname(path.resolve(values.task));
}
if (!fs.existsSync(path.join(dir, 'task.yaml'))) {
  die(EXIT.MISSING, { text: `validate-task: ${dir} 下无 task.yaml` });
}

const card = loadCard(dir);
const violations = validateTaskCard(card, { directions });
if (violations.length) {
  die(EXIT.REJECT, {
    json: values.json ? { ok: false, id: card.id, violations } : null,
    text: values.json ? '' : `validate-task: ${card.id} 违规 ${violations.length} 项——\n${violations.map((v) => `  - ${v}`).join('\n')}`,
  });
}
emit({ json: values.json ? { ok: true, id: card.id } : null, text: values.json ? '' : `validate-task: ${card.id} 通过` });
