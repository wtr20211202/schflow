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

// 引擎零 npm 依赖守卫（分发自足）：引擎随插件分发后必须 node 直跑到底——
// ① package.json 无运行时依赖；② core/（vendor 除外）无 `yaml` 裸导入（只准相对路径走内置副本）；
// ③ 内置副本可审计：LICENSE 在、PROVENANCE 记录版本、package.json 的 commonjs 形态在。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { PKG_ROOT } from '../helpers.mjs';

const CORE = path.join(PKG_ROOT, 'core');
const VENDOR = path.join(CORE, 'vendor');
const VENDOR_YAML = path.join(VENDOR, 'yaml');

/** core/ 下全部源文件（排除 vendor/——内置第三方副本自身当然可以 require 自己）。 */
function coreSources(dir = CORE, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (p === VENDOR) continue;
    if (e.isDirectory()) coreSources(p, out);
    else if (/\.(?:mjs|cjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('package.json 无运行时依赖（引擎零 npm 依赖，node 直跑）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.deepEqual(deps, [], `引擎必须零运行时依赖（发现：${deps.join(', ')}）——yaml 已内置到 core/vendor/yaml/`);
  const vendored = JSON.parse(fs.readFileSync(path.join(VENDOR_YAML, 'package.json'), 'utf8'));
  assert.equal(vendored.type, 'commonjs', 'vendored package.json 必须声明 type=commonjs（dist/*.js 按 CJS 解析）');
});

test("core/（排除 vendor/）无 'yaml' 裸导入——只准相对路径引用内置副本", () => {
  const patterns = [
    /\bfrom\s+['"]yaml(?:\/[^'"]*)?['"]/,
    /\brequire\s*\(\s*['"]yaml(?:\/[^'"]*)?['"]\s*\)/,
    /\bimport\s*(?:\(\s*)?['"]yaml(?:\/[^'"]*)?['"]/,
  ];
  const offenders = [];
  for (const file of coreSources()) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (patterns.some((re) => re.test(line))) offenders.push(`${path.relative(PKG_ROOT, file).split(path.sep).join('/')}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `发现 yaml 裸导入（应改为 ../vendor/yaml/dist/index.js）：\n${offenders.join('\n')}`);
  const yamlfile = fs.readFileSync(path.join(CORE, 'lib', 'yamlfile.mjs'), 'utf8');
  assert.match(yamlfile, /from\s+'\.\.\/vendor\/yaml\/dist\/index\.js'/, 'core/lib/yamlfile.mjs 必须经相对路径导入内置副本');
});

test('内置副本可审计：LICENSE 在、PROVENANCE 记录版本', () => {
  const license = path.join(VENDOR_YAML, 'LICENSE');
  assert.ok(fs.existsSync(license), 'core/vendor/yaml/LICENSE 缺失（ISC 许可要求随附）');
  assert.ok(fs.statSync(license).size > 0, 'core/vendor/yaml/LICENSE 为空');
  const vendored = JSON.parse(fs.readFileSync(path.join(VENDOR_YAML, 'package.json'), 'utf8'));
  const provenance = fs.readFileSync(path.join(VENDOR_YAML, 'PROVENANCE.md'), 'utf8');
  const versionRe = new RegExp(vendored.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  assert.match(provenance, versionRe, `PROVENANCE.md 必须记录当前内置版本 ${vendored.version}`);
  assert.match(provenance, /ISC/, 'PROVENANCE.md 必须声明 ISC 许可');
  assert.match(provenance, /scripts\/sync-plugins\.sh/, 'PROVENANCE.md 必须交代再生成/同步命令');
});
