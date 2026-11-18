// fold 宿主代收 L0 + 违规明细贯通性质断言：
// N1 机械可修形态代收：string[] deliverables → host-assist 事件 + done 收编（card.result 为修正后对象）
//    + 审计双档（executor 原件 result.json 一字不动、修正后侧写 result.normalized.json）；
// N2 修不动回炉贯通：unknown-field → interrupted + runs/<n>/violations.json 落盘 + 再派发的新任务书
//    prevRuns 段渲染「前次 result 违规」逐行清单（执行器自纠有明确靶子）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, addTask, pollFold } from '../helpers.mjs';

test('N1 机械可修形态代收：host-assist 事件 + done 收编 + 审计双档（原件未动）', async () => {
  const home = tmpdir('schflow-norm-a-', '');
  fs.mkdirSync(home, { recursive: true });
  await addTask(home, { id: 'P-20261118-6', kind: 'docs', title: '代收探针', status: 'approved' });
  run('dispatch', ['--task', 'P-20261118-6', '--runner', 'custom',
    '--runner-cmd', 'node -e "process.env.SCHFLOW_RUN_DIR&&require(\'node:fs\').writeFileSync(process.env.SCHFLOW_RUN_DIR+\'/result.json\', JSON.stringify({status:\'done\',summary:\'ok\',deliverables:[\'a.md\',\'b.md\']}))"'], { home });
  await pollFold(home, { expectCount: 1 });

  const { readEvents } = await import('../../lib/events.mjs');
  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');

  // host-assist 审计事件在（fixes 带 deliverables 修正面）；且 seq 上先代收修正后 folded 收编
  const events = readEvents(home, { types: ['host-assist', 'folded'] });
  const assist = events.find((e) => e.type === 'host-assist');
  assert.ok(assist, 'host-assist 事件在');
  assert.equal(assist.taskId, 'P-20261118-6');
  assert.equal(assist.runNo, 1);
  assert.deepEqual(assist.fixes, [{ field: 'deliverables', from: 'string[]', to: '[{path}]' }]);
  const folded = events.find((e) => e.type === 'folded');
  assert.equal(folded.outcome, 'done', '修正后走正常收编（非 interrupted）');
  assert.ok(assist.seq < folded.seq, '事件序：host-assist 先于 folded');

  // done 收编：card.result=修正后对象（非 git 轨道 docs 已归档，findTaskDir 覆盖归档区）
  const dir = findTaskDir(home, 'P-20261118-6');
  const card = loadCard(dir);
  assert.equal(card.status, 'done');
  assert.deepEqual(card.result.deliverables, [{ path: 'a.md' }, { path: 'b.md' }], 'card.result.deliverables 已归一');

  // 审计双档：executor 原件一字不动 + 修正后侧写
  const original = JSON.parse(fs.readFileSync(path.join(dir, 'runs', '1', 'result.json'), 'utf8'));
  assert.deepEqual(original.deliverables, ['a.md', 'b.md'], 'runs/1/result.json 原件未动（string[] 保留）');
  const normalized = JSON.parse(fs.readFileSync(path.join(dir, 'runs', '1', 'result.normalized.json'), 'utf8'));
  assert.deepEqual(normalized.deliverables, [{ path: 'a.md' }, { path: 'b.md' }], 'result.normalized.json 为修正后形态');
});

test('N2 修不动回炉贯通：violations.json 落盘 + 新任务书含违规明细与字段名', async () => {
  const home = tmpdir('schflow-norm-b-', '');
  fs.mkdirSync(home, { recursive: true });
  await addTask(home, { id: 'P-20261118-6', kind: 'docs', title: '回炉探针', status: 'approved' });
  run('dispatch', ['--task', 'P-20261118-6', '--runner', 'custom',
    '--runner-cmd', 'node -e "process.env.SCHFLOW_RUN_DIR&&require(\'node:fs\').writeFileSync(process.env.SCHFLOW_RUN_DIR+\'/result.json\', JSON.stringify({status:\'done\',summary:\'ok\',sneaky:1}))"'], { home });
  await pollFold(home, { expectCount: 1 });

  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');

  // unknown-field 不在白名单 → interrupted 回炉（approved），违规明细落盘
  const dir = findTaskDir(home, 'P-20261118-6');
  assert.equal(loadCard(dir).status, 'approved', '修不动=interrupted 回炉');
  const vFile = path.join(dir, 'runs', '1', 'violations.json');
  assert.ok(fs.existsSync(vFile), 'runs/1/violations.json 落盘');
  const v = JSON.parse(fs.readFileSync(vFile, 'utf8'));
  assert.equal(v.runNo, 1);
  assert.ok(v.violations.some((s) => String(s).startsWith('unknown-field: sneaky')), `违规含字段名：${JSON.stringify(v.violations)}`);
  assert.ok(typeof v.at === 'string');
  assert.ok(!fs.existsSync(path.join(dir, 'runs', '1', 'result.normalized.json')), '不修不侧写——无 host-assist 痕迹');

  // 再派发：新任务书 prevRuns 段渲染违规明细（--no-spawn 只生成任务书记账，宿主家族不 spawn）
  run('dispatch', ['--task', 'P-20261118-6', '--no-spawn'], { home });
  const book = fs.readFileSync(path.join(dir, 'runs', '2', 'task-book.md'), 'utf8');
  assert.match(book, /前次 result 违规（本次必改）/);
  assert.match(book, /unknown-field: sneaky/, '违规明细逐行渲染（字段名可见）');
});
