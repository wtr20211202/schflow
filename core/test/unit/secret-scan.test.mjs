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

// 出口扫描 allowlist 性质断言（P-20261120-6）：公开文档示例值放行、真实形态照拦、
// 其它模式零影响、混合 diff 逐匹配遍历（示例值不得遮蔽后续伪造值）。
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { secretScan } from '../../lib/secret-scan.mjs';

const diffOf = (...lines) => lines.map((l) => `+${l}`).join('\n') + '\n';

// 非放行值一律运行时拼装：本文件自身在出口扫描的增量 diff 内，字面量会被扫描器
// 拦下（P-20261120-6 合并期自指误报）；公开文档示例值可保留字面量——它们本就放行。
const FAKE_AWS_KEY = ['AKIA', 'Z7Q3XK9MNBVC2PLR'].join('');
const NEAR_MISS_EXAMPLE = ['AKIA', 'IOSFODNN7EXAMPLF'].join('');
const PRIVATE_KEY_HEADER = ['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----'].join('');

test('AKIA allowlist：两个 AWS 公开文档示例值放行（null）', () => {
  assert.equal(secretScan(diffOf('aws_key = AKIAIOSFODNN7EXAMPLE')), null);
  assert.equal(secretScan(diffOf('aws_key = AKIAI44QH8DHBEXAMPLE')), null);
});

test('AKIA allowlist 是精确匹配：同前缀非示例值照拦（未放宽模式）', () => {
  // 与示例值仅末位不同——不得按「AKIA 开头」整类放行
  assert.ok(secretScan(diffOf(`aws_key = ${NEAR_MISS_EXAMPLE}`)), '近似示例值必须命中');
  // 随机真实形态：AKIA + 16 位大写/数字
  const hit = secretScan(diffOf(`aws_key = ${FAKE_AWS_KEY}`));
  assert.ok(hit, '真实形态必须命中');
  assert.match(hit, /AKIA\[0-9A-Z\]\{16\}/, '命中描述带模式源');
  assert.match(hit, /AKIAZ7Q3XK9M/, '命中描述带值前缀（前 12 字符）');
});

test('其它模式不受 allowlist 影响：ghp_ token 与私钥块仍命中', () => {
  const ghp = secretScan(diffOf(`token = ghp_${'a'.repeat(36)}`));
  assert.ok(ghp && /ghp_/.test(ghp), 'ghp_ token 命中');
  assert.ok(secretScan(diffOf(PRIVATE_KEY_HEADER)), '私钥块命中');
  assert.ok(secretScan(diffOf(`api = AIza${'B'.repeat(35)}`)), 'AIza 命中');
});

test('混合场景：同一 diff 先示例值后伪造值 → 命中后者（逐匹配遍历语义）', () => {
  const diff = diffOf(
    'aws_key_doc = AKIAIOSFODNN7EXAMPLE',
    `aws_key_live = ${FAKE_AWS_KEY}`,
  );
  const hit = secretScan(diff);
  assert.ok(hit, '示例值不得遮蔽后续真实形态');
  assert.match(hit, /AKIAZ7Q3XK9M/, '命中指向伪造值而非示例值');
});

test('夹具源码不含未放行的敏感字面量（出口扫描自指回归）', () => {
  // 两文件都在本任务的增量 diff 内：非放行字面量会被自身扫描器拦下，必须运行时拼装。
  for (const f of [
    new URL('../../programs/executors/fake.mjs', import.meta.url),
    new URL(import.meta.url),
  ]) {
    assert.equal(secretScan(readFileSync(f, 'utf8')), null, `${f.pathname} 不得含未放行敏感字面量`);
  }
});
