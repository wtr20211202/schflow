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

// decide 程序集成测：人工裁决面=blocked/stale/rejected 三态的人侧出口（judge③「转人」的人侧闭环）。
// 覆盖：blocked→approved 回炉（真转移 + status.changed actor=human + note 落事件 + --json 形态）；
// blocked→rejected 关闭（人读形态）；非法转移 done→approved=76 且 stderr 列合法去向；
// 任务不存在=FAIL(1)；无 note 时事件不带 note 字段；守卫链第一环缺参=MISSING(2)+用法文本。
import test from 'node:test';
import assert from 'node:assert';
import { run, tmpdir, addTask } from '../helpers.mjs';

/** 造 blocked 卡：pending → approved → running → blocked（转移表正典路径——addTask 只直达 approved） */
async function mkBlocked(home, id) {
  const { transition } = await import('../../lib/store.mjs');
  await addTask(home, { id, kind: 'docs', title: `受阻任务 ${id}` });
  transition(home, id, 'approved', { actor: 'human' });
  transition(home, id, 'running', { actor: 'engine' });
  transition(home, id, 'blocked', { actor: 'engine', extra: { reason: '设计类转人' } });
}

test('decide blocked→approved 回炉：真转移 + 事件 actor=human + note 落事件 + --json 形态', async () => {
  const home = tmpdir('schflow-decide-');
  await mkBlocked(home, 'P-20261119-1');

  const r = run('decide', ['--task', 'P-20261119-1', '--to', 'approved', '--note', '凭据已补齐，回炉重派', '--json'], { home });
  assert.equal(r.code, 0, `exit 0：${r.stdout || r.stderr}`);
  assert.deepEqual(r.json, { ok: true, id: 'P-20261119-1', from: 'blocked', to: 'approved', note: '凭据已补齐，回炉重派', home }, '--json 形态');

  // 卡面真转移
  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');
  assert.equal(loadCard(findTaskDir(home, 'P-20261119-1')).status, 'approved', '卡面 blocked→approved');

  // 事件面：恰好一条 blocked→approved（transition 唯一出口，无重复追加），actor=human + note 留痕
  const { readEvents } = await import('../../lib/events.mjs');
  const changed = readEvents(home, { types: ['status.changed'] })
    .filter((e) => e.taskId === 'P-20261119-1' && e.from === 'blocked' && e.to === 'approved');
  assert.equal(changed.length, 1, `恰好一条 blocked→approved 事件：${JSON.stringify(changed)}`);
  assert.equal(changed[0].actor, 'human', 'actor=human（可审计）');
  assert.equal(changed[0].note, '凭据已补齐，回炉重派', 'note 随事件留痕');
});

test('decide blocked→rejected 关闭：卡面终态 + 人读形态同源', async () => {
  const home = tmpdir('schflow-decide-');
  await mkBlocked(home, 'P-20261119-2');

  const r = run('decide', ['--task', 'P-20261119-2', '--to', 'rejected', '--note', '方案否决，另起方向'], { home });
  assert.equal(r.code, 0, `exit 0：${r.stdout || r.stderr}`);
  assert.match(r.stdout, /P-20261119-2 blocked → rejected/, '人读形态');
  assert.match(r.stdout, /方案否决，另起方向/, '裁决理由随人读输出');

  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');
  assert.equal(loadCard(findTaskDir(home, 'P-20261119-2')).status, 'rejected', '卡面 blocked→rejected（关闭）');
});

test('decide 非法转移 done→approved：exit 76 且 stderr 列合法去向', async () => {
  const home = tmpdir('schflow-decide-');
  const { transition } = await import('../../lib/store.mjs');
  await addTask(home, { id: 'P-20261119-3', kind: 'docs', title: '已完结任务' });
  transition(home, 'P-20261119-3', 'approved', { actor: 'human' });
  transition(home, 'P-20261119-3', 'running', { actor: 'engine' });
  transition(home, 'P-20261119-3', 'done', { actor: 'engine' });

  const r = run('decide', ['--task', 'P-20261119-3', '--to', 'approved'], { home, expectFail: true });
  assert.equal(r.code, 76, `exit 76（校验拒绝）：${r.stdout || r.stderr}`);
  assert.match(r.stderr, /不在转移表/, '拒绝理由点名转移表');
  assert.match(r.stderr, /blocked/, 'stderr 列出该状态合法去向（done→blocked）');
});

test('decide 任务不存在：exit 非 0（FAIL=1）', () => {
  const home = tmpdir('schflow-decide-');
  const r = run('decide', ['--task', 'P-20990101-99', '--to', 'approved'], { home, expectFail: true });
  assert.equal(r.code, 1, `exit 1（FAIL）：${r.stderr}`);
  assert.match(r.stderr, /不存在/, 'stderr 点名任务不存在');
});

test('decide 无 note：事件无 note 字段；缺参守卫=MISSING(2)+用法文本', async () => {
  const home = tmpdir('schflow-decide-');
  await mkBlocked(home, 'P-20261119-5');

  // 无 note：--json 形态无 note 键，事件亦无 note 字段（blocked→stale 收官）
  const r = run('decide', ['--task', 'P-20261119-5', '--to', 'stale', '--json'], { home });
  assert.equal(r.code, 0, `exit 0：${r.stdout || r.stderr}`);
  assert.deepEqual(r.json, { ok: true, id: 'P-20261119-5', from: 'blocked', to: 'stale', home }, '--json 无 note 键');
  const { readEvents } = await import('../../lib/events.mjs');
  const evt = readEvents(home, { types: ['status.changed'] }).find((e) => e.from === 'blocked' && e.to === 'stale');
  assert.ok(evt, 'blocked→stale 事件在');
  assert.equal(evt.actor, 'human');
  assert.ok(!('note' in evt), '无 note 时事件不带 note 字段');

  // 守卫链第一环：--task / --to 缺失 → MISSING(2) + 用法文本
  const m1 = run('decide', ['--to', 'approved'], { home, expectFail: true });
  assert.equal(m1.code, 2, `缺 --task → MISSING(2)：${m1.stderr}`);
  assert.match(m1.stderr, /用法/);
  const m2 = run('decide', ['--task', 'P-20261119-5'], { home, expectFail: true });
  assert.equal(m2.code, 2, `缺 --to → MISSING(2)：${m2.stderr}`);
  assert.match(m2.stderr, /用法/);
});
