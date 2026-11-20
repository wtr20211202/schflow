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

// 版本一致性守卫（版本说真话）：四处清单版本必须相等；bin 指向存在的 .mjs；
// `schflow --version` 输出与根 package.json 版本一致（发布前跑 scripts/bump-version.sh）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PKG_ROOT } from '../helpers.mjs';

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(PKG_ROOT, rel), 'utf8'));
const pkg = readJson('package.json');
const binRel = pkg.bin?.schflow;

test('四处版本清单相等（bump-version.sh 的四个落点）', () => {
  const versions = {
    'package.json': pkg.version,
    'hosts/claude-code/.claude-plugin/plugin.json': readJson('hosts/claude-code/.claude-plugin/plugin.json').version,
    '.claude-plugin/marketplace.json': readJson('.claude-plugin/marketplace.json').plugins?.[0]?.version,
    'hosts/dsh/plugin/package.json': readJson('hosts/dsh/plugin/package.json').version,
  };
  for (const [file, v] of Object.entries(versions)) {
    assert.match(v ?? '', /^\d+\.\d+\.\d+$/, `${file} 的 version 缺失或不是 x.y.z：${JSON.stringify(v)}`);
  }
  assert.deepEqual(
    [...new Set(Object.values(versions))],
    [pkg.version],
    `版本漂移——四处必须相等（跑 scripts/bump-version.sh <x.y.z>）：${JSON.stringify(versions)}`,
  );
});

test('package.json 的 bin 指向存在且以 .mjs 结尾的入口', () => {
  assert.equal(typeof binRel, 'string', 'package.json 必须声明 bin.schflow');
  assert.ok(binRel.endsWith('.mjs'), `bin 必须以 .mjs 结尾（node 20/22 不剥离 .ts）：${binRel}`);
  assert.ok(fs.existsSync(path.join(PKG_ROOT, binRel)), `bin 指向的文件不存在：${binRel}`);
});

test('schflow --version 输出 schflow <根 package.json 版本>', () => {
  assert.equal(typeof binRel, 'string', 'package.json 必须声明 bin.schflow');
  const r = spawnSync(process.execPath, [path.join(PKG_ROOT, binRel), '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(r.status, 0, `--version 应 exit 0，实际 exit ${r.status}（stderr: ${r.stderr}）`);
  assert.equal(r.stdout.trim(), `schflow ${pkg.version}`);
});

test('schflow --help / 无参输出骨架提示 + 版本 + 用法', () => {
  assert.equal(typeof binRel, 'string', 'package.json 必须声明 bin.schflow');
  for (const argv of [[], ['--help']]) {
    const r = spawnSync(process.execPath, [path.join(PKG_ROOT, binRel), ...argv], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(r.status, 0, `schflow ${argv.join(' ')} 应 exit 0，实际 exit ${r.status}`);
    assert.match(r.stdout, /CLI lands in M0/);
    assert.ok(r.stdout.includes(`schflow ${pkg.version}`), `输出缺版本行：${r.stdout}`);
    assert.match(r.stdout, /Usage: schflow/);
  }
});
