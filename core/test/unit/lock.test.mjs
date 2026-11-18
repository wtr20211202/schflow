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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireLock } from '../../lib/lock.mjs';
import { pidAlive } from '../../lib/runner.mjs';
import { tmpdir, sleep } from '../helpers.mjs';

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

// —— pid 活性三态（P-20261118-7）：spawn 真子进程钉死「活=忙 / 死=立即偷 / 无 holder=崩溃残留」
//    鉴别契约（v1.0.24 Windows delete-pending 实证的回归钉）。held 表是模块级 Map：
//    各用例锁目录路径互不相同，防进程内串扰。

/** 起一个长睡 node 子进程（活 pid 夹具）；返回 child（调用方负责收尾 kill） */
function spawnSleeper() {
  return spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
}

/** 轮询等待 pid 确死（Windows TerminateProcess 异步完成，kill 返回≠句柄即刻消失） */
async function waitDead(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) await sleep(50);
  return !pidAlive(pid);
}

test('锁三态①：活 pid 持有=忙（不偷，真持有者仍在临界区）', async () => {
  const dir = path.join(tmpdir(), 'alive-holder.lock');
  const child = spawnSleeper();
  try {
    assert.ok(pidAlive(child.pid), '夹具前置：子进程活着');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'holder.json'), JSON.stringify({ pid: child.pid }));
    // mtime 新鲜 + holder 活 → 必须返回 null（忙）；活持有者不得因陈旧窗短而被偷
    assert.equal(acquireLock(dir, { staleMs: 60_000 }), null, '活 pid 持有=忙，不得偷');
  } finally {
    child.kill();
    await once(child, 'exit'); // 兜底收尾：不留泄漏子进程
  }
});

test('锁三态②：死 pid 残留=立即偷（不等 10min 陈旧窗）', async () => {
  const dir = path.join(tmpdir(), 'dead-holder.lock');
  const child = spawnSleeper();
  const deadPid = child.pid;
  child.kill();
  await once(child, 'exit');
  assert.ok(await waitDead(deadPid), '夹具前置：被杀 pid 已死');

  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'holder.json'), JSON.stringify({ pid: deadPid })); // mtime 新鲜
  const t0 = Date.now();
  const h = acquireLock(dir, { staleMs: 10 * 60_000 }); // 按陈旧窗逻辑应忙——pid 活性坐实残留即偷
  assert.ok(h, '死 pid → 崩溃/幽灵残留坐实，立即偷移');
  assert.ok(Date.now() - t0 < 5_000, '不得等待陈旧窗（staleMs=10min）');
  h.release();
  assert.equal(fs.existsSync(dir), false, '偷移后目录清走');
});

test('锁三态③：无 holder + 宽限窗（>1.5s）已过=崩溃残留，偷', () => {
  const dir = path.join(tmpdir(), 'no-holder.lock');
  fs.mkdirSync(dir); // 不放 holder.json——真持有者 mkdir→栽 holder 是毫秒窗，宽限过后仍无=崩溃残留
  const old = new Date(Date.now() - 2_000);
  fs.utimesSync(dir, old, old); // 回填 mtime 到 2s 前（>1.5s 宽限）
  const h = acquireLock(dir, { staleMs: 10 * 60_000 });
  assert.ok(h, '宽限窗已过仍无 holder → 偷锁成功');
  h.release();
});

test('锁：release 清理 held 表，同路径可重取', () => {
  const dir = path.join(tmpdir(), 'reacquire.lock');
  const h1 = acquireLock(dir);
  assert.ok(h1);
  h1.release();
  assert.equal(fs.existsSync(dir), false, '释放即清目录');
  const h2 = acquireLock(dir); // held 表已清——走全新获取而非复用旧句柄
  assert.ok(h2, 'release 后同路径可重取');
  assert.notEqual(h2, h1, '新句柄，非进程内重入复用');
  h2.release();
});
