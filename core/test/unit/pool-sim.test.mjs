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

// 相似度（dup-check 双通道之 jaccard）+ 环境池租约性质断言（§8 v1.0.10/11/12）
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { tokenize, jaccard } from '../../lib/similarity.mjs';
import { loadEnvPool, matchEnvs, acquireLease, releaseLease, sweepOrphanLeases, readLeases, rebuildLeasesFromEvents } from '../../lib/envpool.mjs';
import { resolveHome } from '../../lib/home.mjs';
import { tmpdir } from '../helpers.mjs';

test('tokenize：ASCII 词 + CJK 二元组', () => {
  const t = tokenize('优化 QuickDrop 上传进度');
  assert.ok(t.has('quickdrop'));
  assert.ok([...t].some((x) => x === '上传' || x === '传进'));
  assert.equal(jaccard(new Set(), new Set()), 0);
});

test('jaccard：同文=1 近似高 全异=0', () => {
  const a = tokenize('优化上传进度的显示');
  assert.equal(jaccard(a, tokenize('优化上传进度的显示')), 1);
  assert.ok(jaccard(a, tokenize('优化上传进度')) > 0.5);
  assert.equal(jaccard(a, tokenize('数据库迁移方案评审')), 0);
});

function freshHome() {
  return resolveHome(path.join(tmpdir(), 'envhome'));
}

const ENVS_YAML = `
provider: static
environments:
  staging-a:
    acquire: exclusive
    labels: [linux, has-db]
    setup: echo setup >> {SETUP_LOG}
    teardown: echo teardown >> {SETUP_LOG}
    ref: "docs/envs/staging-a.md"
  lab-pool:
    acquire: shared
    capacity: 2
    labels: [linux]
  prod-real:
    acquire: exclusive
    protected: true
`;

test('环境池：static 载入 / 点名与标签匹配 / protected 永不匹配', () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, 'envs.yaml'), ENVS_YAML.replaceAll('{SETUP_LOG}', path.join(home, 'hooks.log').replaceAll('\\', '/')));
  const envs = loadEnvPool(home);
  assert.equal(envs.size, 3);
  const leases = readLeases(home);
  assert.equal(matchEnvs(envs, leases, 'staging-a').length, 1);
  assert.equal(matchEnvs(envs, leases, ['linux', 'has-db']).length, 1);
  assert.equal(matchEnvs(envs, leases, ['linux']).length, 2, '多命中含 lab-pool 与 staging-a');
  assert.equal(matchEnvs(envs, leases, 'prod-real').length, 0, 'protected 永不匹配');
});

test('租约：exclusive 串行 / setup 0→1 与 teardown N→0 跳变 / 释放后再取', () => {
  const home = freshHome();
  const log = path.join(home, 'hooks.log').replaceAll('\\', '/');
  fs.writeFileSync(path.join(home, 'envs.yaml'), ENVS_YAML.replaceAll('{SETUP_LOG}', log));
  const envs = loadEnvPool(home);
  const def = envs.get('staging-a');

  const r1 = acquireLease(home, def, { taskId: 'P-20261117-1', runNo: 1 });
  assert.equal(r1.ok, true);
  const r2 = acquireLease(home, def, { taskId: 'P-20261117-2', runNo: 1 });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'busy');
  releaseLease(home, 'staging-a', 'P-20261117-1');
  const r3 = acquireLease(home, def, { taskId: 'P-20261117-2', runNo: 1 });
  assert.equal(r3.ok, true, '释放后可再取');
  releaseLease(home, 'staging-a', 'P-20261117-2');

  const text = fs.readFileSync(log, 'utf8');
  assert.ok(text.includes('setup'));
  assert.ok(text.includes('teardown'));
  // exclusive：一占用一释放 → setup/teardown 各一次
  assert.equal((text.match(/setup/g) || []).length, 2);
  assert.equal((text.match(/teardown/g) || []).length, 2);
});

test('租约：shared 计数并发 capacity=2，钩子仅 0→1 / N→0 跳变', () => {
  const home = freshHome();
  const log = path.join(home, 'hooks2.log').replaceAll('\\', '/');
  fs.writeFileSync(path.join(home, 'envs.yaml'), `
provider: static
environments:
  pool:
    acquire: shared
    capacity: 2
    setup: echo setup >> ${log}
    teardown: echo teardown >> ${log}
`);
  const envs = loadEnvPool(home);
  const def = envs.get('pool');
  assert.equal(acquireLease(home, def, { taskId: 'A', runNo: 1 }).ok, true);
  assert.equal(acquireLease(home, def, { taskId: 'B', runNo: 1 }).ok, true);
  assert.equal(acquireLease(home, def, { taskId: 'C', runNo: 1 }).ok, false, '第三份应 busy');
  releaseLease(home, 'pool', 'A');
  const t = fs.readFileSync(log, 'utf8');
  assert.equal((t.match(/teardown/g) || []).length, 0, 'N→0 前不 teardown');
  releaseLease(home, 'pool', 'B');
  assert.ok(fs.readFileSync(log, 'utf8').includes('teardown'), 'N→0 跳变 teardown');
});

test('孤儿回收：超 TTL 强制释放 + 事件重放重建', () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, 'envs.yaml'), 'provider: static\nenvironments:\n  e1:\n    acquire: exclusive\n');
  const envs = loadEnvPool(home);
  acquireLease(home, envs.get('e1'), { taskId: 'P-20261117-5', runNo: 1 });
  // isRunning=false → not-running 回收
  const swept = sweepOrphanLeases(home, { isRunning: () => false });
  assert.equal(swept.length, 1);
  assert.equal(swept[0].reason, 'not-running');
  assert.equal(readLeases(home).envs?.e1, undefined);

  acquireLease(home, envs.get('e1'), { taskId: 'P-20261117-6', runNo: 1 });
  const table = rebuildLeasesFromEvents(home);
  assert.ok(table.envs.e1.holders.some((h) => h.taskId === 'P-20261117-6'), '事件回放重建出租约');
});
