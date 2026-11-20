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

// 输出与退出码约定（docs/spec/programs.md 通用约定）
// 0 成功；1 业务失败；2 前提缺失；75 忙等/锁；76 校验拒绝
import process from 'node:process';

export const EXIT = Object.freeze({ OK: 0, FAIL: 1, MISSING: 2, BUSY: 75, REJECT: 76 });

/** 人读默认 + --json 机读；调用方传 json 对象或字符串 */
export function emit({ json = null, text = '' } = {}) {
  if (json !== null) process.stdout.write(JSON.stringify(json, null, 2) + '\n');
  else if (text) process.stdout.write(text + '\n');
}

export function die(code, { json = null, text = '' } = {}) {
  const stderr = text || (json ? JSON.stringify(json) : `exit ${code}`);
  process.stderr.write(stderr + '\n');
  process.exit(code);
}
