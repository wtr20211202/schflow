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

// buildLauncher 的 phase-group 会话参数（契约：claude `--resume <id>` / dsh `--session-id <id>`）。
// 只钉参数面——参数是否该给由 dispatch 的护栏（subprocess ∧ phase-group ∧ runner 家族）决定。
import test from 'node:test';
import assert from 'node:assert';
import { buildLauncher } from '../../lib/runner.mjs';

const base = { bookPath: '/tmp/book.md', cwd: '/tmp/work' };

test('buildLauncher: claude + resumeSession → 追加 --resume <id>', () => {
  const l = buildLauncher({ ...base, runner: 'claude', resumeSession: '11111111-2222-3333-4444-555555555555' });
  const i = l.args.indexOf('--resume');
  assert.ok(i >= 0, `应含 --resume：${l.args.join(' ')}`);
  assert.equal(l.args[i + 1], '11111111-2222-3333-4444-555555555555');
});

test('buildLauncher: dsh + resumeSession → 追加 --session-id <id>（在 stdin `-` 之前）', () => {
  const l = buildLauncher({ ...base, runner: 'dsh', resumeSession: 'schflow-P-20261121-3' });
  const i = l.args.indexOf('--session-id');
  assert.ok(i >= 0, `应含 --session-id：${l.args.join(' ')}`);
  assert.equal(l.args[i + 1], 'schflow-P-20261121-3');
  assert.ok(i < l.args.indexOf('-'), '位置参数 `-`（stdin）必须在选项之后');
});

test('buildLauncher: 无 resumeSession → claude/dsh 均不含会话续跑参数', () => {
  for (const runner of ['claude', 'dsh']) {
    const l = buildLauncher({ ...base, runner });
    assert.ok(!l.args.includes('--resume'), `${runner} 不应含 --resume`);
    assert.ok(!l.args.includes('--session-id'), `${runner} 不应含 --session-id`);
  }
});

test('buildLauncher: custom 忽略 resumeSession（仅 claude/dsh 家族支持会话续跑）', () => {
  const l = buildLauncher({
    ...base, runner: 'custom', runnerCmd: [process.execPath, '-e', '0'], resumeSession: 'sid-1',
  });
  assert.deepEqual(l.args, ['-e', '0'], `custom argv 不应被会话参数污染：${l.args.join(' ')}`);
});
