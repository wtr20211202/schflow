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

// dsh 插件包一致性守卫（hosts/dsh/plugin）：skills 拷贝必须与仓库正典逐字节一致（防漂移），
// 包声明必须指向存在的 patch 文件且覆盖 skill-filesystem 配置（bundle 形态自检）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { PKG_ROOT } from '../helpers.mjs';

const SKILLS = ['proposer', 'orchestrator', 'executor', 'improve', 'audit'];

test('plugin skills 与正典 skills/ 逐字节一致（改正典后需同步拷贝）', () => {
  for (const s of SKILLS) {
    const canon = fs.readFileSync(path.join(PKG_ROOT, 'skills', s, 'SKILL.md'));
    const copy = fs.readFileSync(path.join(PKG_ROOT, 'hosts', 'dsh', 'plugin', 'skills', s, 'SKILL.md'));
    assert.ok(canon.equals(copy), `${s}/SKILL.md 漂移——请重新拷贝（rsync -a skills/$s hosts/dsh/plugin/skills/）`);
  }
});

test('plugin package.json 声明 dsh.bundle.patch 且文件存在、覆盖 skill-filesystem', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'hosts', 'dsh', 'plugin', 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'schflow-dsh-plugin');
  const patchRel = pkg.dsh?.bundle?.patch;
  assert.equal(patchRel, './cordis.patch.yml');
  const patch = fs.readFileSync(path.join(PKG_ROOT, 'hosts', 'dsh', 'plugin', patchRel), 'utf8');
  assert.match(patch, /id: skill-filesystem/);
  assert.match(patch, /customSkillDirs/);
  assert.match(patch, /SCHFLOW_SKILLS_DIR/);
});
