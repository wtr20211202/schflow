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

// next-id --peek 只读预告：不递增计数（文件不存在也不落盘）、连续 peek 同值、真取号后顺延、
// 不取写锁（外部持锁时取号 75 而 peek 照常）、坏计数文件如实报错不静默修正。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir } from '../helpers.mjs';
import { ymd } from '../../lib/home.mjs';

test('next-id --peek：只读预告，不消耗计数', () => {
  const home = tmpdir('schflow-test-nextid-');
  const today = ymd();
  const counterFile = path.join(home, 'state', 'id-counter.json');
  const first = `P-${today}-1`;

  // 空 HOME：预告 -1，且不落计数文件（未消耗）
  assert.equal(run('next-id', ['--peek'], { home }).stdout.trim(), first);
  assert.equal(run('next-id', ['--peek'], { home }).stdout.trim(), first, '连续 peek 同值');
  assert.equal(fs.existsSync(counterFile), false, 'peek 不写计数文件');

  // 真取号一次得 1；peek 顺延预告 2，计数仍为 1
  assert.equal(run('next-id', [], { home }).stdout.trim(), first);
  assert.equal(run('next-id', ['--peek'], { home }).stdout.trim(), `P-${today}-2`, '真取号后 peek 顺延');
  assert.equal(JSON.parse(fs.readFileSync(counterFile, 'utf8')).last, 1, 'peek 未递增计数');

  // 外部持有写锁：取号 exit 75，peek 只读不受影响
  // （holder pid 必须是活进程——acquireLock 以 pid 活性鉴别真持有 vs 幽灵残留，死 pid 会被立即偷移）
  fs.mkdirSync(path.join(home, 'state', 'locks', 'write.lock'));
  fs.writeFileSync(path.join(home, 'state', 'locks', 'write.lock', 'holder.json'), JSON.stringify({ pid: process.pid }));
  assert.equal(run('next-id', [], { home, expectFail: true }).code, 75);
  assert.equal(run('next-id', ['--peek'], { home }).stdout.trim(), `P-${today}-2`, '写锁被持有时 peek 仍可用');

  // --json 输出形态与取号一致（含 home 身份字段）
  assert.deepEqual(run('next-id', ['--peek', '--json'], { home }).json, { id: `P-${today}-2`, date: today, seq: 2, home });

  // 坏计数文件：peek 如实报错（非 0），原样保留不修正
  fs.writeFileSync(counterFile, '{broken json');
  assert.notEqual(run('next-id', ['--peek'], { home, expectFail: true }).code, 0, '坏文件必须报错');
  assert.equal(fs.readFileSync(counterFile, 'utf8'), '{broken json', '坏文件原样保留');
});
