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

// 测试夹具：玩具仓库（真实 git）+ 隔离 HOME + 程序 CLI 调用面 + 任务卡快捷构造。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 测试库一律临时新建：默认静默 resolveHome 的「新建空库」提示（断言该提示的用例显式传 SCHFLOW_QUIET: ''）。
// 模块加载即设——run() 派生程序经 process.env 继承。
process.env.SCHFLOW_QUIET = '1';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROG = (name) => path.join(PKG_ROOT, 'core', 'programs', `${name}.mjs`);

export function tmpdir(prefix = 'schflow-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 玩具仓库：main + 一笔初始提交（已配身份；可选建 origin 裸仓并推） */
export function mkToyRepo(dir, { origin = false } = {}) {
  const repo = path.join(dir, 'toyrepo');
  fs.mkdirSync(repo, { recursive: true });
  const g = (args) => {
    const r = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8', windowsHide: true,
      // CI/干净环境可能没有任何 git 身份（global/system config 皆空）——测试提交
      // 全部走环境变量身份（优先级高于 config 文件），不依赖 runner 预置。
      env: { ...process.env, GIT_AUTHOR_NAME: 'schflow-test', GIT_AUTHOR_EMAIL: 'test@schflow.local', GIT_COMMITTER_NAME: 'schflow-test', GIT_COMMITTER_EMAIL: 'test@schflow.local' },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g(['init', '-b', 'main']);
  g(['config', 'user.name', 'schflow-test']);
  g(['config', 'user.email', 'test@schflow.local']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# toy\n');
  g(['add', '-A']);
  g(['commit', '-m', 'chore: init toy repo']);
  if (origin) {
    const bare = path.join(dir, 'origin.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8', windowsHide: true });
    g(['remote', 'add', 'origin', bare]);
    g(['push', '-u', 'origin', 'main']);
  }
  return repo;
}

/** 运行八程序 CLI：node core/programs/<name>.mjs … */
export function run(name, args, { home, env = {}, expectFail = false } = {}) {
  const r = spawnSync(process.execPath, [PROG(name), ...(home ? ['--home', home] : []), ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env },
  });
  if (!expectFail && r.status !== 0) {
    throw new Error(`program ${name} exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 人读输出 */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** 直连库面建任务（setup 走捷径；行为验证一律走程序 CLI） */
export async function addTask(home, spec, proposalMd = '') {
  const { resolveHome } = await import('../lib/home.mjs');
  const { createTask, transition } = await import('../lib/store.mjs');
  resolveHome(home);
  const card = {
    id: spec.id, kind: spec.kind ?? 'code', title: spec.title ?? `测试任务 ${spec.id}`,
    status: 'pending', priority: spec.priority ?? 'medium',
    source: spec.source ?? { type: 'human', trust: 'trusted' },
    dependsOn: spec.dependsOn ?? [], sessionOnly: false, attempts: 0,
    ...(spec.project ? { project: spec.project } : {}),
    ...(spec.repo ? { repo: spec.repo } : {}),
    ...(spec.base ? { base: spec.base } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  createTask(home, card, proposalMd || `# ${card.title}\n\n测试提案正文。\n`);
  if (spec.status === 'approved') transition(home, card.id, 'approved', { actor: 'human' });
  return card;
}

export function writeProfile(home, project, yaml) {
  const dir = path.join(home, 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'schflow.yaml'), typeof yaml === 'string' ? yaml : JSON.stringify(yaml));
}

export function writeEnvs(home, yaml) {
  fs.writeFileSync(path.join(home, 'envs.yaml'), typeof yaml === 'string' ? yaml : JSON.stringify(yaml));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 相对文件清单（posix 分隔符、排序；只列文件，空目录不参与——镜像守卫按内容判定）。 */
export function listFilesRel(root) {
  const out = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  })(root, '');
  return out.sort();
}

/** 镜像差异清单（插件同步守卫共用）：文件集双向相等 + 逐字节一致；空数组=完全一致。 */
export function mirrorDiff(canonRoot, mirrorRoot) {
  const canon = new Set(listFilesRel(canonRoot));
  const mirror = new Set(listFilesRel(mirrorRoot));
  const problems = [];
  for (const f of canon) if (!mirror.has(f)) problems.push(`缺少 ${f}`);
  for (const f of mirror) if (!canon.has(f)) problems.push(`多余 ${f}`);
  for (const f of canon) {
    if (!mirror.has(f)) continue;
    if (!fs.readFileSync(path.join(canonRoot, f)).equals(fs.readFileSync(path.join(mirrorRoot, f)))) {
      problems.push(`内容漂移 ${f}`);
    }
  }
  return problems;
}

/** 轮询 fold 至收敛（全部在途折完）或超时。
 *  缺省 45s：CI 冷跑 Windows runner（AV 扫描/共享 CPU）下 spawned 执行器写 result 偶超 15s
 *  ——v0.1.5 CI windows-22 一次性 flake 的唯一合理机制（本地热机三轮 79/79 不复现）。 */
export async function pollFold(home, { expectCount = 1, timeoutMs = 45_000 } = {}) {
  const { readEvents } = await import('../lib/events.mjs');
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = run('fold', ['--json'], { home, expectFail: true });
    const folded = readEvents(home, { types: ['folded'] });
    if (folded.length >= expectCount) return folded;
    await sleep(200);
  }
  throw new Error(`pollFold 超时（期望 ${expectCount} 折叠）\nlast fold: ${last?.stdout}\n${last?.stderr}`);
}
