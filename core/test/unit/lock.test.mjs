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

// 锁性质断言：互斥 / 同进程重入 / 陈旧偷锁 / 释放后再取
// 「忙」语义的测试用外部持有者模拟（直接 mkdir 预置锁目录）——同进程重入按设计返回句柄而非忙。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock } from '../../lib/lock.mjs';
import { tmpdir } from '../helpers.mjs';

function foreignLock(dir, ageMs = 0) {
  fs.mkdirSync(dir);
  // holder pid 必须是活进程（本测试进程自身）——acquireLock 以 pid 活性鉴别「真持有 vs 幽灵残留」
  fs.writeFileSync(path.join(dir, 'holder.json'), JSON.stringify({ pid: process.pid }));
  if (ageMs) {
    const old = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, old, old);
  }
}

test('锁：创建成功=持有；外部持有=忙；释放后可再取', () => {
  const dir = path.join(tmpdir(), 'a.lock');
  const h1 = acquireLock(dir, { staleMs: 60_000 });
  assert.ok(h1, '空位应取到');
  h1.release();
  foreignLock(dir); // 模拟他者持有（新鲜）
  assert.equal(acquireLock(dir, { staleMs: 60_000 }), null, '外部新鲜持有=忙');
});

test('锁：同进程重入=复用同一句柄（appendEvent 内嵌取锁的前提）', () => {
  const dir = path.join(tmpdir(), 'b.lock');
  const h1 = acquireLock(dir);
  const h2 = acquireLock(dir);
  assert.equal(h1, h2);
  h1.release();
  assert.equal(fs.existsSync(dir), false);
});

test('锁：陈旧（>staleMs）被偷走，新鲜的不偷', () => {
  const dir = path.join(tmpdir(), 'c.lock');
  foreignLock(dir, 60_000); // 1 分钟前的外部持有者
  const h2 = acquireLock(dir, { staleMs: 10 });
  assert.ok(h2, '陈旧锁应被偷');
  h2.release();

  const dir2 = path.join(tmpdir(), 'd.lock');
  foreignLock(dir2, 1_000); // 1 秒前=新鲜
  assert.equal(acquireLock(dir2, { staleMs: 60_000 }), null, '新鲜锁不得偷');
});

test('锁：holder pid 已死的残留（Windows delete-pending 幽灵/崩溃 holder）立即偷移，不忙等', () => {
  const dir = path.join(tmpdir(), 'e.lock');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'holder.json'), '{"pid":999999}'); // 不存在的 pid=死持有（幽灵/崩溃残留形态）
  const h = acquireLock(dir, { staleMs: 60_000 });
  assert.ok(h, 'holder pid 已死 → 残留坐实，立即偷移（而非按新鲜 mtime 忙等）');
  h.release();
  assert.equal(fs.existsSync(dir), false, '偷移后目录清走');
});
