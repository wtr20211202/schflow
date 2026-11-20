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

// 假执行器（M2 纪律：确定性主干可测性与 LLM 解耦）：custom 适配器形态的确定性脚本。
// 环境：SCHFLOW_RUN_DIR / SCHFLOW_TASK_DIR / SCHFLOW_WORKTREE / SCHFLOW_TASK_ID / SCHFLOW_FAKE_MODE。
// 模式：done(默认) | blocked | stale | dirty | crash | secret | hang。幂等重入：已有等价提交→原样返回。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const runDir = process.env.SCHFLOW_RUN_DIR;
const taskDir = process.env.SCHFLOW_TASK_DIR;
const worktree = process.env.SCHFLOW_WORKTREE || '';
const id = process.env.SCHFLOW_TASK_ID || 'P-UNKNOWN';
const mode = process.env.SCHFLOW_FAKE_MODE || 'done';
const delay = Number(process.env.SCHFLOW_FAKE_DELAY_MS || '0');
// secret 模式夹具（P10「泄漏必拦」用）：合成形态、非公开文档示例值，运行时拼装——
// 源码中不得出现连续 AKIA 形态字面量，否则本文件的增量 diff 会被自身出口扫描拦下
// （P-20261120-6 合并期自指误报）。运行时值与 run1 完全一致。
const FAKE_AWS_KEY = ['AKIA', 'Z7Q3XK9MNBVC2PLR'].join('');
const git = (args, opts = {}) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true, ...opts });

if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);

function writeResult(obj) {
  // 原子写（tmp+rename）：折叠程序不会读到半行 JSON——真实执行器同此契约（docs/spec/result.md）
  const file = path.join(runDir, 'result.json');
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

if (mode === 'crash') process.exit(3);
if (mode === 'hang') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 60_000); process.exit(0); }
if (mode === 'blocked') { writeResult({ status: 'blocked', summary: 'fake blocked：缺前置条件（演示）' }); process.exit(0); }
if (mode === 'stale') { writeResult({ status: 'stale', summary: 'fake stale：基准已漂移（演示）', freshness: 'stale' }); process.exit(0); }
if (mode === 'dirty') {
  if (worktree) fs.writeFileSync(path.join(worktree, 'uncommitted.txt'), 'dirty tree（演示）\n');
  writeResult({ status: 'dirty', summary: 'fake dirty：工作树有非预期未提交改动，未动' });
  process.exit(0);
}

// done / secret：git 轨道=提交；非 git=落 deliverables
if (worktree) {
  // 幂等重入（ADR-0023）：等价提交已存在→原样返回
  const found = git(['-C', worktree, 'log', '--grep', `(${id})`, '-1', '--format=%H']);
  if (found.status === 0 && found.stdout.trim()) {
    writeResult({ status: 'done', summary: `fake done（幂等重入：复用已有提交）`, commit: found.stdout.trim() });
    process.exit(0);
  }
  const file = mode === 'secret' ? 'creds.txt' : path.join('fake', `${id}.md`);
  const content = mode === 'secret'
    // 合成形态（非公开文档示例值）：出口扫描 allowlist 只放行 AWS 文档示例，
    // 这里必须用未放行的值——否则 P10「泄漏必拦」路径被 allowlist 遮蔽而失去意义。
    ? `aws_key = ${FAKE_AWS_KEY}\n`
    : `# fake deliverable for ${id}\n\n由假执行器生成的演示产物。\n`;
  fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
  fs.writeFileSync(path.join(worktree, file), content);
  let r = git(['-C', worktree, 'add', '-A']);
  if (r.status !== 0) { writeResult({ status: 'blocked', summary: `fake: git add 失败 ${r.stderr}` }); process.exit(0); }
  r = git(['-C', worktree, 'commit', '-m', `feat: fake implement ${id} (${id})`]);
  if (r.status !== 0) {
    writeResult({ status: 'dirty', summary: `fake: git commit 失败（可能无身份配置/净树）${(r.stderr || '').slice(0, 200)}` });
    process.exit(0);
  }
  const sha = git(['-C', worktree, 'rev-parse', 'HEAD']).stdout.trim();
  fs.writeFileSync(path.join(runDir, 'output.md'), `fake executor: committed ${sha}\n`);
  writeResult({ status: 'done', summary: `fake done: 提交 ${sha.slice(0, 10)}`, commit: sha });
  process.exit(0);
}

// 非 git 轨道：交付物落任务目录 deliverables/（docs/investigate/research 形态）
const rel = `deliverables/report-${id}.md`;
fs.mkdirSync(path.join(taskDir, 'deliverables'), { recursive: true });
fs.writeFileSync(path.join(taskDir, rel), `# 报告 · ${id}\n\n假执行器演示报告：结论——一切正常（演示）。\n`);
fs.writeFileSync(path.join(runDir, 'output.md'), `fake executor: wrote ${rel}\n`);
writeResult({ status: 'done', summary: `fake done: 报告 ${rel}`, deliverables: [{ path: rel, type: 'report' }] });
