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

// L2 裁决夹具（custom judge runner=node）：argv 收提示词文件路径（{prompt} 占位替换产物），
// stdout 输出一行裁决 JSON——本夹具恒裁 adopt-theirs（采纳任务分支侧）。
import fs from 'node:fs';

const prompt = fs.readFileSync(process.argv[2], 'utf8');
if (!prompt.includes('==== FILE:')) process.exit(1); // 提示词形态不对：响亮死，不猜
process.stdout.write(JSON.stringify({
  verdict: 'adopt-theirs',
  rationale: '分支侧断言更完整（夹具裁决：采纳任务分支侧）',
}) + '\n');
