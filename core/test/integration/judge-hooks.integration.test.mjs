// 金场景 #G6 · M3 判断钩子（R1）性质断言：
// P22 受阻分诊落事件：blocked 折叠事件带 triage/triageSignals/triageHint（分诊结论可审计）；
// P23 harvest 转生闭环：done 的 investigate 含 schflow:spawn 块 → fix 提案自动入库
// （血缘 harvestSource、沿用 repo/base/project、status=pending 走评审闸、幂等不重发、
//   转生卡过 validate-task 且 status 全绿）；
// P23b --all 归档源可见 + 幂等锚覆盖归档（源归档后重跑不重发）；P23c 无块不转生（fail-soft）。
// P24 dispatch --retry：env-retry 原子重派闭环 + 拒绝面；
// P25 dispatch --plan：只读候选预演（judge①/⑥ 派发前裁决的候选面——零状态变更零事件）。
// P26 dispatch --plan 依赖判定归档面回退：已归档 done 依赖=可派 / open pending=deps-pending / 不存在=deps-unknown。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, mkToyRepo, addTask, writeProfile, pollFold } from '../helpers.mjs';

test('P22 受阻分诊：折叠事件带分诊结论（配额→env-retry）', async () => {
  const home = tmpdir('schflow-g6a-', '');
  fs.mkdirSync(home, { recursive: true });
  await addTask(home, { id: 'P-20261117-1', kind: 'docs', title: '受阻探针', status: 'approved' });
  run('dispatch', ['--task', 'P-20261117-1', '--runner', 'custom',
    '--runner-cmd', 'node -e "process.env.SCHFLOW_RUN_DIR&&require(\'node:fs\').writeFileSync(process.env.SCHFLOW_RUN_DIR+\'/result.json\', JSON.stringify({status:\'blocked\',summary:\'API Error: Request rejected (429) quota exceeded\',flags:{quota:true}}))"'], { home });
  await pollFold(home, { expectCount: 1 });

  const { readEvents } = await import('../../lib/events.mjs');
  const folded = readEvents(home, { types: ['folded'] }).find((e) => e.outcome === 'blocked');
  assert.ok(folded, 'blocked 折叠事件在');
  assert.equal(folded.triage, 'env-retry', `P22：配额 flags → env-retry（got ${folded.triage}）`);
  assert.ok(Array.isArray(folded.triageSignals) && folded.triageSignals.length >= 1);
  assert.match(folded.triageHint, /重派|dispatch/);
});

