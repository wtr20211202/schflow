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

// phase-group 会话折叠（P-20261121-3 B）——真派发路径（不调 LLM）：
// fixtures/capture-spawn.cjs 以 node --require 预载，拦截 child_process.spawn 把 argv 落文件
// （被拦截的 dsh/claude 二进制不存在 → 子进程 ENOENT，不影响 argv 断言；fold 用 --force 模拟中断）。
// 断言面：
//  ① dsh 恒传确定性 id `--session-id schflow-<id>`（run1 也传；run2 resumed=true）；
//  ② native（--no-spawn）零会话账本（没有独立会话可续）；
//  ③ claude 重派从上一 run transcript.out 提取 session_id → `--resume`；
//  ④ 上一 run resumeFailed=true（fold 折 interrupted 时的回落信号）→ 不续、session.json 记 resumed:false；
//  ⑤ phase-group 关闭 → 与既有行为等价（无 --session-id/无 session.json/事件无 session 字段）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, tmpdir, addTask, writeProfile, PROG, PKG_ROOT } from '../helpers.mjs';
import { findTaskDir, loadCard, saveCard } from '../../lib/store.mjs';
import { readEvents } from '../../lib/events.mjs';

const UUID = '11111111-2222-3333-4444-555555555555';
const CAPTURE = path.join(PKG_ROOT, 'core', 'test', 'fixtures', 'capture-spawn.cjs');
const runDirOf = (taskDir, n) => path.join(taskDir, 'runs', String(n));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hasPair = (args, flag, value) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] === value;
};

