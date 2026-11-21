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

// intake 面集成：next-id 原子取号 → event 追加 → status fail-closed → validate-task 机械拒绝 → dup-check 双通道。
// 性质断言（金场景 #I1）：取号连续且同日重置语义存在（跨日不在此测）；status 违规时索引不重建。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, addTask } from '../helpers.mjs';

test('intake：取号→建件→门禁→索引 全链性质', async () => {
  const home = tmpdir('schflow-intake-');
  const id1 = run('next-id', [], { home }).stdout.trim();
  const id2 = run('next-id', [], { home }).stdout.trim();
  assert.match(id1, /^P-\d{8}-1$/);
  assert.match(id2, /^P-\d{8}-2$/);

  await addTask(home, { id: id1, title: '优化上传进度显示', status: 'approved' });

  // validate-task 通过
  const v = run('validate-task', ['--task', id1], { home });
  assert.match(v.stdout, /通过/);

  // dup-check：近似标题命中 + 锚点命中（告警非拒绝：exit 0）
  const d1 = run('dup-check', ['--title', '优化上传进度的呈现', '--json'], { home });
  assert.equal(d1.code, 0);
  assert.ok(d1.json.hits.some((h) => h.id === id1 && h.score > 0.4), `jaccard 命中: ${JSON.stringify(d1.json)}`);
  const d2 = run('dup-check', ['--title', '完全无关的另一个任务', '--anchor', '上传进度', '--json'], { home });
  assert.ok(d2.json.hits.some((h) => h.id === id1 && h.matchedAnchors.includes('上传进度')), '实锚命中');

  // event 追加 + seq 递增
  const body = path.join(home, 'evt.json');
  fs.writeFileSync(body, JSON.stringify({ type: 'heartbeat.tick', actor: 'engine', gapMin: 0 }));
  const e1 = run('event', ['--body-file', body], { home });
  assert.match(e1.stdout, /seq=\d+/);
  const e2 = run('event', ['--body-file', body], { home });
  const s1 = Number(e1.stdout.match(/seq=(\d+)/)[1]);
  const s2 = Number(e2.stdout.match(/seq=(\d+)/)[1]);
  assert.equal(s2, s1 + 1);

  // status：健康=重建索引
  run('status', [], { home });
  assert.ok(fs.existsSync(path.join(home, 'index', 'tasks.json')));

  // fail-closed：坏卡 → exit 76 且索引时间戳不变
  const idxBefore = fs.statSync(path.join(home, 'index', 'tasks.json')).mtimeMs;
  const { writeYaml } = await import('../../lib/yamlfile.mjs');
  const cardPath = path.join(home, 'tasks', 'open', id2, 'task.yaml');
  fs.mkdirSync(path.dirname(cardPath), { recursive: true });
  writeYaml(cardPath, { id: id2, kind: 'nonsense', title: '', status: 'weird', priority: 'high' });
  const st = run('status', [], { home, expectFail: true });
  assert.equal(st.code, 76);
  assert.match(st.stderr, /fail-closed/);
  assert.equal(fs.statSync(path.join(home, 'index', 'tasks.json')).mtimeMs, idxBefore, '校验失败不重建索引');
});

test('validate-task：highest 非 human 机械拒绝（exit 76）', async () => {
  const home = tmpdir('schflow-intake2-');
  const { resolveHome } = await import('../../lib/home.mjs');
  resolveHome(home); // 幂等自举（八程序约定：无 setup/init，mkdir -p）
  const id = 'P-20261117-1';
  const card = {
    id, kind: 'code', title: '测试', status: 'pending', priority: 'highest',
    source: { type: 'generator', trust: 'semi' }, dependsOn: [], sessionOnly: false, attempts: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const { createTask } = await import('../../lib/store.mjs');
  createTask(home, card);
  const r = run('validate-task', ['--task', id], { home, expectFail: true });
  assert.equal(r.code, 76);
  assert.match(r.stderr, /priority-highest-nonhuman/);
});

test('validate-task：author=model 无「评审：」行 → 76（review-missing）；有则通过；旧卡不走评审闸', async () => {
  const home = tmpdir('schflow-intake3-');
  const source = { type: 'human', trust: 'trusted', author: 'model' };

  await addTask(home, { id: 'P-20261121-1', kind: 'docs', title: '模型代笔无评审', source },
    '# 提案\n\n动机：测试。\n');
  const r = run('validate-task', ['--task', 'P-20261121-1'], { home, expectFail: true });
  assert.equal(r.code, 76, `缺评审行=76：${r.stdout || r.stderr}`);
  assert.match(r.stderr, /review-missing/, '违规码点名 review-missing');

  await addTask(home, { id: 'P-20261121-2', kind: 'docs', title: '模型代笔有评审', source },
    '# 提案\n\n动机：测试。\n\n评审：通过——值得做且方案最简。\n');
  const ok = run('validate-task', ['--task', 'P-20261121-2'], { home });
  assert.match(ok.stdout, /通过/, '评审行在=通过');

  await addTask(home, { id: 'P-20261121-3', kind: 'docs', title: 'human 自己写全文' });
  const human = run('validate-task', ['--task', 'P-20261121-3'], { home });
  assert.match(human.stdout, /通过/, '无 author 的旧卡行为不变');
});

test('status fail-closed：model 卡手工置 approved 且无 approvedBy → exit 76（approval-missing）', async () => {
  const home = tmpdir('schflow-intake4-');
  const id = 'P-20261121-9';
  await addTask(home, {
    id, kind: 'docs', title: '手工置批准',
    source: { type: 'human', trust: 'trusted', author: 'model' },
  }, '# 提案\n\n评审：通过\n');

  // 绕过 decide 直改卡面：状态已 approved，但没有批准痕迹
  const { loadCard } = await import('../../lib/store.mjs');
  const { writeYaml } = await import('../../lib/yamlfile.mjs');
  const cardPath = path.join(home, 'tasks', 'open', id, 'task.yaml');
  writeYaml(cardPath, { ...loadCard(path.dirname(cardPath)), status: 'approved' });

  const st = run('status', [], { home, expectFail: true });
  assert.equal(st.code, 76, `fail-closed exit 76：${st.stdout || st.stderr}`);
  assert.match(st.stderr, /approval-missing/, 'status 拒绝无批准痕迹的 approved 卡');
});
