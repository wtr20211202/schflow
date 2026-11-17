#!/usr/bin/env node

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

// hosts/dsh · Windows → WSL 启动桥（宿主包资产，非 core 内置）：宿主是 Windows、dsh 装在 WSL 内时
// 的「执行器启动器」——node 参数数组直传 wsl.exe（零 shell，绕开 cmd.exe 引号/重定向不可移植语义），
// WSL 内转路径 + 凭据 env 注入 + heredoc 任务书喂 dsh stdin。
//
// Profile 用法（argv 数组形态，推荐）：
//   runner: custom
//   runner-cmd: ["node", "<schflow>/hosts/dsh/launcher/wsl-dsh.mjs", "{book}"]
// 环境契约沿用 SCHFLOW_*（worktree/runDir/taskId 由 dispatch 注入）。
// 可选：SCHFLOW_DSH_BIN（缺省 /usr/bin/dsh——注意 WSL 双安装旧件在 /usr/local/bin）、SCHFLOW_WSL_DISTRO。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const book = process.argv[2];
const worktree = process.env.SCHFLOW_WORKTREE || '';
const runDir = process.env.SCHFLOW_RUN_DIR || '';
const DSH = process.env.SCHFLOW_DSH_BIN || '/usr/bin/dsh';
const DISTRO = process.env.SCHFLOW_WSL_DISTRO || 'Ubuntu-24.04';

if (!book || !fs.existsSync(book)) {
  console.error('dsh-wsl: missing task book');
  process.exit(2);
}
const wslBook = winToWsl(book);
const wslWt = worktree ? winToWsl(worktree) : '';
const body = fs.readFileSync(book, 'utf8');

// 任务书头部追加 WSL 运行环境备注（书内路径为 Windows 形态，WSL 侧需等价转换）
const prelude = [
  '## 运行环境备注（dsh-wsl 适配器注入）',
  wslWt ? `- 你运行在 Linux 子环境（WSL）中；任务书中的 worktree Windows 路径等价于：\n  ${wslWt}（请使用此路径，cd 进去干活）` : '- 本任务无 worktree（非 git 轨道）',
  `- result.json 的 WSL 写入路径：${path.posix.join(winToWsl(runDir), 'result.json')}（tmp+rename 原子写）`,
  repo ? `- 已授权 ${winToWsl(repo)}/.git 进 workspace-write：可在 worktree 内正常 git commit；不要 push，不要创建新的 git worktree。` : '- git 提交身份沿用仓库既有配置；不要 push。',
  '',
].join('\n');

// 转义：任务书全文经 stdin 喂入（heredoc 定界符防冲突）
const taskText = prelude + body;
const delim = 'SCHFLOW_EOF_' + Date.now();
// git 轨道任务：把 <repo>/.git 授权进 workspace-write（dsh 官方推荐形态——
// 「grant shared Git metadata for this task」），否则 worktree 的 .git 元数据在沙箱外、commit 被拒。
const repo = process.env.SCHFLOW_REPO || '';
const grant = repo ? ` --permission-mode workspace-write --add-dir '${winToWsl(repo)}/.git'` : '';
const wsh = [
  `export DEEPSEEK_API_KEY=$(awk '/^refs:/{f=1} f && /DEEPSEEK_API_KEY/{print $2}' /root/.dsh/.credentials.yaml 2>/dev/null || true)`,
  `cat <<'${delim}' | ${DSH} --profile headless${grant} - 2>&1`,
  taskText,
  delim,
].join('\n');

const child = spawn('wsl.exe', ['-d', DISTRO, '-e', 'bash', '-lc', wsh], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));

function winToWsl(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
}
