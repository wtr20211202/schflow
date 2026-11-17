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

// event --list 事件回放查询（docs/spec/programs.md）：按分卷顺序回放 + --type/--task 过滤 +
// --last 尾取；人读一行一条（seq ts type taskId 摘要字段，taskId 缺位显 -）、--json 对象数组；
// 与追加模式互斥（同给 --list 与 --body-file = exit 2）；只读不取锁（外部持锁照常查询）；
// --last 非法值 exit 76。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent } from '../../lib/events.mjs';
import { resolveHome, paths } from '../../lib/home.mjs';
import { run, tmpdir } from '../helpers.mjs';

test('event --list：跨卷回放/过滤/last/空结果/互斥/只读', () => {
  const dir = tmpdir();
  const home = resolveHome(path.join(dir, 'home'));

  // 跨卷排序：伪造上月分卷两笔（seq 1~2），本卷追加以 3 起步
  fs.writeFileSync(path.join(home, 'events-2026-10.jsonl'),
    JSON.stringify({ ts: '2026-10-01T00:00:00.000Z', seq: 1, schemaVersion: 1, type: 'task.created', actor: 'proposer', taskId: 'P-20261031-1' }) + '\n' +
    JSON.stringify({ ts: '2026-10-02T00:00:00.000Z', seq: 2, schemaVersion: 1, type: 'merge.failed', actor: 'engine', taskId: 'P-20261031-1', branch: 'schflow/P-20261031-1', reason: 'conflict' }) + '\n');
  const e3 = appendEvent(home, { type: 'merge.done', actor: 'engine', taskId: 'P-20261117-9', branch: 'schflow/P-20261117-9', sha: 'abc1234' });
  const e4 = appendEvent(home, { type: 'merge.done', actor: 'engine', taskId: 'P-20261117-8', branch: 'schflow/P-20261117-8', sha: 'def5678' });
  const e5 = appendEvent(home, { type: 'heartbeat.tick', actor: 'engine', gapMin: 0 });

  // 全量回放：分卷顺序（旧卷在前）一行一条，seq 全程单调；无载荷字段行尾无残段
  const lines = run('event', ['--list'], { home }).stdout.trimEnd().split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[0], '1 2026-10-01T00:00:00.000Z task.created P-20261031-1');
  assert.equal(lines[2], `${e3.seq} ${e3.ts} merge.done P-20261117-9 branch=schflow/P-20261117-9 sha=abc1234`);
  assert.ok(lines.map((l) => Number(l.split(' ')[0])).every((s, i, a) => i === 0 || s > a[i - 1]), 'seq 单调');
  // taskId 缺位显 -；摘要字段 k=v 逐对呈现
  assert.equal(lines[4], `${e5.seq} ${e5.ts} heartbeat.tick - gapMin=0`);

  // --type 单值与逗号多值（多值取 merge.failed+merge.done：跨卷命中，兼顾分卷维度）
  assert.equal(run('event', ['--list', '--type', 'merge.done'], { home }).stdout.trimEnd().split('\n').length, 2);
  assert.equal(run('event', ['--list', '--type', 'merge.failed,merge.done'], { home }).stdout.trimEnd().split('\n').length, 3);

  // --task 过滤 + 摘要字段
  const taskLines = run('event', ['--list', '--task', 'P-20261117-8'], { home }).stdout.trimEnd().split('\n');
  assert.equal(taskLines.length, 1);
  assert.equal(taskLines[0], `${e4.seq} ${e4.ts} merge.done P-20261117-8 branch=schflow/P-20261117-8 sha=def5678`);

  // --last 尾取（作用于过滤后序列）
  const lastLines = run('event', ['--list', '--last', '2'], { home }).stdout.trimEnd().split('\n');
  assert.equal(lastLines.length, 2);
  assert.ok(lastLines[0].startsWith(`${e4.seq} `), 'last 取尾');
  assert.equal(run('event', ['--list', '--task', 'P-20261031-1', '--last', '1'], { home }).stdout.trim(),
    `2 2026-10-02T00:00:00.000Z merge.failed P-20261031-1 branch=schflow/P-20261031-1 reason=conflict`);

  // --json：对象数组（过滤后仍按回放序，对象原样含信封字段）
  assert.deepEqual(run('event', ['--list', '--task', 'P-20261117-9', '--json'], { home }).json, [e3]);

  // 空结果：人读一行提示、--json 空数组
  assert.equal(run('event', ['--list', '--task', 'P-none'], { home }).stdout.trim(), 'event: 无匹配事件');
  assert.deepEqual(run('event', ['--list', '--task', 'P-none', '--json'], { home }).json, []);

  // 互斥：--list 与 --body-file 同给 = exit 2（追加面本身不触发）
  const bodyFile = path.join(dir, 'evt.json');
  fs.writeFileSync(bodyFile, JSON.stringify({ type: 'note.appended', actor: 'human', taskId: 'P-x' }));
  assert.equal(run('event', ['--list', '--body-file', bodyFile], { home, expectFail: true }).code, 2);

  // --last 非法值 = exit 76
  assert.equal(run('event', ['--list', '--last', 'abc'], { home, expectFail: true }).code, 76);
  assert.equal(run('event', ['--list', '--last', '-1'], { home, expectFail: true }).code, 76);

  // 只读不取锁：外部持有写锁时追加面 75，--list 照常
  // （holder pid 必须是活进程——acquireLock 以 pid 活性鉴别真持有 vs 幽灵残留，死 pid 会被立即偷移）
  fs.mkdirSync(path.join(home, 'state', 'locks', 'write.lock'));
  fs.writeFileSync(path.join(home, 'state', 'locks', 'write.lock', 'holder.json'), JSON.stringify({ pid: process.pid }));
  assert.equal(run('event', ['--body-file', bodyFile], { home, expectFail: true }).code, 75);
  assert.equal(run('event', ['--list', '--last', '1'], { home }).stdout.trim(),
    `${e5.seq} ${e5.ts} heartbeat.tick - gapMin=0`);

  // 损坏行：跳过不炸，人读尾部如实注记
  fs.appendFileSync(paths(home).eventsVolume('2026-11'), '{"broken\n');
  const withBroken = run('event', ['--list', '--last', '1'], { home });
  assert.match(withBroken.stdout, /heartbeat\.tick/);
  assert.match(withBroken.stdout, /# 跳过损坏行 1/);
  assert.deepEqual(run('event', ['--list', '--json'], { home }).json.length, 5, '损坏行不入数组');
});
