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

// 引擎身份可见（P-20261120-1）：pkgVersion 与仓库根清单同源；新建空库提示只出现一次且可静默；
// status 的 --json 带 home/version、--version 只打印版本（不触碰库）；dispatch/fold 主输出带 home。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, PKG_ROOT } from '../helpers.mjs';
import { pkgVersion } from '../../lib/version.mjs';

const ROOT_VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;

test('pkgVersion() 等于仓库根 package.json 的 version（命中即缓存）', () => {
  assert.equal(pkgVersion(), ROOT_VERSION);
  assert.equal(pkgVersion(), ROOT_VERSION, '二次调用同值（缓存不漂移）');
});

test('新建空库提示：首次出现一次，同库再跑不再出现；SCHFLOW_QUIET=1 静默', () => {
  // 子路径不存在=真正的首次使用（tmpdir 本身已存在，故取其后代）
  const base = tmpdir('schflow-test-identity-');
  const home = path.join(base, 'fresh-home');
  const first = run('status', ['--json'], { home, env: { SCHFLOW_QUIET: '' } });
  assert.match(first.stderr, /新建空库/, `首次运行提示：${first.stderr}`);
  assert.ok(first.stderr.includes(path.resolve(home)), `提示含绝对路径：${first.stderr}`);
  assert.ok(first.stderr.includes('SCHFLOW_HOME'), '提示给出替代指定方式');

  const again = run('status', ['--json'], { home, env: { SCHFLOW_QUIET: '' } });
  assert.ok(!/新建空库/.test(again.stderr), `同库再跑无提示：${again.stderr}`);

  const fresh2 = path.join(tmpdir('schflow-test-identity-'), 'fresh-home-quiet');
  const quiet = run('status', ['--json'], { home: fresh2, env: { SCHFLOW_QUIET: '1' } });
  assert.ok(!/新建空库/.test(quiet.stderr), `SCHFLOW_QUIET=1 静默：${quiet.stderr}`);
});

test('status --json 含 home/version；status --version 输出与 package.json 一致', () => {
  const home = tmpdir('schflow-test-identity-');
  const r = run('status', ['--json'], { home });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.home, path.resolve(home), '主输出自报库位置');
  assert.equal(r.json.version, ROOT_VERSION, '主输出自报版本');

  const v = run('status', ['--version'], { home });
  assert.equal(v.code, 0);
  assert.equal(v.stdout.trim(), ROOT_VERSION);

  // --version 是纯只读身份面：不解析 HOME、不自举库、无「新建空库」行
  const absent = path.join(tmpdir('schflow-test-identity-'), 'never-created');
  const v2 = run('status', ['--version'], { home: absent, env: { SCHFLOW_QUIET: '' } });
  assert.equal(v2.stdout.trim(), ROOT_VERSION);
  assert.equal(v2.stderr, '', `--version 无提示：${v2.stderr}`);
  assert.equal(fs.existsSync(absent), false, '--version 不建库');
});

test('dispatch --json / fold --json 主输出含 home', () => {
  const home = tmpdir('schflow-test-identity-');
  const d = run('dispatch', ['--auto', '--json'], { home });
  assert.equal(d.json.home, path.resolve(home), 'dispatch 主输出自报库位置');
  assert.deepEqual(d.json.dispatched, [], '空库无候选');
  const f = run('fold', ['--json'], { home });
  assert.equal(f.json.home, path.resolve(home), 'fold 主输出自报库位置');
  assert.deepEqual(f.json.outcomes, [], '空库无在途');
});
