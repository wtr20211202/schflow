// 分诊分类器性质断言（M3 judge③）：
// P17 flags 显式声明优先于信号词；P18 凭据/权限信号→依赖类（重试无用）；P19 配额/网络→环境类；
// P20 判不了→设计类（fail-closed 缺省，绝不自动重试循环）；P21 双命中取依赖类（更具体）。
import test from 'node:test';
import assert from 'node:assert';
import { triageBlocked, TRIAGE } from '../../lib/triage.mjs';

test('P17: flags 显式声明最优先', () => {
  const r = triageBlocked({ status: 'blocked', summary: 'missing credential for upstream', flags: { quota: true } });
  assert.equal(r.triage, TRIAGE.ENV, 'flags.quota 压过 summary 里的凭据信号');
  assert.ok(r.signals[0].startsWith('flags:'));
  const r2 = triageBlocked({ status: 'blocked', summary: 'rate limit hit', flags: { needsHuman: true } });
  assert.equal(r2.triage, TRIAGE.DESIGN);
});

test('P18: 凭据/权限/上游缺失 → 依赖类', () => {
  for (const summary of [
    'MISSING_CREDENTIAL: no API key for provider route',
    'upstream service returned 403',
    'waiting for approval from security team',
  ]) {
    const r = triageBlocked({ status: 'blocked', summary });
    assert.equal(r.triage, TRIAGE.DEP, summary);
    assert.ok(r.signals.length >= 1);
  }
});

test('P19: 配额墙/网络/超时 → 环境类（可自动重试）', () => {
  for (const summary of [
    'API Error: Request rejected (429) · 已达到 5 小时的使用上限',
    'connection reset by peer during npm install',
    'request timed out after 30s',
  ]) {
    const r = triageBlocked({ status: 'blocked', summary });
    assert.equal(r.triage, TRIAGE.ENV, summary);
  }
});

test('P20: 判不了 → 设计类（fail-closed 缺省）', () => {
  const r = triageBlocked({ status: 'blocked', summary: '方案需要改动公共 API 形态，牵连三个调用方' });
  assert.equal(r.triage, TRIAGE.DESIGN);
  assert.equal(r.signals.length, 0);
});

test('P21: 双命中取依赖类（更具体压过环境类）', () => {
  const r = triageBlocked({ status: 'blocked', summary: 'connection reset while fetching upstream dependency (api key missing)' });
  assert.equal(r.triage, TRIAGE.DEP);
});

test('真实案例回放：Cycle D dsh 沙箱受阻应判依赖类', () => {
  const r = triageBlocked({
    status: 'blocked',
    summary: 'git commit rejected by workspace-write sandbox: worktree .git metadata outside workspace',
  });
  assert.notEqual(r.triage, TRIAGE.ENV, '沙箱边界不是重试可自愈');
});
