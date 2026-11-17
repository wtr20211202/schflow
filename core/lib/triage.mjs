// judge③ 受阻分诊分类器（M3 判断钩子①）：blocked 折叠时把 result.summary/flags 里的
// 信号分类为三档处置——环境类（可自动重试）/ 依赖类（等外部，转人盯）/ 设计类（转人裁决）。
// 规则显式可审计（不是 LLM 猜）：信号词表 + flags 显式声明优先。
// 判不了的 → design（转人）——fail-closed 缺省。

export const TRIAGE = Object.freeze({
  ENV: 'env-retry',        // 环境类：重试可能自愈（配额墙、网络、临时资源）——可提请重派
  DEP: 'dep-wait',         // 依赖类：等外部（上游接口、凭据缺失、第三方服务）——转人盯
  DESIGN: 'design-human',  // 设计类：需要人裁决——挂起等人（缺省）
});

// 信号词表（英文小写子串匹配；summary 中英皆可，命一即中）
const ENV_SIGNALS = ['429', 'rate limit', 'rate-limit', 'quota', 'quota wall', 'usage limit',
  'timeout', 'timed out', 'connection reset', 'econnreset', 'econnrefused', 'etimedout',
  'network', 'temporary', 'transient', 'exhausted', '503', '502', 'overloaded'];
const DEP_SIGNALS = ['missing credential', 'missing api key', 'no api key', 'api key',
  'credential', 'unauthorized', '403', '401', 'not found: ', 'missing dependency',
  'waiting for', 'requires ', 'upstream', 'third-party', 'dependency'];

/**
 * @param {object} result 执行器 result.json（blocked 态）
 * @returns {{triage: string, signals: string[], hint: string}}
 *   triage ∈ ENV|DEP|DESIGN；signals=命中的信号列表（审计用）；hint=给编排器/人的行动建议
 */
export function triageBlocked(result) {
  const text = `${result?.summary ?? ''}`.toLowerCase();
  const flags = result?.flags ?? {};

  // flags 显式声明最优先（执行器比分类器更了解现场）
  if (flags.quota || flags.retryable || flags.transient) {
    return { triage: TRIAGE.ENV, signals: [`flags:${flags.quota ? 'quota' : flags.retryable ? 'retryable' : 'transient'}`], hint: '环境类受阻：dispatch --retry <id> 原子重派（回炉+派发一体）；建议等配额窗口（5h 限额实测）' };
  }
  if (flags.needsHuman || flags.designDecision) {
    return { triage: TRIAGE.DESIGN, signals: ['flags:needsHuman'], hint: '设计类受阻：人工裁决（decide 面）；裁决后 blocked→approved 回炉' };
  }

  const hit = (list) => list.filter((k) => text.includes(k));

  const envHits = hit(ENV_SIGNALS);
  const depHits = hit(DEP_SIGNALS);
  // 双命中时取更具体的依赖类（凭据/权限问题重试没用）
  if (depHits.length) {
    return { triage: TRIAGE.DEP, signals: depHits, hint: '依赖类受阻：需要补凭据/等外部条件——人工介入（blocked→approved 在条件具备后回炉）' };
  }
  if (envHits.length) {
    return { triage: TRIAGE.ENV, signals: envHits, hint: '环境类受阻：dispatch --retry <id> 原子重派（回炉+派发一体）；建议等配额窗口或网络恢复' };
  }
  // 判不了 → 设计类（fail-closed 缺省：转人，绝不自动重试循环）
  return { triage: TRIAGE.DESIGN, signals: [], hint: '分诊信号不足：按设计类转人（blocked→approved 回炉或 rejected 关闭）' };
}
