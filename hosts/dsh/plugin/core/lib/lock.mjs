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

// mkdir O_EXCL 目录锁（§17.4：现流水线实证形态——「锁目录存在 ≠ 我持有」由创建成功钉住）。
// 同进程重入=直接复用（程序内先取 HOME 写锁，内部 appendEvent 等不再重复取）。
// 陈旧判定 >10min（§15 风险表）：偷锁=改名移走后重建，绝不删他者正在写的临界数据之外的东西。
// Windows 附加现实（v1.0.24 实测）：rmSync「成功」≠ 名字即刻消失——delete-pending 幽灵可带完整
// holder.json 在删除队列滞留数秒，仅凭 mtime 会把幽灵判成「忙」。鉴别锚=holder 的 pid 活性：
// 持有进程死 → 残留坐实（幽灵/崩溃 holder），立即偷移；活 → 原 mtime 逻辑（新鲜=忙/陈旧=偷）。
import fs from 'node:fs';
import path from 'node:path';
import { pidAlive } from './runner.mjs';

const held = new Map(); // resolvedPath -> handle（进程内重入表）

const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function readHolder(lockDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(lockDir, 'holder.json'), 'utf8'));
    return Number.isFinite(j.pid) ? { pid: j.pid } : null;
  } catch { return null; } // 无 holder / 半截（真持有者 mkdir→栽 holder 的毫秒窗，或崩溃残留）
}

export function acquireLock(lockDir, { staleMs = 10 * 60_000, onSteal = null } = {}) {
  const key = path.resolve(lockDir);
  if (held.has(key)) return held.get(key);
  for (let attempt = 0; ; attempt++) {
    if (tryMkdir(lockDir)) break; // 锁创建成功=持有
    const holder = readHolder(lockDir);
    let st = null;
    try { st = fs.statSync(lockDir); } catch { /* 幽灵转瞬即散：睡一拍重试 */ }
    if (holder && pidAlive(holder.pid)) {
      // 活持有者：原逻辑——新鲜=忙（正常忙等语义）/ 陈旧=偷移
      if (st && Date.now() - st.mtimeMs <= staleMs) return null;
      if (!stealDir(lockDir, st?.mtimeMs ?? Date.now(), onSteal)) return null; // 偷锁竞态失败：视为忙
      continue;
    }
    // holder pid 已死（幽灵/崩溃持有）或无 holder：前者坐实即偷；后者等宽限（真持有者栽 holder
    // 在毫秒级，绝无半秒空窗）——宽限过后仍无 holder = 崩溃残留，同款偷移。
    const ghostForMs = st ? Date.now() - st.mtimeMs : 0;
    if (holder || ghostForMs > 1500 || attempt >= 29) {
      stealDir(lockDir, st?.mtimeMs ?? Date.now(), onSteal); // 偷移失败也重试 mkdir（对端可能已自行清走）
      if (attempt >= 44) return null; // 持续不可诊断 → 忙（fail-closed，不无限打转）
      continue;
    }
    sleepSync(100);
  }
  const handle = {
    dir: lockDir,
    release() {
      if (held.get(key) !== this) return;
      held.delete(key);
      // Windows 现实：刚写完 holder.json 的目录会被 AV/索引器瞬时握住句柄，rmSync 偶发 EBUSY/EPERM——
      // 短退避重试几拍；仍失败就放弃（临界区内状态写早已 tmp+rename 提交，绝不能因清扫掀翻进程）。
      // 残留由 acquire 侧兜底：holder pid 已死 → 立即判幽灵偷移，不忙等。
      for (let attempt = 0; ; attempt++) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); return; }
        catch (e) {
          if (attempt >= 4) return;
          sleepSync(50 * (attempt + 1));
        }
      }
    },
  };
  fs.writeFileSync(path.join(lockDir, 'holder.json'), JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
  held.set(key, handle);
  return handle;
}

function tryMkdir(dir) {
  try {
    fs.mkdirSync(dir);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

/** 陈旧/幽灵锁偷移（改名移走后删，绝不直删他者临界区内容）；成功=false 失败由调用方定语义 */
function stealDir(lockDir, originalMtimeMs, onSteal) {
  const junk = `${lockDir}.stale-${Date.now()}`;
  try {
    fs.renameSync(lockDir, junk);
    fs.rmSync(junk, { recursive: true, force: true });
    if (onSteal) onSteal(originalMtimeMs);
    return true;
  } catch {
    return false; // 偷锁竞态失败：调用方视为忙，稍后重试
  }
}

/** 长临界区保鲜（tick 持锁期间周期调用刷新 mtime，防被偷） */
export function refreshLock(handle) {
  if (!handle) return;
  const now = new Date();
  try { fs.utimesSync(handle.dir, now, now); } catch { /* 已释放/被偷：忽略 */ }
}
