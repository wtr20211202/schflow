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

// 项目区 Profile（projects/<name>/schflow.yaml，P0.5 字段子集）+ repo/base 解析序 + 挂载解析。
// 解析序（v1.0.7/11 正典）：repo = task.repo → project.repo；base = task.base → 项目 default-base → repo HEAD 默认分支。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths } from './home.mjs';
import { readYamlIfExists } from './yamlfile.mjs';
import { defaultBranch } from './gitutil.mjs';

const PROFILE_KEYS = new Set(['schemaVersion', 'repo', 'default-base', 'concurrency', 'runner', 'runner-cmd', 'executor', 'model-pool', 'mounts', 'verify', 'ref']);

export function loadProfile(home, projectName) {
  if (!projectName) return null;
  const file = path.join(paths(home).projects, projectName, 'schflow.yaml');
  const p = readYamlIfExists(file);
  if (!p) return null;
  for (const k of Object.keys(p)) if (!PROFILE_KEYS.has(k)) throw new Error(`schflow.yaml 未知字段 "${k}"（${file}）——引用面响亮失败`);
  return { name: projectName, file, ...p };
}

/** 任务→Profile 路由（§7 P0.5 单 Profile 子集）：task.profile 显式 > 项目唯一 Profile */
export function routeProfile(home, card) {
  if (card.project) return loadProfile(home, card.project);
  return null;
}

/** repo 解析；无 → null（非 git 轨道或 defer 原因 repo-missing） */
export function resolveRepo(card, profile) {
  return card.repo || profile?.repo || null;
}

/** base 解析（git 轨道任务用）；repo 缺位抛错（调用方保证 repo 已解析） */
export function resolveBase(card, profile, repoDir) {
  return card.base || profile?.['default-base'] || defaultBranch(repoDir);
}

/** git 轨道判定：code/fix/chore 恒真；docs 有 repo 才真；investigate/research 恒假 */
export function gitTrackOf(card, repo) {
  if (['code', 'fix', 'chore'].includes(card.kind)) return true;
  if (card.kind === 'docs') return !!repo;
  return false;
}

/** 挂载解析：路径存在性校验 + 版本 pin（git 仓库→rev 短哈希；否则 mtime）——随派发事件落审计（§5.1 对策 2） */
export function resolveMounts(profile, home) {
  const mounts = profile?.mounts ?? [];
  const out = [];
  for (const raw of mounts) {
    const p = String(raw).replace(/\$SCHFLOW_HOME/g, home).replace(/^repo:/, '');
    const abs = path.isAbsolute(p) ? p : path.resolve(home, p);
    if (!fs.existsSync(abs)) throw new Error(`mount 路径不存在：${raw}（→${abs}）——引用面响亮失败`);
    let version = null;
    const r = spawnSync('git', ['-C', abs, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) version = r.stdout.trim();
    if (!version) version = `mtime-${fs.statSync(abs).mtime.toISOString()}`;
    out.push({ path: abs, version });
  }
  return out;
}

/** 挂载白名单（§5.1 对策 4：HOME 配置登记制——state/mount-whitelist.txt 存在即强制，一行一前缀） */
export function checkMountWhitelist(home, mounts) {
  const wlFile = path.join(paths(home).state, 'mount-whitelist.txt');
  if (!fs.existsSync(wlFile)) return null; // 未登记制=不强制（P0.5 默认）
  const prefixes = fs.readFileSync(wlFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const denied = mounts.filter((m) => !prefixes.some((pfx) => m.path.startsWith(pfx)));
  return denied.length ? denied : null;
}

