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

// gitutil 子进程缓冲上限（P-20261120-5）：merge ④ 出口扫描取完整 diff 文本做 secret 扫描，
// 大变更集超 Node 默认 1MB 会 ENOBUFS 掀翻合并队列——git() 缺省 64MB；超限须给可读错误
// （明确「输出超过缓冲上限」，不得误报成 PATH 问题）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { git, GIT_MAX_BUFFER } from '../../lib/gitutil.mjs';
import { mkToyRepo, tmpdir } from '../helpers.mjs';

test('缓冲上限常量：GIT_MAX_BUFFER = 64MB', () => {
  assert.equal(GIT_MAX_BUFFER, 64 * 1024 * 1024);
});

test('>1MB diff 真机复现：约 2MB 新增文件的 diff 全量返回不抛错（修复前必 ENOBUFS）', () => {
  const repo = mkToyRepo(tmpdir('schflow-gitutil-big-'));
  // 每行 80 字节（79 字符 + LF），26214 行 ≈ 2.0MB；末尾哨兵行证明输出未被截断在前 1MB
  const line = `${'y'.repeat(79)}\n`;
  const lineCount = 26_214;
  const sentinel = 'TAIL-SENTINEL-2MB-END';
  fs.writeFileSync(path.join(repo, 'big.txt'), line.repeat(lineCount) + `${sentinel}\n`);
  git(repo, ['add', '--', 'big.txt']);
  git(repo, ['commit', '-m', 'test: 2MB 大文件']);

  const diff = git(repo, ['diff', 'HEAD^', 'HEAD']).stdout;
  assert.ok(diff.length > 2 * 1024 * 1024, `diff 应超 2MB，实为 ${diff.length} 字节`);
  assert.ok(diff.includes(`+${sentinel}`), '尾部哨兵行必须出现在 diff 中（证明非前 1MB 截断）');
  assert.equal(diff.split('\n').filter((l) => l === `+${'y'.repeat(79)}`).length, lineCount, '新增行应逐行齐全');
});

test('ENOBUFS 分支：小 maxBuffer 抛可读错误（明示缓冲上限，不误导为 PATH 问题）', () => {
  const repo = mkToyRepo(tmpdir('schflow-gitutil-enobufs-'));
  let err = null;
  try {
    git(repo, ['log', '--oneline'], { maxBuffer: 16 });
  } catch (e) {
    err = e;
  }
  assert.ok(err, '超出 maxBuffer 必须抛错');
  assert.match(err.message, /输出超过缓冲上限/);
  assert.match(err.message, /ENOBUFS/);
  assert.ok(!err.message.includes('git 是否在 PATH'), '不得误报成 PATH 问题');
});
