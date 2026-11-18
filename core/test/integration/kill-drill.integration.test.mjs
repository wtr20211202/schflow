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

// kill -9 崩溃演练（P-20261118-7）：真杀执行器进程 + 事件卷半截行注入，钉死 v1.0.24
// 崩溃自愈三面（断言只对齐既有承诺面：docs/spec/events.md、core/lib/events.mjs 头注释、core/README）：
//   ① fold interrupted 折叠——pid 死无 result → interrupted、池重写无残留、worktree 保全（决策 18 WIP）；
//   ② 重派——新任务书含前次 runs/1/ 引用（契约底线④），appendEvent seq 单调延续不归零
//      （半截行被 lastSeq 底部回扫跳过，J1-P3：归零会破坏全局单调）；
//   ③ readEvents 损坏行跳过并计数（malformed ≥1）但流可用（events.md 前向兼容承诺）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, mkToyRepo, addTask, writeProfile, sleep, pollFold } from '../helpers.mjs';
import { paths, ym } from '../../lib/home.mjs';
import { pidAlive } from '../../lib/runner.mjs';
import { appendEvent, lastSeq, readEvents } from '../../lib/events.mjs';

const TASK = 'P-20261118-9';

test('kill -9 演练：执行器被杀 → interrupted 折叠+WIP 保全 → 重派 runs/2 引用 runs/1 → seq 不归零', async () => {
  const dir = tmpdir('schflow-kill-');
  const home = path.join(dir, 'home');
  const repo = mkToyRepo(dir); // git 轨道保真：WIP 保全断言需要真 worktree
  fs.mkdirSync(home, { recursive: true });
  // custom runner 的 runner-cmd 写成 argv 数组（Profile 形态，零 shell 直启）：
  // 执行器=真 node 长睡子进程（不读任务书——占位 {book}/{cwd} 不参与，直接睡）。
  writeProfile(home, 'toy', {
    repo: repo.replaceAll('\\', '/'),
    'default-base': 'main',
    concurrency: 2,
    runner: 'custom',
    'runner-cmd': [process.execPath, '-e', 'setTimeout(()=>{},30000)'],
  });
  await addTask(home, { id: TASK, project: 'toy', title: 'kill 演练', status: 'approved' });

  // a) 派发：custom 执行器=真子进程，进池带 pid
  const d1 = run('dispatch', ['--task', TASK, '--json'], { home });
  assert.equal(d1.json.dispatched.length, 1, `应派发 1 项: ${d1.stdout}`);
  assert.equal(d1.json.dispatched[0].family, 'subprocess');
  const dispatched1 = readEvents(home, { types: ['dispatched'] }).find((e) => e.taskId === TASK);
  assert.equal(dispatched1.launcher, 'custom', 'dispatched 事件审计面：launcher=custom');
  const worktree = d1.json.dispatched[0].worktree;
  assert.ok(worktree, 'git 轨道任务带 worktree');

  // 从落盘面（state/pool.json）取 pid——fold 的活性判定同源
  const poolPath = paths(home).pool;
  let entry = null;
  for (let i = 0; i < 50 && !entry; i++) {
    if (fs.existsSync(poolPath)) {
      const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
      entry = (pool.inFlight ?? []).find((e) => e.taskId === TASK) ?? null;
    }
    if (!entry) await sleep(100);
  }
  assert.ok(entry, '池中出现该条目');
  assert.ok(entry.pid > 0, 'custom 子进程家族条目带 pid');
  assert.equal(pidAlive(entry.pid), true, 'kill 前执行器活着');

  try {
    // b) 真杀（Windows 上 SIGKILL 即无条件终止）
    process.kill(entry.pid, 'SIGKILL');
    const deadline = Date.now() + 5000;
    while (pidAlive(entry.pid) && Date.now() < deadline) await sleep(50);
    assert.equal(pidAlive(entry.pid), false, 'kill 后 pid 确死');

    // c) 同窗模拟另一 append 被杀：向当月事件卷直接追加半截行（无换行 JSON 片段）
    const vol = paths(home).eventsVolume(ym());
    assert.ok(fs.existsSync(vol), '事件卷已存在（dispatch 已写过事件）');
    const seqBeforeCorrupt = lastSeq(home);
    fs.appendFileSync(vol, '{"ts":"2026-01-01T00:00:00Z","seq":9'); // 半截行，无换行

    // d) fold：pid 死无 result → interrupted 折叠
    const f1 = run('fold', ['--json'], { home });
    const oc = (f1.json.outcomes ?? []).find((o) => o.id === TASK);
    assert.equal(oc?.outcome, 'interrupted', `应折 interrupted: ${f1.stdout}`);
    assert.equal(oc.reason, 'executor-died');
    // 池重写后无该条目
    const pool2 = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
    assert.equal((pool2.inFlight ?? []).some((e) => e.taskId === TASK), false, '池重写后无该条目');
    // WIP 保全（决策 18）：interrupted 不清工作树
    assert.ok(fs.existsSync(worktree), 'worktree 目录仍在（WIP 保全）');
    // 再跑 fold 无残留（池空，一次折叠即收敛）
    const f2 = run('fold', ['--json'], { home });
    assert.equal((f2.json.outcomes ?? []).length, 0, `再跑 fold 无残留: ${f2.stdout}`);
    // 折叠事件承诺面：folded{outcome=interrupted}
    const folded1 = readEvents(home, { types: ['folded'] }).filter((e) => e.taskId === TASK);
    assert.equal(folded1.length, 1);
    assert.equal(folded1[0].outcome, 'interrupted');
    // 卡回 approved（重派前提；attempts 不再加计——见 core/README attempts 语义）
    const { findTaskDir, loadCard } = await import('../../lib/store.mjs');
    const card = loadCard(findTaskDir(home, TASK));
    assert.equal(card.status, 'approved', 'interrupted 折叠回 approved');
    assert.equal(card.attempts, 1, 'interrupted 折叠不加计 attempts');

    // e) 再 dispatch 同任务（fake runner done，秒写 result）：新任务书含前次 runs/1/ 引用
    const d2 = run('dispatch', ['--task', TASK, '--runner', 'fake', '--json'], { home });
    assert.equal(d2.json.dispatched.length, 1, `重派成功: ${d2.stdout}`);
    assert.equal(d2.json.dispatched[0].runNo, 2, 'runNo=2（interrupted 折叠不占新号）');
    const book2 = fs.readFileSync(d2.json.dispatched[0].taskBook, 'utf8');
    assert.match(book2, /runs\/1\//, '新任务书含前次 runs/1/ 引用（契约底线④）');

    await pollFold(home, { expectCount: 2 }); // interrupted + done 两折叠
    const card2 = loadCard(findTaskDir(home, TASK));
    assert.equal(card2.status, 'done', '重派执行器 done 收编');

    // f) seq 单调延续不归零：半截行被底部回扫跳过，appendEvent 不出现 seq 重复/回退
    const seqBefore = lastSeq(home);
    assert.ok(seqBefore > seqBeforeCorrupt, `lastSeq 越过半截行继续单调（${seqBeforeCorrupt} → ${seqBefore}）`);
    const evt = appendEvent(home, { type: 'note.appended', actor: 'human', taskId: TASK, note: 'kill 演练收尾' });
    assert.equal(evt.seq, seqBefore + 1, 'appendEvent seq = lastSeq + 1（延续不归零）');

    // 全流可解析事件 seq 严格递增（无重复/回退）
    const all = readEvents(home);
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i].seq > all[i - 1].seq, `seq 严格递增（#${i - 1}=${all[i - 1].seq} → #${i}=${all[i].seq}）`);
    }
    // g) 损坏行跳过并计数（events.md 前向兼容承诺）：malformed ≥1 且正常事件可读
    assert.ok(all.malformed >= 1, `半截行被计为 malformed（实际 ${all.malformed}）`);
    assert.ok(all.some((e) => e.taskId === TASK && e.type === 'folded' && e.outcome === 'interrupted'), '正常事件仍可读');
  } finally {
    // 兜底：断言中途失败时不留 30s 长睡子进程（已死者 kill 抛 ESRCH，吞掉）
    try { if (pidAlive(entry.pid)) process.kill(entry.pid, 'SIGKILL'); } catch { /* 已死 */ }
  }
});
