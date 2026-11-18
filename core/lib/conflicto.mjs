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

// rebase 冲突自动恢复链（merge ① 步的三级兜底，替代「一败即 eject」）：
//   L0 机械重试：rebase 失败 → abort → 300ms 退避 → 重试一次（接住 index.lock 残留/瞬时脏残留类失败）；
//   L1 非交叠语义合并（严格 union，绝非无脑 union）：逐文件 git merge-file --diff3 解析冲突块，
//     块级安全判据全过才整体适用（base 段空=双侧纯追加→拼接；单侧==base=误报→取另一侧；
//     双侧改写同基线段=不安全弃 L1），外加「结果增量行多重集 ⊇ 双方增量行」完整性后验；
//   L2 judge② 裁决（仅 --judge-resolve 启用）：提示词落系统临时目录，裁决器只输出一行 JSON，
//     adopt-theirs/adopt-ours/merge-both 可应用，escalate/不可解析/缺盖/超时 fail-closed 弃半态。
// rebase 方向标注（防反关键，代码与提示词双处声明）：rebase 中 ours=:2=主线 base 侧（被 replay 的
// 落点）、theirs=:3=任务分支侧——与普通 merge 的直觉方向相反，任何取段判据不得颠倒。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git } from './gitutil.mjs';
import { appendEvent } from './events.mjs';

const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// L2 体量护栏：单文件（三方合计）>40KB 或总量 >200KB → 弃 L2（防半料裁决）
const JUDGE_MAX_FILE_BYTES = 40 * 1024;
const JUDGE_MAX_TOTAL_BYTES = 200 * 1024;
const VERDICTS = ['adopt-theirs', 'adopt-ours', 'merge-both', 'escalate'];

/** 统一入口：在合并工作树 mw 里把当前 detached 分支尖 rebase 到 baseTip。
 *  三级顺序固定，任一级成功即返回 {ok:true, level?…}；全败返回 {ok:false, reason} 由调用方走既有 eject。
 *  judge=null（缺省，未加 --judge-resolve）时零 LLM——L0/L1 照常，L2 不启用。 */
export function resolveRebase({ home, repo, mw, baseTip, card, judge = null }) {
  // ---- L0 机械重试 ----
  if (git(mw, ['rebase', baseTip], { allowFail: true }).ok) return { ok: true };
  git(mw, ['rebase', '--abort'], { allowFail: true });
  sleepSync(300); // 退避：让瞬时锁残留/AV 句柄散尽
  if (git(mw, ['rebase', baseTip], { allowFail: true }).ok) {
    appendEvent(home, { type: 'merge.auto-resolved', actor: 'engine', taskId: card.id, level: 'rebase-retry' });
    return { ok: true, level: 'rebase-retry' };
  }

  // ---- L1 非交叠语义合并（此刻通常已处于第二次尝试留下的冲突态）----
  let files = unmergedFiles(mw);
  let l1Reason = 'semantic-unsafe';
  if (!files.length) {
    // 空清单但 rebase 失败=异形态（非冲突类失败）→ abort 弃 L1
    git(mw, ['rebase', '--abort'], { allowFail: true });
    l1Reason = 'no-conflict-state';
  } else {
    const plan = planSemanticUnion(mw, files);
    if (plan.ok) {
      applyResults(mw, plan.results);
      if (continueRebase(mw).ok) {
        appendEvent(home, {
          type: 'merge.auto-resolved', actor: 'engine', taskId: card.id,
          level: 'semantic-union', files: plan.files,
        });
        return { ok: true, level: 'semantic-union' };
      }
      l1Reason = 'continue-failed';
    }
    git(mw, ['rebase', '--abort'], { allowFail: true }); // 弃 L1：不安全/后验不过/continue 失败
  }

  // ---- L2 judge②（仅 judge 对象存在时启用；否则带着 L1 失败原因回落 eject）----
  if (!judge) return { ok: false, reason: l1Reason };
  files = unmergedFiles(mw);
  if (!files.length) {
    // L1 已把冲突态撤掉：重进一次收集三方（重进即成=瞬时态已散，直接算成功）
    if (git(mw, ['rebase', baseTip], { allowFail: true }).ok) return { ok: true };
    files = unmergedFiles(mw);
    if (!files.length) {
      git(mw, ['rebase', '--abort'], { allowFail: true });
      return { ok: false, reason: `${l1Reason}+no-conflict-state` };
    }
  }
  return judgeResolve({ home, mw, card, judge, files });
}