test('P23 harvest 闭环：RCA 报告转生块 → fix 提案入库（血缘+幂等）', async () => {
  const { resolveHome } = await import('../../lib/home.mjs');
  const { createTask, findTaskDir, loadCard, transition } = await import('../../lib/store.mjs');
  const home = tmpdir('schflow-g6b-', '');
  resolveHome(home);

  // 源 investigate 任务：done + deliverables/rca-*.md 含转生块
  await addTask(home, { id: 'P-20261117-1', kind: 'investigate', title: '登录超时排查' });
  const dir = findTaskDir(home, 'P-20261117-1');
  transition(home, 'P-20261117-1', 'approved', { actor: 'human' });
  transition(home, 'P-20261117-1', 'running', { actor: 'engine' });
  transition(home, 'P-20261117-1', 'done', { actor: 'engine' });
  fs.mkdirSync(path.join(dir, 'deliverables'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deliverables', 'rca-login-timeout.md'), [
    '# RCA：登录超时', '', '## 结论', '', '根因是会话中间件的超时配置错误。', '',
    '<!-- schflow:spawn',
    'title: 修复会话中间件 30s 超时配置错误',
    'kind: fix',
    'priority: high',
    'rationale: RCA 指认的根因修复',
    '-->',
    '将 session middleware 的 timeout 从 30s 调到 90s 并加告警。',
    '<!-- /schflow:spawn -->',
  ].join('\n'));

  // 首次 harvest：转生一条 fix
  const h1 = run('harvest', ['--task', 'P-20261117-1', '--json'], { home });
  assert.equal(h1.json.results.filter((r) => r.spawned).length, 1, `转生一条：${h1.stdout}`);
  const spawnedId = h1.json.results.find((r) => r.spawned).spawned;

  const { findTaskDir: f2, loadCard: l2 } = await import('../../lib/store.mjs');
  const newDir = f2(home, spawnedId);
  const newCard = l2(newDir);
  assert.equal(newCard.kind, 'fix');
  assert.equal(newCard.status, 'pending', '转生走评审闸（pending 非直接 approved）');
  assert.equal(newCard.source.type, 'harvest');
  assert.equal(newCard.harvestSource, 'harvest:P-20261117-1#1', '血缘锚');
  const proposal = fs.readFileSync(path.join(newDir, 'proposal.md'), 'utf8');
  assert.match(proposal, /harvest 自 \*\*P-20261117-1\*\*/);
  assert.match(proposal, /session middleware/);

  // 转生卡过 intake 同一门禁 + status 全绿（不再毒化 fail-closed 面——实测旧版一条转生卡即冻结索引重建）
  const v = run('validate-task', ['--task', spawnedId, '--json'], { home });
  assert.equal(v.code, 0, `转生卡过 validate-task：${v.stdout || v.stderr}`);
  const st = run('status', [], { home });
  assert.equal(st.code, 0, `status 全绿（转生卡不再触发 fail-closed）：${st.stdout || st.stderr}`);

  // 幂等：再跑不重发
  const h2 = run('harvest', ['--task', 'P-20261117-1', '--json'], { home });
  assert.equal(h2.json.results.filter((r) => r.spawned).length, 0, 'P23：重复运行不重发');
  assert.ok(h2.json.results.some((r) => /already spawned/.test(r.note)));
});

test('P23b harvest --all：归档源可见 + 幂等锚覆盖归档（源归档后重跑不重发）', async () => {
  const { resolveHome } = await import('../../lib/home.mjs');
  const { findTaskDir, loadCard, transition, archiveTask, isArchived } = await import('../../lib/store.mjs');
  const home = tmpdir('schflow-g6d-', '');
  resolveHome(home);

  // 源 research 任务：done → 归档（调查类非 git 轨道，fold done 即归档的同构路径）
  await addTask(home, { id: 'P-20261118-1', kind: 'research', title: '调度策略调研' });
  transition(home, 'P-20261118-1', 'approved', { actor: 'human' });
  transition(home, 'P-20261118-1', 'running', { actor: 'engine' });
  transition(home, 'P-20261118-1', 'done', { actor: 'engine' });
  const dir = findTaskDir(home, 'P-20261118-1');
  fs.mkdirSync(path.join(dir, 'deliverables'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deliverables', 'rca-scheduling.md'), [
    '# 调研报告：调度策略', '', '## 结论', '', 'time-slice 策略在该负载下吞吐最优。', '',
    '<!-- schflow:spawn',
    'title: 试点 time-slice 调度策略',
    'rationale: 调研结论指认可试点',
    '-->',
    '按报告 §3 参数表试点。',
    '<!-- /schflow:spawn -->',
  ].join('\n'));
  archiveTask(home, 'P-20261118-1');
  assert.ok(isArchived(home, 'P-20261118-1'), '源已进 done/<YYYY-MM>/ 归档区');

  // --all 命中归档源（旧实现只扫 open——调查任务一 done 即归档，--all 永远零源）
  const h1 = run('harvest', ['--all', '--json'], { home });
  const spawned = h1.json.results.filter((r) => r.spawned);
  assert.equal(spawned.length, 1, `--all 应命中归档源：${h1.stdout}`);
  const newCard = loadCard(findTaskDir(home, spawned[0].spawned));
  assert.equal(newCard.harvestSource, 'harvest:P-20261118-1#1', '血缘锚');
  assert.equal(newCard.status, 'pending', '转生走评审闸');

  // 归档源重跑不重发（幂等锚检查覆盖归档区）
  const h2 = run('harvest', ['--all', '--json'], { home });
  assert.equal(h2.json.results.filter((r) => r.spawned).length, 0, '归档源重跑不重发');
  assert.ok(h2.json.results.some((r) => /already spawned/.test(r.note)));
});

