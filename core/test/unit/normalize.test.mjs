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

// normalizeResult 白名单机械修正性质断言：修正面三则 + 不修面（语义类一概不动）+ 修后仍违规回退。
import test from 'node:test';
import assert from 'node:assert';
import { normalizeResult } from '../../lib/normalize.mjs';
import { validateResult } from '../../lib/result.mjs';

test('修正面①：deliverables string[] → [{path}]（修后全绿）', () => {
  const input = { status: 'done', summary: 'ok', deliverables: ['a.md', 'b.md'] };
  const { result, fixes, changed } = normalizeResult(input, { gitTrack: false });
  assert.equal(changed, true);
  assert.deepEqual(result.deliverables, [{ path: 'a.md' }, { path: 'b.md' }]);
  assert.deepEqual(fixes, [{ field: 'deliverables', from: 'string[]', to: '[{path}]' }]);
  assert.equal(validateResult(result, { gitTrack: false }).length, 0, '修后必须全绿');
  assert.deepEqual(input.deliverables, ['a.md', 'b.md'], '入参原件不被改');
});

test('修正面①：deliverables 单对象 → [对象]', () => {
  const one = { path: 'deliverables/r.md', type: 'report' };
  const { result, changed } = normalizeResult({ status: 'done', summary: 'ok', deliverables: one }, { gitTrack: false });
  assert.equal(changed, true);
  assert.deepEqual(result.deliverables, [one]);
});

test('修正面②：status trim+小写归一（枚举内才修）', () => {
  for (const raw of ['Done', ' DONE ', 'Blocked']) {
    const { result, changed } = normalizeResult({ status: raw, summary: 'x' }, { gitTrack: false });
    assert.equal(changed, true, `${raw} 应归一`);
    assert.equal(result.status, raw.trim().toLowerCase());
  }
  // 已合法形态不动（changed:false——无 fix 面）
  assert.equal(normalizeResult({ status: 'done', summary: 'x' }, { gitTrack: false }).changed, false);
});

test('修正面③：summary 数字/布尔 → String()（空串/null 不在本则）', () => {
  assert.deepEqual(
    normalizeResult({ status: 'done', summary: 42 }, { gitTrack: false }),
    { result: { status: 'done', summary: '42' }, fixes: [{ field: 'summary', from: 42, to: '42' }], changed: true },
  );
  assert.equal(normalizeResult({ status: 'blocked', summary: true }, { gitTrack: false }).result.summary, 'true');
  for (const s of ['', null, undefined]) {
    assert.equal(normalizeResult({ status: 'blocked', summary: s }, { gitTrack: false }).changed, false, `summary=${JSON.stringify(s)} 不修`);
  }
});

test('组合修正：一次全修三面', () => {
  const { result, fixes, changed } = normalizeResult(
    { status: ' Done ', summary: 7, deliverables: ['a.md'] },
    { gitTrack: false },
  );
  assert.equal(changed, true);
  assert.deepEqual(result, { status: 'done', summary: '7', deliverables: [{ path: 'a.md' }] });
  assert.equal(fixes.length, 3);
});

test('不修面：unknown-field / 缺 path / flags 数组 / freshness 错配 / 枚举外 status / 混合 deliverables', () => {
  const cases = [
    { status: 'done', summary: 'ok', sneaky: 1 },                                  // unknown-field
    { status: 'done', summary: 'ok', deliverables: [{ type: 'report' }] },          // deliverables-item 缺 path
    { status: 'done', summary: 'ok', flags: ['a'] },                                // flags 数组形态（猜语义）
    { status: 'done', summary: 'ok', freshness: 'stale' },                          // freshness 语义类错配
    { status: 'RUNNING', summary: 'x' },                                            // 归一后枚举外——不猜
    { status: 'done', summary: 'ok', deliverables: ['a.md', { path: 'b.md' }] },    // 混合形态（部分可部分不可）
  ];
  for (const input of cases) {
    const { result, fixes, changed } = normalizeResult(input, { gitTrack: false });
    assert.equal(changed, false, `${JSON.stringify(input)} 不在白名单`);
    assert.deepEqual(fixes, []);
    assert.deepEqual(result, input, '原样返回');
  }
});

test('不修面：commit-required（git 轨道 done 无 commit——不可凭空造哈希）', () => {
  // 即使带着可修面（string[] deliverables），修后仍缺 commit → 整体回炉
  const input = { status: 'done', summary: 'ok', deliverables: ['a.md'] };
  const { result, fixes, changed } = normalizeResult(input, { gitTrack: true });
  assert.equal(changed, false, '修正消不掉 commit-required——修不动');
  assert.deepEqual(fixes, []);
  assert.deepEqual(result, input);
});

test('回退面：修正后仍有其他违规 → changed:false 原样返回（原违规清单由调用方保有）', () => {
  const input = { status: 'Done', summary: 'ok', deliverables: ['a.md'], extra: 1 };
  const { result, changed } = normalizeResult(input, { gitTrack: false });
  assert.equal(changed, false, 'unknown-field 不修——组合里仍有违规即回退');
  assert.deepEqual(result, input);
});

test('非 object 形态与完全合法输入：均 changed:false 零副作用', () => {
  for (const bad of [null, undefined, 'str', 42, [], [1, 2]]) {
    assert.equal(normalizeResult(bad, {}).changed, false, `${JSON.stringify(bad)} 无可修面`);
  }
  const ok = { status: 'blocked', summary: '缺环境' };
  assert.deepEqual(normalizeResult(ok, {}), { result: ok, fixes: [], changed: false });
});
