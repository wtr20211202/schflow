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

// 测试入口（node 20~25 行为一致的显式清单形态——目录/glob 自动发现各版本不一）：
// 递归收集 core/test 下 *.test.mjs，交 node --test 执行。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(d, e.name));
    else if (e.name.endsWith('.test.mjs')) files.push(path.join(d, e.name));
  }
})(root);
files.sort();

const only = process.argv.slice(2);
const selected = only.length ? files.filter((f) => only.some((o) => f.includes(o))) : files;
if (!selected.length) { console.error('no test files matched'); process.exit(1); }

const r = spawnSync(process.execPath, ['--test', ...selected], { stdio: 'inherit', windowsHide: true });
process.exit(r.status ?? 1);