// ---------- L1：非交叠语义合并 ----------

/** 冲突文件清单（rebase 冲突态下的 index 未合并路径，/ 分隔的仓库相对路径） */
function unmergedFiles(mw) {
  return git(mw, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })
    .stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** 逐文件三方 merge-file + 块级安全判据 + 完整性后验。全部通过才 {ok:true}；任一不安全整体弃。 */
function planSemanticUnion(mw, files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schflow-conflict-'));
  const results = [];
  try {
    for (const f of files) {
      // :1=base 基线（缺段=add/add 对撞，按空基线处理）；:2/:3 缺段=删除/改名类改形态——机械面不猜
      const base = showStage(mw, 1, f) ?? '';
      const ours = showStage(mw, 2, f);
      const theirs = showStage(mw, 3, f);
      if (ours === null || theirs === null) return { ok: false, reason: 'stage-missing' };
      const [fo, fb, ft] = ['ours', 'base', 'theirs'].map((k) => path.join(tmp, `${k}-${results.length}.txt`));
      fs.writeFileSync(fo, ours);
      fs.writeFileSync(fb, base);
      fs.writeFileSync(ft, theirs);
      // 注意参数序：merge-file <ours> <base> <theirs>；--diff3 带 base 段；-p 结果走 stdout
      const mf = spawnSync('git', ['merge-file', '--diff3', '-p', fo, fb, ft], { encoding: 'utf8', windowsHide: true });
      if (mf.error || mf.status === null || mf.status < 0) return { ok: false, reason: 'merge-file-error' };
      const merged = resolveConflictBlocks(String(mf.stdout));
      if (!merged.safe) return { ok: false, reason: 'unsafe-block' };
      if (!coversDelta(merged.text, base, ours) || !coversDelta(merged.text, base, theirs)) {
        return { ok: false, reason: 'incomplete-union' }; // 完整性后验：防实现伤静默丢行
      }
      results.push({ path: f, content: merged.text });
    }
    return { ok: true, results, files };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 取冲突态 index 的指定 stage 全文（stage 1=base/2=ours/3=theirs）；缺段返回 null */
function showStage(mw, stage, f) {
  const r = git(mw, ['show', `:${stage}:${f}`], { allowFail: true });
  return r.ok ? r.stdout : null;
}

/** 解析 merge-file --diff3 输出的冲突块并按安全判据消解。
 *  安全判据（块级，全部块安全才整体适用）：base 段空→ours+theirs 拼接（双侧纯追加对撞）；
 *  ours==base→取 theirs（单侧改写，邻接误报）；theirs==base→取 ours（同上镜像）；其余不安全。
 *  再次提醒方向：ours 段=主线 base 侧、theirs 段=任务分支侧。 */
function resolveConflictBlocks(text) {
  const lines = text.split('\n'); // 末尾换行以 '' 元素保持——join 无损还原
  const out = [];
  let ours = null; let base = null; let theirs = null; let mode = 'outside';
  for (const ln of lines) {
    if (mode === 'outside') {
      if (ln.startsWith('<<<<<<<')) { mode = 'ours'; ours = []; continue; }
      out.push(ln);
    } else if (mode === 'ours') {
      if (ln.startsWith('|||||||')) { mode = 'base'; base = []; continue; }
      ours.push(ln);
    } else if (mode === 'base') {
      if (ln === '=======') { mode = 'theirs'; theirs = []; continue; }
      base.push(ln);
    } else { // theirs
      if (ln.startsWith('>>>>>>>')) {
        const [o, b, t] = [ours, base, theirs].map((seg) => seg.join('\n'));
        let pick;
        if (b === '') pick = [...ours, ...theirs];
        else if (o === b) pick = theirs;
        else if (t === b) pick = ours;
        else return { safe: false };
        out.push(...pick);
        mode = 'outside'; ours = base = theirs = null;
        continue;
      }
      theirs.push(ln);
    }
  }
  if (mode !== 'outside') return { safe: false }; // 残缺块（marker 不闭合）——不猜
  return { safe: true, text: out.join('\n') };
}

/** 完整性后验：result 相对 base 的增量行多重集 ⊇ side 相对 base 的增量行多重集 */
function coversDelta(resultText, baseText, sideText) {
  const count = (t) => {
    const m = new Map();
    for (const l of t.split('\n')) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const [r, b, s] = [count(resultText), count(baseText), count(sideText)];
  for (const [l, c] of s) {
    const need = c - (b.get(l) ?? 0);
    if (need <= 0) continue;
    if ((r.get(l) ?? 0) - (b.get(l) ?? 0) < need) return false;
  }
  return true;
}

/** 全部文件通过后统一写回 + add（两段式：任一文件不安全时绝不落半笔） */
function applyResults(mw, results) {
  for (const { path: f, content } of results) fs.writeFileSync(path.join(mw, f), content);
  git(mw, ['add', '--', ...results.map((r) => r.path)]);
}

/** rebase --continue（GIT_EDITOR=true 注入防交互；复验链在其后仍兜底语义正确性） */
function continueRebase(mw) {
  const r = spawnSync('git', ['-C', mw, 'rebase', '--continue'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_EDITOR: 'true' },
  });
  return { ok: !r.error && r.status === 0, stderr: r.stderr || '' };
}

// ---------- L2：judge② 裁决 ----------

/** 收集三方 → 体量护栏 → 提示词落系统临时目录 → 裁决器 → 应用/escalate。
 *  fail-closed 纪律：escalate/不可解析/缺盖/超时/应用失败一律 rebase --abort 后返回失败，绝不猜。 */
function judgeResolve({ home, mw, card, judge, files }) {
  const abort = () => git(mw, ['rebase', '--abort'], { allowFail: true });
  const fail = (reason) => { abort(); return { ok: false, reason: `judge-escalate:${String(reason).slice(0, 200)}` }; };

  let total = 0;
  const threeWay = files.map((f) => {
    // 方向再标注：base=:1 原基线、ours=:2 主线 base 侧、theirs=:3 任务分支侧
    const base = showStage(mw, 1, f) ?? '';
    const ours = showStage(mw, 2, f);
    const theirs = showStage(mw, 3, f);
    const size = base.length + (ours?.length ?? 0) + (theirs?.length ?? 0);
    total += size;
    return { path: f, base, ours, theirs, size };
  });
  if (threeWay.some((x) => x.size > JUDGE_MAX_FILE_BYTES) || total > JUDGE_MAX_TOTAL_BYTES) {
    abort();
    return { ok: false, reason: 'judge-oversize' }; // 防半料裁决：直接弃 L2
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schflow-judge-'));
  try {
    const promptPath = path.join(tmp, 'prompt.md');
    fs.writeFileSync(promptPath, buildPrompt(card, threeWay));
    const verdict = runJudge(judge, promptPath);
    if (!verdict.ok) return fail(verdict.reason);
    const rationale = typeof verdict.rationale === 'string' ? verdict.rationale.slice(0, 500) : '(无理由)';

    if (verdict.verdict === 'adopt-theirs' || verdict.verdict === 'adopt-ours') {
      const side = verdict.verdict === 'adopt-theirs' ? '--theirs' : '--ours'; // theirs=任务分支侧/ours=主线侧
      const co = git(mw, ['checkout', side, '--', ...files], { allowFail: true });
      if (!co.ok) return fail('checkout-failed');
      git(mw, ['add', '--', ...files]);
      if (!continueRebase(mw).ok) return fail('continue-failed');
    } else if (verdict.verdict === 'merge-both') {
      const contents = verdict.files;
      if (!contents || typeof contents !== 'object' || Array.isArray(contents)) return fail('files-missing');
      for (const f of files) {
        if (typeof contents[f] !== 'string') return fail(`files-incomplete:${f}`);
      }
      // 仅写冲突文件路径集合内的键（files 覆盖校验已过=全覆盖），杜绝越路径写盘注入面
      for (const f of files) fs.writeFileSync(path.join(mw, f), contents[f]);
      git(mw, ['add', '--', ...files]);
      if (!continueRebase(mw).ok) return fail('continue-failed');
    } else { // escalate
      return fail(rationale);
    }

    appendEvent(home, {
      type: 'merge.resolved', actor: 'engine', taskId: card.id,
      verdict: verdict.verdict, rationale, judge: judge.runner,
    });
    return { ok: true, level: 'judge', verdict: verdict.verdict, rationale };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 裁决提示词（落 os.tmpdir——不进 HOME 事件面）；分段定界符与测试夹具解析约定同源 */
function buildPrompt(card, threeWay) {
  const seg = [
    '你是 schflow 合并队列的 rebase 冲突裁决器（judge②）。对以下冲突做结构化裁决。',
    '方向标注（防反关键）：ours = :2 = 主线 base 侧（被 replay 的落点）；theirs = :3 = 任务分支侧。',
    `任务卡：${card.id} ${card.title}`,
    '裁决契约：只输出一行 JSON（不得有其它文字）：',
    '{"verdict":"adopt-theirs"|"adopt-ours"|"merge-both"|"escalate","rationale":"≤500字","files":{"<path>":"完整合并后全文"}}',
    '- adopt-theirs=采纳任务分支侧；adopt-ours=保留主线侧（仅当分支改动已被主线等价包含时使用——会丢弃分支该冲突块改动）；',
    '- merge-both=files 必填且必须覆盖全部冲突文件；escalate=无法裁决，交人工。',
    '',
  ];
  for (const x of threeWay) {
    seg.push(`==== FILE: ${x.path} ====`);
    seg.push('---- base (:1 原基线) ----');
    seg.push(x.base);
    seg.push('---- ours (:2 主线 base 侧) ----');
    seg.push(x.ours ?? '(缺 :2 段)');
    seg.push('---- theirs (:3 任务分支侧) ----');
    seg.push(x.theirs ?? '(缺 :3 段)');
    seg.push('==== END FILE ====');
    seg.push('');
  }
  return seg.join('\n');
}

/** 起裁决器（spawnSync 前台；argv 纪律同 runner：数组直启零 shell、任务书/prompt 恒走 stdin 或文件占位）。
 *  零凭据零 env 注入——引擎不经手任何密钥，子进程只继承原生环境。 */
function runJudge(judge, promptPath) {
  let cli; let args; let stdinFile = null;
  if (judge.runner === 'claude') {
    // claude -p：无 --output-format 时 stdout 为纯文本——从输出中提取第一个可解析 JSON 对象
    cli = 'claude';
    args = ['-p'];
    if (judge.model) args.push('--model', judge.model);
    stdinFile = promptPath;
  } else if (judge.runner === 'dsh') {
    // dsh headless 读 `-` 为 stdin（0.2.2 实证）
    cli = 'dsh';
    args = ['--profile', 'headless'];
    if (judge.model) args.push('--model', judge.model);
    args.push('-');
    stdinFile = promptPath;
  } else { // custom：argv 数组含 {prompt} 占位（提示词文件路径）
    const argv = judge.runnerCmd.map((a) => String(a).replaceAll('{prompt}', promptPath));
    [cli, ...args] = argv;
  }
  const timeoutMs = (Number(judge.timeoutSec) > 0 ? Number(judge.timeoutSec) : 600) * 1000;
  const r = spawnSync(cli, args, {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
    ...(stdinFile ? { input: fs.readFileSync(stdinFile, 'utf8') } : {}),
  });
  if (r.error) return { ok: false, reason: r.error.code === 'ETIMEDOUT' ? 'timeout' : `spawn-failed:${r.error.code ?? r.error.message}` };
  if (r.signal) return { ok: false, reason: `timeout:${r.signal}` };
  const parsed = extractJson(r.stdout || '');
  if (!parsed || !VERDICTS.includes(parsed.verdict)) return { ok: false, reason: 'unparseable-output' };
  return { ok: true, verdict: parsed.verdict, rationale: parsed.rationale, files: parsed.files };
}

/** 从裁决器纯文本输出中提取第一个可解析 JSON 对象（claude -p 纯文本形态兼容） */
function extractJson(text) {
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    for (let j = text.indexOf('}', i); j !== -1; j = text.indexOf('}', j + 1)) {
      try {
        const o = JSON.parse(text.slice(i, j + 1));
        if (o && typeof o === 'object' && !Array.isArray(o)) return o;
      } catch { /* 续扫下一个 '}' 端点 */ }
    }
  }
  return null;
}
