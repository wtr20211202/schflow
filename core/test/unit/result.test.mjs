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

// result.json 契约性质断言（docs/spec/result.md）
import test from 'node:test';
import assert from 'node:assert';
import { validateResult } from '../../lib/result.mjs';

test('四态封闭 + 未知字段拒绝', () => {
  assert.equal(validateResult({ status: 'done', summary: 'ok', commit: 'abc' }, { gitTrack: true }).length, 0);
  assert.ok(validateResult({ status: 'running', summary: 'x' }).some((v) => v.startsWith('status-enum')));
  assert.ok(validateResult({ status: 'done', summary: 'ok', sneaky: 1 }).some((v) => v.startsWith('unknown-field')));
});
test('git 轨道 done 必带 commit；非 git 不要求', () => {
  assert.ok(validateResult({ status: 'done', summary: 'ok' }, { gitTrack: true }).some((v) => v.startsWith('commit-required')));
  assert.equal(validateResult({ status: 'done', summary: 'ok', deliverables: [{ path: 'deliverables/r.md', type: 'report' }] }, { gitTrack: false }).length, 0);
});
test('freshness=stale ⇒ status=stale', () => {
  assert.ok(validateResult({ status: 'done', summary: 'x', freshness: 'stale' }).some((v) => v.startsWith('freshness-stale-mismatch')));
  assert.equal(validateResult({ status: 'stale', summary: 'x', freshness: 'stale' }).length, 0);
});
test('summary 必填', () => {
  assert.ok(validateResult({ status: 'blocked' }).some((v) => v.startsWith('summary-required')));
});
