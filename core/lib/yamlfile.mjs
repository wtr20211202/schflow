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

// YAML 读写（yaml 包；写走原子写）
import fs from 'node:fs';
import YAML from 'yaml';
import { atomicWriteFile } from './atomic.mjs';

export function readYaml(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

export function readYamlIfExists(file) {
  if (!fs.existsSync(file)) return null;
  const v = readYaml(file);
  return v === null ? {} : v; // 空文件 → 空对象
}

export function writeYaml(file, obj) {
  atomicWriteFile(file, YAML.stringify(obj));
}
