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

// 执行器启动（雇佣面 §9）：dispatch 程序=子进程家族（本脚本无宿主会话可依附，天然子进程——
// v1.0.3 家族自动判定的第 2 条；原生家族由 orchestrator skill 在宿主内自行派生，不经本模块）。
//
// 跨平台纪律（v1.0.14，win/mac/linux 红线在启动器的落点）：
//   ① 内置启动器一律 argv 数组直启（零 shell）——shell 字符串的引号/重定向语义在 cmd.exe 与
//      POSIX sh 间不可移植（实测 cmd /S 引号吞噬、重定向静默挂死）；
//   ② 平台差异只允许出现在 hosts/ 宿主包与 Profile 命令里，core 不写平台分支；
//   ③ 任务书恒走 stdin（dsh/claude 均支持 `-` 读 stdin），避免 argv 长度上限与转义问题；
//   ④ custom runner 支持 argv 数组（推荐，零 shell）与字符串（兼容形态，经 shell——平台语义自负）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolvePromptVersion(role = 'executor') {
  // 提示词版本协议（§17.4）：frontmatter version 为正典；读不到=unknown（doctor 警告位）
  const f = path.join(PKG_ROOT, 'skills', role, 'SKILL.md');
  try {
    const m = fs.readFileSync(f, 'utf8').match(/^---\n([\s\S]*?)\n---/);
    const v = m?.[1].match(/^version:\s*(\S+)/m);
    return v?.[1] ?? 'unknown';
  } catch { return 'unknown'; }
}

/** 组装启动器（不 spawn）：返回 {launcher, cli, args, opts, stdinFile?} */
export function buildLauncher({ runner = 'fake', runnerCmd, model, bookPath, cwd, repo }) {
  if (runner === 'custom') {
    if (!runnerCmd) throw new Error('runner=custom 需要 runner-cmd（Profile 或 --runner-cmd）');
    if (Array.isArray(runnerCmd)) {
      // argv 形态（推荐）：逐参数占位替换，零 shell
      const args = runnerCmd.map((a) => String(a).replaceAll('{book}', bookPath).replaceAll('{cwd}', cwd ?? ''));
      if (!args.length) throw new Error('runner=custom 的 runner-cmd 数组为空');
      return { launcher: 'custom', cli: args[0], args: args.slice(1), opts: { cwd } };
    }
    // 字符串形态（兼容）：整串交给平台 shell——引号/重定向语义平台相关，跨平台请用数组形态
    const cmd = String(runnerCmd).replaceAll('{book}', JSON.stringify(bookPath)).replaceAll('{cwd}', JSON.stringify(cwd ?? ''));
    return { launcher: 'custom', cli: cmd.split(/\s+/)[0], cmd, opts: { cwd, shell: true }, shellForm: true };
  }
  if (runner === 'claude') {
    // 任务书走 stdin；附加参数经 runner-cmd 透传（字符串按空白切分，如 --dangerously-skip-permissions）
    const args = ['-p', '--output-format', 'json'];
    if (model) args.push('--model', model);
    args.push(...String(runnerCmd || '').split(/\s+/).filter(Boolean));
    return { launcher: 'claude', cli: 'claude', args, opts: { cwd }, stdinFile: bookPath };
  }
  if (runner === 'dsh') {
    // headless 读 `-` 为 stdin（0.2.2 实证；能力面见 hosts/dsh/README）
    const args = ['--profile', 'headless'];
    if (model) args.push('--model', model);
    // git 轨道任务：worktree 的 .git 文件指向 <repo>/.git/worktrees/<id>（工作区之外）——
    // dsh 官方推荐 --permission-mode workspace-write --add-dir <repo>/.git「grant shared Git
    // metadata for this task」，否则 commit 被沙箱拒绝（Cycle D 实测）。
    if (repo) {
      args.push('--permission-mode', 'workspace-write');
      args.push('--add-dir', path.join(repo, '.git'));
    }
    args.push('-');
    return { launcher: 'dsh', cli: 'dsh', args, opts: { cwd }, stdinFile: bookPath };
  }
  if (runner === 'fake') {
    return {
      launcher: 'fake', cli: process.execPath,
      args: [path.join(PKG_ROOT, 'core', 'programs', 'executors', 'fake.mjs')],
      opts: { cwd },
    };
  }
  throw new Error(`未知 runner "${runner}"（fake | custom | claude | dsh；Windows 上 dsh 在 WSL 内时用 custom + hosts/dsh/launcher/wsl-dsh.mjs）`);
}

/** 起执行器（异步、独立于本进程存亡）：转写 tee 进 runs/<n>/transcript.{out,err}；返回 pid。
 *  detached：Windows 上脱离派发者所属 Job（spawnSync 场景 job 关闭会连坐全部后代——实测复现）；
 *  POSIX 上新会话防终端关闭 SIGHUP——「独立于宿主进程存亡」的两平台正解。
 *  spawn 失败（ENOENT 等异步错误）写 transcript.err（不让 unhandled error 掀翻派发器）。 */
export function spawnExecutor({ launcher, runDir, env = {} }) {
  const outPath = path.join(runDir, 'transcript.out');
  const errPath = path.join(runDir, 'transcript.err');
  const out = fs.openSync(outPath, 'a');
  const err = fs.openSync(errPath, 'a');
  const common = { detached: true, env: { ...process.env, ...env }, windowsHide: true };
  let child;
  let stdin = 'ignore';
  try {
    if (launcher.stdinFile) stdin = fs.openSync(launcher.stdinFile, 'r');
    if (launcher.shellForm) child = spawn(launcher.cmd, { ...launcher.opts, ...common, stdio: [stdin, out, err] });
    else child = spawn(launcher.cli, launcher.args, { ...launcher.opts, ...common, stdio: [stdin, out, err] });
  } catch (e) {
    fs.closeSync(out); fs.closeSync(err);
    if (stdin !== 'ignore') fs.closeSync(stdin);
    throw e;
  }
  child.on('error', (e) => {
    try { fs.appendFileSync(errPath, `spawn error: ${e.message}\n`); } catch { /* 转写尽力而为 */ }
  });
  child.unref();
  fs.closeSync(out); fs.closeSync(err); // 子进程持有自己的句柄副本
  if (stdin !== 'ignore') fs.closeSync(stdin);
  return child.pid;
}

export function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM' || e.code === 'EACCES'; }
}
