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

// $SCHFLOW_HOME 解析 + 幂等自举（docs/design.md §6.1；v1.0.5 自举时序：无 setup/init，mkdir -p）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 解析 HOME（--home > 环境变量 > ~/.schflow），并幂等自举目录骨架。返回绝对路径。 */
export function resolveHome(explicit) {
  const home = path.resolve(explicit || process.env.SCHFLOW_HOME || path.join(os.homedir(), '.schflow'));
  bootstrap(home);
  return home;
}

export function bootstrap(home) {
  for (const d of [
    'tasks/open', 'tasks/done', 'projects', 'index', 'state/locks', 'logs', 'knowledge',
  ]) fs.mkdirSync(path.join(home, d), { recursive: true });
}

/** HOME 内标准路径（正典布局见 core/README.md「状态目录约定」） */
export function paths(home) {
  return {
    home,
    tasksOpen: path.join(home, 'tasks', 'open'),
    tasksDone: path.join(home, 'tasks', 'done'),
    projects: path.join(home, 'projects'),
    index: path.join(home, 'index', 'tasks.json'),
    state: path.join(home, 'state'),
    idCounter: path.join(home, 'state', 'id-counter.json'),
    leases: path.join(home, 'state', 'leases.json'),
    pool: path.join(home, 'state', 'pool.json'),
    locks: path.join(home, 'state', 'locks'),
    writeLock: path.join(home, 'state', 'locks', 'write.lock'),
    logs: path.join(home, 'logs'),
    envsYaml: path.join(home, 'envs.yaml'),
    eventsVolume: (yyyymm) => path.join(home, `events-${yyyymm}.jsonl`),
  };
}

/** 本地时区 YYYYMMDD（ID 日期段）与 YYYY-MM（事件分卷） */
export function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
export function ym(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}
