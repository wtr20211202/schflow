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

// 金场景 #G4 通用 custom runner · argv 数组形态（v1.0.14 跨平台纪律）：
// Profile 的 runner-cmd 写成数组 → 零 shell 直启（引号/重定向平台语义不参与），任务书路径按占位替换。
// 性质断言：派发成功（argv 直启）→ 执行器写 result.json → fold done → 非 git 任务归档。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, addTask, writeProfile, pollFold } from '../helpers.mjs';

test('custom runner argv 数组：零 shell 启动 + 四态收编', async () => {
  const home = path.join(tmpdir('schflow-g4-'), 'home');
  fs.mkdirSync(home, { recursive: true });
  const script = "const fs=require('node:fs');fs.writeFileSync(process.env.SCHFLOW_RUN_DIR+'/result.json',JSON.stringify({status:'done',summary:'array runner ok',deliverables:[{path:'deliverables/r.md',type:'report'}]}))";
  writeProfile(home, 'lab', {
    runner: 'custom',
    'runner-cmd': [process.execPath, '-e', script],
  });
  await addTask(home, { id: 'P-20261117-1', project: 'lab', kind: 'investigate', title: '数组启动器探针', status: 'approved' });

  const d = run('dispatch', ['--auto', '--json'], { home });
  assert.equal(d.json.dispatched.length, 1, `应派发成功（argv 直启）：${d.stdout}`);
  assert.equal(d.json.dispatched[0].pid > 0, true);

  await pollFold(home, { expectCount: 1 });
  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');
  const dir = findTaskDir(home, 'P-20261117-1');
  assert.ok(dir.includes(`${path.sep}done${path.sep}`), '非 git 任务 done 即归档');
  const card = loadCard(dir);
  assert.equal(card.status, 'done');
  assert.equal(card.result.status, 'done');
  assert.match(card.result.summary, /array runner ok/);
});
