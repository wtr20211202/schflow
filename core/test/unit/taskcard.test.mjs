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

// 任务卡 schema 性质断言（docs/spec/task-card.md 五规则逐条 + 转移表）
import test from 'node:test';
import assert from 'node:assert';
import { validateTaskCard, canTransition, TRANSITIONS, normalizeCard } from '../../lib/taskcard.mjs';

const base = () => ({
  id: 'P-20261117-1', kind: 'code', title: '示例任务', status: 'pending', priority: 'medium',
  source: { type: 'human', trust: 'trusted' }, dependsOn: [], sessionOnly: false, attempts: 0,
  createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z',
});

test('规则1：未知字段拒绝', () => {
  const c = { ...base(), extraneous: 1 };
  assert.ok(validateTaskCard(c).some((v) => v.startsWith('unknown-field')));
});
test('规则2：枚举与正则', () => {
  assert.ok(validateTaskCard({ ...base(), kind: 'poetry' }).some((v) => v.startsWith('kind-enum')));
  assert.ok(validateTaskCard({ ...base(), id: 'X-1' }).some((v) => v.startsWith('id-format')));
  assert.ok(validateTaskCard({ ...base(), title: 'x'.repeat(121) }).some((v) => v.startsWith('title-too-long')));
  assert.ok(validateTaskCard({ ...base(), status: 'queued' }).some((v) => v.startsWith('status-enum')));
  assert.ok(validateTaskCard({ ...base(), repo: 'relative/path' }).some((v) => v.startsWith('repo-absolute')));
});
test('source trust 与 type 一致性（正典位抄录校验）', () => {
  assert.ok(validateTaskCard({ ...base(), source: { type: 'webhook', trust: 'trusted' } }).some((v) => v.startsWith('source.trust-mismatch')));
  assert.ok(validateTaskCard({ ...base(), source: { type: 'generator', trust: 'trusted' } }).some((v) => v.startsWith('source.trust-mismatch')));
  assert.deepEqual(validateTaskCard({ ...base(), source: { type: 'improve', trust: 'semi' } }), []);
});
test('规则4：highest 仅 human', () => {
  const v = validateTaskCard({ ...base(), priority: 'highest', source: { type: 'generator', trust: 'semi' } });
  assert.ok(v.some((s) => s.startsWith('priority-highest-nonhuman')));
});
test('规则5：exclusive-human 方向机械拒绝 + 未知 direction 响亮失败', () => {
  const directions = new Map([
    ['human', { exclusiveHuman: true }],
    ['industry', {}],
  ]);
  const v = validateTaskCard(
    { ...base(), source: { type: 'generator', trust: 'semi', direction: 'human' } },
    { directions },
  );
  assert.ok(v.some((s) => s.startsWith('direction-exclusive-human')));
  const v2 = validateTaskCard(
    { ...base(), source: { type: 'generator', trust: 'semi', direction: 'nope' } },
    { directions },
  );
  assert.ok(v2.some((s) => s.startsWith('direction-unknown')));
  assert.deepEqual(validateTaskCard(
    { ...base(), source: { type: 'human', trust: 'trusted', direction: 'human' } },
    { directions },
  ), []);
});
test('规则3：转移表——合法/非法逐项', () => {
  assert.ok(canTransition('pending', 'approved'));
  assert.ok(canTransition('approved', 'running'));
  assert.ok(canTransition('running', 'done'));
  assert.ok(canTransition('running', 'approved'), 'interrupted 重派回炉');
  assert.ok(canTransition('done', 'blocked'), 'ejected 回炉');
  assert.ok(canTransition('stale', 'approved'), '人工 reopen');
  assert.ok(canTransition('rejected', 'approved'));
  assert.ok(!canTransition('pending', 'running'), '未批准不得直接跑');
  assert.ok(!canTransition('done', 'running'));
  assert.ok(!canTransition('pending', 'done'));
  // 全状态可达终态（状态机完备性）
  for (const s of Object.keys(TRANSITIONS)) assert.ok(TRANSITIONS[s].length > 0, `${s} 非孤立`);
});
test('normalizeCard 默认值补齐不覆盖', () => {
  const c = normalizeCard({ id: 'P-20261117-9', kind: 'docs', title: 't', priority: 'low', source: { type: 'human', trust: 'trusted' } });
  assert.equal(c.status, 'pending');
  assert.equal(c.attempts, 0);
  assert.equal(c.sessionOnly, false);
  assert.deepEqual(c.dependsOn, []);
});

test('author 枚举：human/model 合法，其它拒绝', () => {
  assert.deepEqual(validateTaskCard({ ...base(), source: { type: 'human', trust: 'trusted', author: 'human' } }), []);
  assert.deepEqual(validateTaskCard({ ...base(), source: { type: 'human', trust: 'trusted', author: 'model' } }), []);
  const v = validateTaskCard({ ...base(), source: { type: 'human', trust: 'trusted', author: 'robot' } });
  assert.ok(v.some((s) => s.startsWith('source.author-enum')), `author 枚举: ${v}`);
});

test('author=model：approved/running/done 缺 approvedBy → approval-missing', () => {
  const model = () => ({ type: 'human', trust: 'trusted', author: 'model' });
  for (const status of ['approved', 'running', 'done']) {
    const v = validateTaskCard({ ...base(), status, source: model() });
    assert.ok(v.some((s) => s.startsWith('approval-missing')), `${status} 需批准留痕: ${v}`);
  }
  // pending 阶段不要求批准痕迹
  assert.deepEqual(validateTaskCard({ ...base(), status: 'pending', source: model() }), []);
  // decide 起草的批准痕迹让卡通过
  assert.deepEqual(validateTaskCard({
    ...base(), status: 'approved', source: model(), approvedBy: 'human', approvedAt: '2026-11-21T10:00:00Z',
  }), []);
});

test('向后兼容：无 author 的旧卡 approved 无需 approvedBy', () => {
  assert.deepEqual(validateTaskCard({ ...base(), status: 'approved' }), []);
  assert.deepEqual(validateTaskCard({ ...base(), status: 'running' }), []);
  assert.deepEqual(validateTaskCard({ ...base(), status: 'done' }), []);
});

test('approvedBy 仅允许 human；approvedAt 出现即须 ISO', () => {
  const v = validateTaskCard({ ...base(), approvedBy: 'model' });
  assert.ok(v.some((s) => s.startsWith('approvedBy-enum')), `approvedBy 非 human: ${v}`);
  const v2 = validateTaskCard({ ...base(), approvedBy: 'human', approvedAt: 'yesterday' });
  assert.ok(v2.some((s) => s.startsWith('approvedAt-iso')), `approvedAt 非 ISO: ${v2}`);
});
