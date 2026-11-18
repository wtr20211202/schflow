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

// L2 裁决夹具（custom judge runner=node）：全程无可解析带 verdict 对象——输出里有多段可解析 JSON
// 但均无 verdict 字段。期望提取器返回 null → unparseable-output → fail-closed eject（绝不猜）。
// 与 judge-garbage.mjs（纯自然语言零 JSON）互补：本夹具钉死「有 JSON 无 verdict」分支。
process.stdout.write([
  '思考中…… {"step":1,"note":"结构化思考片段"} ……再核一遍 {"decision":"undecided","retry":true}',
  '结论：没有可输出的裁决。',
  '',
].join('\n'));
