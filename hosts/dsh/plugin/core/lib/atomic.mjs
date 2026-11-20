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

// 原子写：tmp + rename（D2 一切状态文件原子写；POSIX rename 原子覆盖，
// Windows 对已存在目标 rename 失败——先删后改名，窗口由 HOME 写锁纪律覆盖）
import fs from 'node:fs';

export function atomicWriteFile(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }
}

export function atomicWriteJson(file, obj) {
  atomicWriteFile(file, JSON.stringify(obj, null, 2) + '\n');
}
