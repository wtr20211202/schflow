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

// 八程序① next-id：HOME 级原子取号 P-YYYYMMDD-N（programs.md：锁忙 exit 75）。
// 载体 state/id-counter.json；跨日重置；与旧流水线取号脚本双跑期各自独立 ID 空间（§4.2）。
// --peek：只读预告下一个号（date 滚动语义照常：当日已计数 N 则预告 N+1，跨日/无记录预告 -1）——
// 不取写锁、不写计数文件；坏计数文件如实报错，绝不静默修正。
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { resolveHome, paths, ymd } from '../lib/home.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { atomicWriteJson } from '../lib/atomic.mjs';
import { emit, die, EXIT } from '../lib/out.mjs';

const { values } = parseArgs({
  options: { home: { type: 'string' }, json: { type: 'boolean' }, peek: { type: 'boolean' } },
});
const home = resolveHome(values.home);
const p = paths(home);

function readCounter() {
  if (!fs.existsSync(p.idCounter)) return { date: '', last: 0 };
  try {
    return JSON.parse(fs.readFileSync(p.idCounter, 'utf8'));
  } catch (e) {
    die(EXIT.FAIL, { text: `next-id: 计数文件损坏，拒绝${values.peek ? '预告' : '取号'}（${p.idCounter}）：${e.message}` });
  }
}

if (values.peek) {
  const counter = readCounter();
  const today = ymd();
  const seq = counter.date === today ? counter.last + 1 : 1;
  const id = `P-${today}-${seq}`;
  emit({ json: values.json ? { id, date: today, seq } : null, text: values.json ? '' : id });
} else {
  const lock = acquireLock(p.writeLock);
  if (!lock) die(EXIT.BUSY, { text: 'next-id: HOME 写锁忙（另一程序在写）——稍后重试' });
  try {
    let counter = readCounter();
    const today = ymd();
    if (counter.date !== today) counter = { date: today, last: 0 };
    counter.last += 1;
    atomicWriteJson(p.idCounter, counter);
    const id = `P-${today}-${counter.last}`;
    emit({ json: values.json ? { id, date: today, seq: counter.last } : null, text: values.json ? '' : id });
  } finally {
    lock.release();
  }
}
