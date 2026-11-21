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

// 测试夹具：`node --require capture-spawn.cjs <program>` 预载——拦截 child_process.spawn，
// 把「派发器实际传给 spawn 的 argv」原样追加到 $SCHFLOW_TEST_CAPTURE_SPAWN（一行一个 JSON）。
// 用途：跨平台断言 runner 启动参数（dsh/claude 容器会话续跑），不依赖真实二进制或 shell 语义；
// 拦截后仍调用原 spawn（子进程不存在则 ENOENT 落 transcript.err，不影响 argv 捕获）。
// 未设该环境变量时零副作用（普通 node 进程也可安全预载）。
const fs = require('node:fs');
const cp = require('node:child_process');

const origSpawn = cp.spawn;
cp.spawn = function captureSpawn(cmd, args, opts) {
  const file = process.env.SCHFLOW_TEST_CAPTURE_SPAWN;
  if (file) {
    try { fs.appendFileSync(file, JSON.stringify({ cmd, args }) + '\n'); } catch { /* 捕获面 fail-soft */ }
  }
  return origSpawn.apply(this, arguments);
};
