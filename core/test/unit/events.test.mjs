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

// 事件流性质断言（docs/spec/events.md）：信封 / seq 全局单调跨分卷 / 封闭枚举 / 读回过滤
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, lastSeq, readEvents } from '../../lib/events.mjs';
import { resolveHome, paths } from '../../lib/home.mjs';
import { tmpdir } from '../helpers.mjs';

function freshHome() {
  return resolveHome(path.join(tmpdir(), 'home'));
}

test('信封：ts/seq/schemaVersion 自动补齐，seq 单调', () => {
  const home = freshHome();
  const e1 = appendEvent(home, { type: 'heartbeat.tick', actor: 'engine', gapMin: 0 });
  const e2 = appendEvent(home, { type: 'note.appended', actor: 'human', taskId: 'P-20261117-1', note: 'x' });
  assert.equal(e1.schemaVersion, 1);
  assert.ok(e1.ts && e2.ts);
  assert.equal(e2.seq, e1.seq + 1);
  assert.equal(lastSeq(home), e2.seq);
});

test('seq 跨分卷延续：伪造上月分卷高 seq', () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, 'events-2026-10.jsonl'), JSON.stringify({ ts: '2026-10-01T00:00:00Z', seq: 41, schemaVersion: 1, type: 'note.appended', actor: 'engine' }) + '\n');
  const e = appendEvent(home, { type: 'heartbeat.tick', actor: 'engine' });
  assert.equal(e.seq, 42);
});

test('封闭枚举：未知 type/actor 拒绝；--allow 不在本测试面（调用方责任）', () => {
  const home = freshHome();
  assert.throws(() => appendEvent(home, { type: 'custom.event', actor: 'engine' }), /unknown type/);
  assert.throws(() => appendEvent(home, { type: 'note.appended', actor: 'stranger' }), /unknown actor/);
});

test('读回：类型过滤 + 未知 type 前向兼容（消费方忽略）+ 损坏行跳过', () => {
  const home = freshHome();
  appendEvent(home, { type: 'heartbeat.tick', actor: 'engine' });
  appendEvent(home, { type: 'dispatched', actor: 'engine', taskId: 'P-1', family: 'subprocess' });
  const vol = paths(home).eventsVolume('2026-11');
  fs.appendFileSync(vol, '{"broken json\n');
  fs.appendFileSync(vol, JSON.stringify({ ts: '...', seq: 99, schemaVersion: 1, type: 'future.type', actor: 'engine' }) + '\n');
  const all = readEvents(home);
  assert.equal(all.length, 3); // 损坏行跳过，未知 type 保留（消费方自行过滤）
  assert.equal(all.malformed, 1);
  const ticks = readEvents(home, { types: ['heartbeat.tick'] });
  assert.equal(ticks.length, 1);
});
