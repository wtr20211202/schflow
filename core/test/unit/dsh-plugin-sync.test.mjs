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

// dsh 插件包一致性守卫（hosts/dsh/plugin）：skills/ 与 core/{lib,programs,vendor} 镜像必须与
// 仓库正典逐字节一致（递归双向比对，防漂移）；包声明必须指向存在的 patch 文件、覆盖
// skill-filesystem 配置，且 files 包含 core（引擎随包分发，装完即用）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { PKG_ROOT, mirrorDiff } from '../helpers.mjs';

const MIRRORED = ['skills', 'core/lib', 'core/programs', 'core/vendor'];
const PLUGIN_ROOT = path.join(PKG_ROOT, 'hosts', 'dsh', 'plugin');
const FIX = '跑 bash scripts/sync-plugins.sh 后重试';

test('plugin skills/ 与 core/{lib,programs,vendor} 镜像与正典逐字节一致（递归双向）', () => {
  const problems = MIRRORED.flatMap((rel) =>
    mirrorDiff(path.join(PKG_ROOT, rel), path.join(PLUGIN_ROOT, rel)).map((p) => `${rel}: ${p}`),
  );
  assert.ok(problems.length === 0, `插件镜像漂移——${FIX}：\n${problems.join('\n')}`);
});

test('plugin package.json 声明 dsh.bundle.patch 且文件存在、覆盖 skill-filesystem、files 含 core', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'schflow-dsh-plugin');
  const patchRel = pkg.dsh?.bundle?.patch;
  assert.equal(patchRel, './cordis.patch.yml');
  const patch = fs.readFileSync(path.join(PLUGIN_ROOT, patchRel), 'utf8');
  assert.match(patch, /id: skill-filesystem/);
  assert.match(patch, /customSkillDirs/);
  assert.match(patch, /SCHFLOW_SKILLS_DIR/);
  assert.ok(pkg.files?.includes('core'), 'files 必须包含 core（引擎随包分发，node <pkg>/core/programs/*.mjs 零 npm 依赖）');
});
