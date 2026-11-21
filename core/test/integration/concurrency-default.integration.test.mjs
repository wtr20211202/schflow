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

// 默认并发回归（P-20261121-3 A）：Profile 不写 concurrency 时槽位缺省 4——
// 5 个 approved 候选同轮派发恰 4 个，第 5 个以 slots-full 暂缓（--concurrency/Profile 覆盖能力不变）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, addTask, writeProfile } from '../helpers.mjs';

test('默认并发=4：Profile 未写 concurrency，5 个 approved 派 4 个、deferred 含 slots-full', async () => {
  const home = path.join(tmpdir('schflow-default-concurrency-'), 'home');
  fs.mkdirSync(home, { recursive: true });
  writeProfile(home, 'lab', { runner: 'fake' }); // 关键：不写 concurrency

  for (let i = 1; i <= 5; i++) {
    await addTask(home, {
      id: `P-20261121-${i}`, project: 'lab', kind: 'investigate', title: `缺省并发候选 ${i}`, status: 'approved',
    });
  }

  const d = run('dispatch', ['--auto', '--runner', 'fake', '--json'], { home });
  assert.equal(d.json.dispatched.length, 4, `应恰好派 4 个（缺省 4）：${d.stdout}`);
  assert.equal(d.json.deferred.length, 1, `第 5 个应暂缓：${d.stdout}`);
  const deferred = d.json.deferred[0];
  assert.equal(deferred.reason, 'slots-full', `暂缓原因应为 slots-full：${JSON.stringify(deferred)}`);
  assert.match(deferred.detail, /lab 4\/4/, `槽位明细应为 4/4：${JSON.stringify(deferred)}`);
  assert.ok(d.json.dispatched.every((x) => x.family === 'subprocess'), 'fake runner 属子进程家族');
});
