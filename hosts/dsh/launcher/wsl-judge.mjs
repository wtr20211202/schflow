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

// hosts/dsh · Windows → WSL 裁决桥（judge② L2 专用，宿主包资产，非 core 内置）：宿主是 Windows、
// dsh 装在 WSL 内时，merge --judge-resolve 的裸 argv（--judge-runner dsh）在 Windows node 下解析不到
// dsh——本桥补这条链：node 参数直传 wsl.exe（零 shell，绕开 cmd.exe 引号/重定向不可移植语义），
// WSL 内凭据 env 注入 + heredoc 提示词全文喂 dsh stdin，stdout 即裁决输出面（conflicto 从中提取 JSON）。
// 与 wsl-dsh.mjs（任务书执行桥）的差异：无任务书前置 prelude（提示词全文即输入，不注 worktree/
// result.json 噪声——裁决提示词直接消费）；不加 --permission-mode/--add-dir（裁决器只读只答不落盘）。
//
// 用法示例（merge 侧 custom runner，argv 数组形态）：
//   merge --judge-resolve --judge-runner custom \
//     --judge-runner-cmd '["node","<schflow>/hosts/dsh/launcher/wsl-judge.mjs","{prompt}"]'
// 环境契约沿用 SCHFLOW_*：SCHFLOW_DSH_BIN（缺省 /usr/bin/dsh——注意 WSL 双安装旧件在 /usr/local/bin）、
// SCHFLOW_WSL_DISTRO（缺省 Ubuntu-24.04）。
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const promptFile = process.argv[2];
const DSH = process.env.SCHFLOW_DSH_BIN || '/usr/bin/dsh';
const DISTRO = process.env.SCHFLOW_WSL_DISTRO || 'Ubuntu-24.04';

if (!promptFile || !fs.existsSync(promptFile)) {
  console.error('wsl-judge: missing prompt file');
  process.exit(2);
}

// 提示词全文经 stdin 喂入（heredoc 定界符防冲突，同 wsl-dsh.mjs 款——但本桥不并流 2>&1：
// dsh 契约 answer→stdout、reasoning→stderr，wsl.exe 自身的 UTF-16 警告也走 stderr——分开后
// stdout 答案通道纯净，stderr 混流物由上游 spawnSync 收进 r.stderr 不污染裁决提取面）
const promptText = fs.readFileSync(promptFile, 'utf8');
const delim = 'SCHFLOW_EOF_' + Date.now();
const wsh = [
  `export DEEPSEEK_API_KEY=$(awk '/^refs:/{f=1} f && /DEEPSEEK_API_KEY/{print $2}' /root/.dsh/.credentials.yaml 2>/dev/null || true)`,
  `cat <<'${delim}' | ${DSH} --profile headless -`,
  promptText,
  delim,
].join('\n');

const child = spawn('wsl.exe', ['-d', DISTRO, '-e', 'bash', '-lc', wsh], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
