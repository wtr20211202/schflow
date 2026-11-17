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

// claude-code 插件形态守卫（官方 plugin 结构）+ skills 内嵌拷贝与正典逐字节一致（防漂移）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { PKG_ROOT } from '../helpers.mjs';

const SKILLS = ['proposer', 'orchestrator', 'executor', 'improve'];
const PLUGIN_ROOT = path.join(PKG_ROOT, 'hosts', 'claude-code');

test('plugin.json 位于 .claude-plugin/ 且 name 与 marketplace 一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(pkg.name, 'schflow');
  assert.ok(pkg.description);
  const mkt = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(mkt.name, 'schflow');
  const entry = mkt.plugins.find((p) => p.name === 'schflow');
  assert.ok(entry, 'marketplace 需列出 schflow');
  assert.equal(entry.source, './hosts/claude-code');
  assert.ok(fs.existsSync(path.join(PKG_ROOT, entry.source, '.claude-plugin', 'plugin.json')), 'source 指向的插件根必须存在');
});

test('skills 内嵌拷贝与正典逐字节一致（改正典后需同步拷贝）', () => {
  for (const s of SKILLS) {
    const canon = fs.readFileSync(path.join(PKG_ROOT, 'skills', s, 'SKILL.md'));
    const copy = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', s, 'SKILL.md'));
    assert.ok(canon.equals(copy), `${s}/SKILL.md 漂移——请重新拷贝（rsync -a skills/$s hosts/claude-code/skills/）`);
  }
});

test('commands 与 agents 存在且 agents 为官方 .md 形态（frontmatter name/tools）', () => {
  for (const c of ['propose.md', 'board.md', 'tick.md']) {
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'commands', c)), `缺 command ${c}`);
  }
  const agent = fs.readFileSync(path.join(PLUGIN_ROOT, 'agents', 'schflow-executor.md'), 'utf8');
  assert.match(agent, /^---\nname: schflow-executor\n/m);
  assert.match(agent, /^tools: /m);
});
