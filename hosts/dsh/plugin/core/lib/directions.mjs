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

// direction 装载（§4.1）：数据文件非代码。用户层 HOME/directions/ 同名覆盖包内 skills/directions/
// （升级共存规则①）；校验器只消费 exclusiveHuman 等结构面字段。
import fs from 'node:fs';
import path from 'node:path';
import { readYamlIfExists } from './yamlfile.mjs';
import { PKG_ROOT } from './runner.mjs';

export function loadDirections(home) {
  const map = new Map();
  const pkgDir = path.join(PKG_ROOT, 'skills', 'directions');
  const userDir = path.join(home, 'directions');
  for (const dir of [pkgDir, userDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      const name = f.replace(/\.ya?ml$/, '');
      const def = readYamlIfExists(path.join(dir, f)) || {};
      map.set(name, def); // 后载入的用户层覆盖
    }
  }
  return map;
}
