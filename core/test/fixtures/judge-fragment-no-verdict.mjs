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

// L2 裁决夹具（custom judge runner=node）：钉死本轮真实失败形态（P-20261118-11 真机首验）——
// reasoning 前段含「可解析但无 verdict 字段」的 JSON 片段（旧提取器取首个可解析对象 →
// PARSED verdict=undefined → unparseable），终答 JSON 在尾行。期望提取器跳过无 verdict 片段
// 取末个带 verdict 者 → 解析成功并应用。
import fs from 'node:fs';

const prompt = fs.readFileSync(process.argv[2], 'utf8');
if (!prompt.includes('==== FILE:')) process.exit(1); // 提示词形态不对：响亮死，不猜

process.stdout.write([
  '我需要先分析这个冲突的结构：{"action":"analyze","target":"README.md","note":"片段无 verdict 字段"}',
  '分析完毕：分支侧内容是终态，采纳任务分支侧。',
  '{"verdict":"adopt-theirs","rationale":"终答在尾行：片段无 verdict 被跳过"}',
  '',
].join('\n'));
