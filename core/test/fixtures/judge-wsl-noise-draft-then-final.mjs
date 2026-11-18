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

// L2 裁决夹具（custom judge runner=node）：钉死 wsl 桥真机首验形态（P-20261118-11）——
// stdout = wsl.exe UTF-16 警告字节前缀（旧桥 2>&1 混流形态下混入答案通道）+ reasoning 内含
// 草稿 JSON（带合法 verdict=adopt-ours，非终答）+ 尾行终答 JSON（verdict=adopt-theirs ≠ 草稿）。
// 期望提取器取「末个带 verdict 的可解析对象」→ 应用 adopt-theirs（取首个草稿则误用 adopt-ours）。
import fs from 'node:fs';

const prompt = fs.readFileSync(process.argv[2], 'utf8');
if (!prompt.includes('==== FILE:')) process.exit(1); // 提示词形态不对：响亮死，不猜

// wsl.exe 走 stderr 的警告在 UTF-16 下的字节形态（解码后含 NUL 与乱码字符——提取器须能跳过）
const wslWarning = Buffer.from('wsl: 检测到 localhost 代理配置，但未镜像到 WSL\r\n', 'utf16le');
const body = [
  '先分析双方改动……草稿阶段考虑过保留主线：{"verdict":"adopt-ours","rationale":"草稿：主线或已等价包含"}',
  '再想：不对，分支侧断言更完整，改裁采纳任务分支侧，草稿作废。',
  '{"verdict":"adopt-theirs","rationale":"终答在尾行：采纳任务分支侧（草稿作废）"}',
  '',
].join('\n');
process.stdout.write(Buffer.concat([wslWarning, Buffer.from(body, 'utf8')]));
