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

// L2 裁决夹具（custom judge runner=node）：argv 收提示词文件路径，解析逐文件 theirs（:3 任务分支侧）
// 段，输出 merge-both 裁决（files=theirs 全文+裁决标记行——让「内容真被应用」可断言）。
// 分段定界符与 core/lib/conflicto.mjs buildPrompt 的输出格式同源约定。
import fs from 'node:fs';

const text = fs.readFileSync(process.argv[2], 'utf8');
const files = {};
for (const part of text.split('==== FILE: ').slice(1)) {
  // 首行形态「<path> ====」——定界符是 ==== FILE: <path> ====，剥掉行尾 ' ====' 才是纯路径
  const p = part.slice(0, part.indexOf('\n')).replace(/ ====$/, '');
  const theirs = part.split('---- theirs (:3 任务分支侧) ----\n')[1].split('\n==== END FILE ====')[0];
  files[p] = `${theirs}judge-merged ${p}\n`;
}
if (!Object.keys(files).length) process.exit(1); // 没解析到冲突文件：响亮死，不猜
process.stdout.write(JSON.stringify({
  verdict: 'merge-both',
  rationale: '两侧互补，以分支侧为底追加裁决标记（夹具裁决）',
  files,
}) + '\n');