/** 起 dispatch（预载 spawn 捕获器），返回 {json, calls}；calls=[{cmd,args}]。 */
function dispatchCapturing(home, args, captureFile) {
  const r = spawnSync(process.execPath, ['--require', CAPTURE, PROG('dispatch'), '--home', home, ...args], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, SCHFLOW_TEST_CAPTURE_SPAWN: captureFile },
  });
  if (r.status !== 0) throw new Error(`dispatch exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const calls = fs.existsSync(captureFile)
    ? fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { json: JSON.parse(r.stdout), calls };
}

/** 预置「已跑过 run1」的现场：runs/1 会话账本/转写/violations + 卡 attempts=1（重派 run2）。 */
function seedRun1(home, id, { session, transcript }) {
  const taskDir = findTaskDir(home, id);
  const run1 = runDirOf(taskDir, 1);
  fs.mkdirSync(run1, { recursive: true });
  fs.writeFileSync(path.join(run1, 'transcript.out'), transcript);
  fs.writeFileSync(path.join(run1, 'session.json'), JSON.stringify(session));
  fs.writeFileSync(path.join(run1, 'violations.json'), JSON.stringify({ runNo: 1, violations: ['missing-status'], at: new Date().toISOString() }));
  const card = loadCard(taskDir);
  card.attempts = 1;
  saveCard(taskDir, card);
  return { taskDir, run1 };
}

test('dsh phase-group：run1 恒传 --session-id schflow-<id>；interrupted 记 resumeFailed；run2 resumed=true', async () => {
  const dir = tmpdir('schflow-pg-dsh-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  writeProfile(home, 'lab', { runner: 'dsh', 'phase-group': true });
  const id = 'P-20261121-21';
  await addTask(home, { id, project: 'lab', kind: 'investigate', title: 'dsh 会话续跑', status: 'approved' });

  // run1：确定性别名首次即传（dsh 侧同 id 续、无则新建=天然回落）
  const d1 = dispatchCapturing(home, ['--task', id, '--json'], path.join(dir, 'argv-1.log'));
  const call1 = d1.calls.find((c) => c.cmd === 'dsh');
  assert.ok(call1, `应 spawn dsh：${JSON.stringify(d1.calls)}`);
  assert.ok(hasPair(call1.args, '--session-id', `schflow-${id}`), `argv 应含 --session-id schflow-${id}：${call1.args.join(' ')}`);
  const taskDir = findTaskDir(home, id);
  const run1 = runDirOf(taskDir, 1);
  assert.deepEqual(readJson(path.join(run1, 'session.json')), { runner: 'dsh', sessionId: `schflow-${id}`, resumed: false });
  const ev1 = readEvents(home, { types: ['dispatched'] }).find((e) => e.taskId === id);
  assert.deepEqual(ev1.session, { resumed: false }, 'dispatched 事件带 session.resumed');

  // 二进制不存在 = 子进程未起 → fold --force 折 interrupted（run1 非续跑，不记 resumeFailed）
  const f1 = run('fold', ['--json', '--force', id], { home });
  assert.ok(f1.json.outcomes.some((o) => o.id === id && o.outcome === 'interrupted'), `应折 interrupted：${f1.stdout}`);
  assert.equal(readJson(path.join(run1, 'session.json')).resumeFailed, undefined, 'resumed=false 不记 resumeFailed');

  // run2：resumed=true；再中断 → 该 run 账本记 resumeFailed（下轮回落信号）
  const d2 = dispatchCapturing(home, ['--task', id, '--json'], path.join(dir, 'argv-2.log'));
  const call2 = d2.calls.find((c) => c.cmd === 'dsh');
  assert.ok(hasPair(call2.args, '--session-id', `schflow-${id}`), `续跑仍传同一 id：${call2.args.join(' ')}`);
  const run2 = runDirOf(taskDir, 2);
  assert.deepEqual(readJson(path.join(run2, 'session.json')), { runner: 'dsh', sessionId: `schflow-${id}`, resumed: true });
  run('fold', ['--json', '--force', id], { home });
  assert.equal(readJson(path.join(run2, 'session.json')).resumeFailed, true, 'interrupted∧resumed=true → resumeFailed');
});

test('native 家族：phase-group 开启也不写 session.json（无独立会话可续）', async () => {
  const dir = tmpdir('schflow-pg-native-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  writeProfile(home, 'lab', { runner: 'dsh', 'phase-group': true });
  const id = 'P-20261121-22';
  await addTask(home, { id, project: 'lab', kind: 'investigate', title: '原生家族', status: 'approved' });

  const d = run('dispatch', ['--task', id, '--no-spawn', '--launcher', 'test', '--json'], { home });
  assert.equal(d.json.dispatched[0].family, 'native');
  const taskDir = findTaskDir(home, id);
  assert.equal(fs.existsSync(path.join(runDirOf(taskDir, 1), 'session.json')), false, 'native 不落会话账本');
  const ev = readEvents(home, { types: ['dispatched'] }).find((e) => e.taskId === id);
  assert.equal(ev.session, undefined, 'native 的 dispatched 事件无 session 字段');
});

test('claude phase-group：重派从上一 run transcript.out 提取 session_id → --resume', async () => {
  const dir = tmpdir('schflow-pg-claude-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  writeProfile(home, 'lab', { runner: 'claude', 'phase-group': true });
  const id = 'P-20261121-23';
  await addTask(home, { id, project: 'lab', kind: 'investigate', title: 'claude 续跑', status: 'approved' });
  const { taskDir } = seedRun1(home, id, {
    session: { runner: 'claude', sessionId: null, resumed: false },
    transcript: JSON.stringify({ type: 'result', subtype: 'success', session_id: UUID, result: 'ok' }) + '\n',
  });

  const d2 = dispatchCapturing(home, ['--task', id, '--json'], path.join(dir, 'argv-2.log'));
  const call = d2.calls.find((c) => c.cmd === 'claude');
  assert.ok(call, `应 spawn claude：${JSON.stringify(d2.calls)}`);
  assert.ok(hasPair(call.args, '--resume', UUID), `argv 应含 --resume ${UUID}：${call.args.join(' ')}`);
  assert.deepEqual(readJson(path.join(runDirOf(taskDir, 2), 'session.json')), { runner: 'claude', sessionId: UUID, resumed: true });
  const ev = readEvents(home, { types: ['dispatched'] }).find((e) => e.taskId === id);
  assert.deepEqual(ev.session, { resumed: true });
});

test('claude phase-group 回落：上一 run resumeFailed=true → 不续跑（--resume 缺席、resumed:false）', async () => {
  const dir = tmpdir('schflow-pg-fallback-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  writeProfile(home, 'lab', { runner: 'claude', 'phase-group': true });
  const id = 'P-20261121-24';
  await addTask(home, { id, project: 'lab', kind: 'investigate', title: 'claude 回落', status: 'approved' });
  // 转写里明明有可提取的 session_id——resumeFailed（折叠信号）必须压过提取结果
  const { taskDir } = seedRun1(home, id, {
    session: { runner: 'claude', sessionId: UUID, resumed: true, resumeFailed: true },
    transcript: JSON.stringify({ type: 'result', subtype: 'error', session_id: UUID }) + '\n',
  });

  const d2 = dispatchCapturing(home, ['--task', id, '--json'], path.join(dir, 'argv-2.log'));
  const call = d2.calls.find((c) => c.cmd === 'claude');
  assert.ok(call, `应 spawn claude：${JSON.stringify(d2.calls)}`);
  assert.ok(!call.args.includes('--resume'), `续不上应静默回落新会话：${call.args.join(' ')}`);
  assert.deepEqual(readJson(path.join(runDirOf(taskDir, 2), 'session.json')), { runner: 'claude', sessionId: null, resumed: false });
  const ev = readEvents(home, { types: ['dispatched'] }).find((e) => e.taskId === id);
  assert.deepEqual(ev.session, { resumed: false });
});

test('phase-group 关闭：dsh 不传 --session-id、不落 session.json（与今天等价）', async () => {
  const dir = tmpdir('schflow-pg-off-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  writeProfile(home, 'lab', { runner: 'dsh' }); // 缺省关闭
  const id = 'P-20261121-25';
  await addTask(home, { id, project: 'lab', kind: 'investigate', title: '关闭态', status: 'approved' });

  const d1 = dispatchCapturing(home, ['--task', id, '--json'], path.join(dir, 'argv-1.log'));
  const call = d1.calls.find((c) => c.cmd === 'dsh');
  assert.ok(call, `应 spawn dsh：${JSON.stringify(d1.calls)}`);
  assert.ok(call.args.includes('--profile'), '基线参数仍在');
  assert.ok(!call.args.includes('--session-id'), `关闭态不得追加会话参数：${call.args.join(' ')}`);
  const run1 = runDirOf(findTaskDir(home, id), 1);
  assert.equal(fs.existsSync(path.join(run1, 'session.json')), false, '关闭态不落会话账本');
  const ev = readEvents(home, { types: ['dispatched'] }).find((e) => e.taskId === id);
  assert.equal(ev.session, undefined);
});