test('P23c harvest 无块不转生：报告无显式 spawn 块 → spawned 0（fail-soft，程序不猜自由文本）', async () => {
  const { resolveHome } = await import('../../lib/home.mjs');
  const { findTaskDir, transition } = await import('../../lib/store.mjs');
  const home = tmpdir('schflow-g6e-', '');
  resolveHome(home);

  await addTask(home, { id: 'P-20261117-2', kind: 'investigate', title: '无块调查' });
  transition(home, 'P-20261117-2', 'approved', { actor: 'human' });
  transition(home, 'P-20261117-2', 'running', { actor: 'engine' });
  transition(home, 'P-20261117-2', 'done', { actor: 'engine' });
  const dir = findTaskDir(home, 'P-20261117-2');
  fs.mkdirSync(path.join(dir, 'deliverables'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deliverables', 'rca-notes.md'), '# 结论\n\n根因是 X，建议修 Y。（自由文本建议——无显式转生块）\n');

  const h = run('harvest', ['--task', 'P-20261117-2', '--json'], { home });
  assert.equal(h.json.results.filter((r) => r.spawned).length, 0, '无块不转生');
  assert.ok(h.json.results.some((r) => /no schflow:spawn blocks/.test(r.note)), `fail-soft 注记：${h.stdout}`);
});

test('P24 dispatch --retry：env-retry 原子重派闭环（回炉+派发一体）+ 三拒绝面', async () => {
  const home = tmpdir('schflow-g6c-', '');
  fs.mkdirSync(home, { recursive: true });
  await addTask(home, { id: 'P-20261117-1', kind: 'docs', title: '配额受阻任务', status: 'approved' });
  run('dispatch', ['--task', 'P-20261117-1', '--runner', 'custom',
    '--runner-cmd', 'node -e "process.env.SCHFLOW_RUN_DIR&&require(\'node:fs\').writeFileSync(process.env.SCHFLOW_RUN_DIR+\'/result.json\', JSON.stringify({status:\'blocked\',summary:\'429 quota wall hit\',flags:{quota:true}}))"'], { home });
  await pollFold(home, { expectCount: 1 });

  // triage 落卡（P22b）：blocked 卡带 triage=env-retry
  const { findTaskDir, loadCard, transition } = await import('../../lib/store.mjs');
  let card = loadCard(findTaskDir(home, 'P-20261117-1'));
  assert.equal(card.triage, 'env-retry', 'P22b：分诊结论落卡');

  // --retry：回炉 approved 并派发（一体）
  const r = run('dispatch', ['--retry', 'P-20261117-1', '--runner', 'fake', '--fake-mode', 'done', '--json'], { home });
  assert.equal(r.json.dispatched.length, 1, `--retry 应派发成功：${r.stdout}`);
  assert.equal(loadCard(findTaskDir(home, 'P-20261117-1')).status, 'running');

  // 三拒绝面
  await pollFold(home, { expectCount: 2 }); // 第二轮 done
  const doneCard = loadCard(findTaskDir(home, 'P-20261117-1'));
  assert.equal(doneCard.status, 'done');

  // 非 blocked 拒绝
  const rej1 = run('dispatch', ['--retry', 'P-20261117-1'], { home, expectFail: true });
  assert.equal(rej1.code, 76);
  assert.match(rej1.stderr, /仅适用于 blocked/);
});

test('P25 dispatch --plan：只读预演（可派+依赖未解除+租约无匹配）+ pool/事件流/任务卡三面零变更', async () => {
  const dir = tmpdir('schflow-g6d-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const repo = mkToyRepo(dir);
  writeProfile(home, 'toy', `repo: ${repo.replaceAll('\\', '/')}\ndefault-base: main\nrunner: fake\n`);
  await addTask(home, { id: 'P-20261117-1', kind: 'code', project: 'toy', title: '可派任务', status: 'approved' });
  await addTask(home, { id: 'P-20261117-2', kind: 'docs', title: '未终结依赖本体', status: 'pending' });
  await addTask(home, { id: 'P-20261117-3', kind: 'docs', title: '依赖未解除任务', status: 'approved', dependsOn: ['P-20261117-2'] });
  await addTask(home, { id: 'P-20261117-4', kind: 'docs', title: '租约无匹配任务', status: 'approved', env: 'no-such-env' });

  const { findTaskDir, loadCard } = await import('../../lib/store.mjs');
  // 三面前快照：任务卡（全文）+ pool + 事件流（+leases，租约面）
  const snapshot = () => JSON.stringify({
    cards: ['P-20261117-1', 'P-20261117-2', 'P-20261117-3', 'P-20261117-4'].map((id) => loadCard(findTaskDir(home, id))),
    pool: fs.existsSync(path.join(home, 'state', 'pool.json')) ? fs.readFileSync(path.join(home, 'state', 'pool.json'), 'utf8') : null,
    leases: fs.existsSync(path.join(home, 'state', 'leases.json')) ? fs.readFileSync(path.join(home, 'state', 'leases.json'), 'utf8') : null,
    events: fs.readdirSync(home).filter((f) => /^events-.*\.jsonl$/.test(f)).flatMap((f) => fs.readFileSync(path.join(home, f), 'utf8').split('\n').filter(Boolean)),
  });
  const before = snapshot();

  const r = run('dispatch', ['--plan', '--json'], { home });
  assert.equal(r.code, 0, `预演恒 0（暂缓≠业务失败）：${r.stdout}`);
  assert.ok(Array.isArray(r.json.plan), `--json 形态 {plan:[…]}：${r.stdout}`);
  // 候选=approved 全体（优先级/FIFO 同真实派发序；pending 的 P-2 不入候选）
  assert.deepEqual(r.json.plan.map((e) => e.id), ['P-20261117-1', 'P-20261117-3', 'P-20261117-4'], `候选集与序：${JSON.stringify(r.json.plan)}`);
  const byPlan = new Map(r.json.plan.map((e) => [e.id, e]));
  assert.deepEqual(byPlan.get('P-20261117-1'), { id: 'P-20261117-1', wouldDispatch: true, reason: null }, '可派候选=将派发');
  assert.deepEqual(byPlan.get('P-20261117-3'), { id: 'P-20261117-3', wouldDispatch: false, reason: 'deps-pending', detail: 'pending' }, '依赖未解除=暂缓+原因');
  assert.deepEqual(byPlan.get('P-20261117-4'), { id: 'P-20261117-4', wouldDispatch: false, reason: 'env-none-matched', detail: 'no-such-env' }, '租约无匹配=暂缓+原因');

  // 人读形态同源（幂等二跑）
  const t = run('dispatch', ['--plan'], { home });
  assert.equal(t.code, 0);
  assert.match(t.stdout, /P-20261117-1 将派发/);
  assert.match(t.stdout, /P-20261117-3 暂缓 deps-pending/);

  // 三面零变更：任务卡/pool/事件流（+leases）plan 前后一字节不动
  assert.equal(snapshot(), before, 'P25：plan 前后 pool/事件流/任务卡三面不变');
  // 副作用面：worktree 未建、HOME 写锁未留
  assert.ok(!fs.existsSync(path.join(dir, '.schflow-worktrees', 'toyrepo', 'P-20261117-1')), 'plan 不建 worktree');
  assert.equal(fs.readdirSync(path.join(home, 'state', 'locks')).length, 0, 'plan 不占 HOME 写锁');

  // 互斥：--plan 与 --retry（retry 回炉 approved 是状态变更，与只读预演不相容）
  const rej = run('dispatch', ['--plan', '--retry', 'P-20261117-1'], { home, expectFail: true });
  assert.equal(rej.code, 2);
  assert.match(rej.stderr, /互斥/);
});

test('P26 dispatch --plan 依赖判定归档面回退：归档 done=可派 / open pending=deps-pending / 不存在=deps-unknown / 回退纯读零变更', async () => {
  const home = tmpdir('schflow-g6f-');
  fs.mkdirSync(home, { recursive: true });
  const { resolveHome } = await import('../../lib/home.mjs');
  const { findTaskDir, loadCard, transition, archiveTask, isArchived } = await import('../../lib/store.mjs');
  resolveHome(home);

  // 依赖本体：done → 归档（与 fold done 即归档同构）——open 面查不到，只能走归档回退
  await addTask(home, { id: 'P-20261119-1', kind: 'docs', title: '已归档完成依赖' });
  transition(home, 'P-20261119-1', 'approved', { actor: 'human' });
  transition(home, 'P-20261119-1', 'running', { actor: 'engine' });
  transition(home, 'P-20261119-1', 'done', { actor: 'engine' });
  archiveTask(home, 'P-20261119-1');
  assert.ok(isArchived(home, 'P-20261119-1'), '依赖本体已进 done/<YYYY-MM>/ 归档区（open 面不可见）');

  await addTask(home, { id: 'P-20261119-2', kind: 'docs', title: 'open 面未终结依赖', status: 'pending' });
  await addTask(home, { id: 'P-20261119-3', kind: 'docs', title: '依赖已归档任务', status: 'approved', dependsOn: ['P-20261119-1'] });
  await addTask(home, { id: 'P-20261119-4', kind: 'docs', title: '依赖 open 未终结任务', status: 'approved', dependsOn: ['P-20261119-2'] });
  await addTask(home, { id: 'P-20261119-5', kind: 'docs', title: '依赖不存在任务', status: 'approved', dependsOn: ['P-20990101-9'] });

  // 三面（+归档卡）+ 租约面前快照：任务卡（全文，含归档卡）/ pool / 事件流 / leases
  const ids = ['P-20261119-1', 'P-20261119-2', 'P-20261119-3', 'P-20261119-4', 'P-20261119-5'];
  const snapshot = () => JSON.stringify({
    cards: ids.map((id) => loadCard(findTaskDir(home, id))),
    pool: fs.existsSync(path.join(home, 'state', 'pool.json')) ? fs.readFileSync(path.join(home, 'state', 'pool.json'), 'utf8') : null,
    leases: fs.existsSync(path.join(home, 'state', 'leases.json')) ? fs.readFileSync(path.join(home, 'state', 'leases.json'), 'utf8') : null,
    events: fs.readdirSync(home).filter((f) => /^events-.*\.jsonl$/.test(f)).flatMap((f) => fs.readFileSync(path.join(home, f), 'utf8').split('\n').filter(Boolean)),
  });
  const before = snapshot();

  const r = run('dispatch', ['--plan', '--json'], { home });
  assert.equal(r.code, 0, `预演恒 0：${r.stdout}${r.stderr}`);
  const byPlan = new Map(r.json.plan.map((e) => [e.id, e]));
  // 归档 done 依赖=已解除（修复前只查 open 面 → 误报 deps-unknown，依赖永远无法解除）
  assert.deepEqual(byPlan.get('P-20261119-3'), { id: 'P-20261119-3', wouldDispatch: true, reason: null }, '依赖已归档 done=可派');
  // open 面 pending 维持既有语义（不得为通过测试而放宽）
  assert.deepEqual(byPlan.get('P-20261119-4'), { id: 'P-20261119-4', wouldDispatch: false, reason: 'deps-pending', detail: 'pending' }, 'open 面 pending=deps-pending');
  // 两面对不上=真未知
  assert.deepEqual(byPlan.get('P-20261119-5'), { id: 'P-20261119-5', wouldDispatch: false, reason: 'deps-unknown' }, '依赖 id 不存在=deps-unknown');

  // 归档回退为纯读：plan 前后任务卡（含归档卡）/事件流/pool/租约一字节不变
  assert.equal(snapshot(), before, 'P26：plan 前后任务卡/事件流/pool/租约不变（归档回退零写入）');
});
