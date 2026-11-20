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

// 版本身份（P-20261120-1）：从模块位置本级起向上最多 3 级，找 package.json 或
// .claude-plugin/plugin.json 的 version；命中即缓存（同进程一次探测）。都找不到返回 'unknown'。
// 零新增依赖；清单读坏/无 version 字段按未命中继续向上，不抛错。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached = null;

/** 当前包版本：数字清单版本或 'unknown'（只探测一次，缓存至进程结束）。 */
export function pkgVersion() {
  if (cached !== null) return cached;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up <= 3; up++) {
    for (const rel of ['package.json', path.join('.claude-plugin', 'plugin.json')]) {
      const v = readVersion(path.join(dir, rel));
      if (v !== null) return (cached = v);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // 文件系统根：不再向上
    dir = parent;
  }
  return (cached = 'unknown');
}

function readVersion(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')).version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null; // 文件不存在/读坏/非 JSON：未命中
  }
}
