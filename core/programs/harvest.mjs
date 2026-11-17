#!/usr/bin/env node
// 八程序扩展⑨ harvest：RCA/调研报告 → 自动转生 fix/code 提案（§6.3 闭环收口）。
// 语义：读已 done 的 investigate/research 任务，解析其 deliverables 报告中的
// 「转生提案块」（显式标记区——报告作者按模板写，程序不猜自由文本），为每块
// 生成一条新任务（kind=fix 默认，沿用源任务的 repo/base/project），status=pending
// 走正常评审闸；源任务与转生任务用 dependsOn 反向引用保持血缘。
//
// 转生提案块模板（RCA 报告内，UNTRUSTED 内容之外、报告作者所写）：
//   <!-- schflow:spawn
//   title: 修复 XXX 的 YYY 问题
//   kind: fix            （可选，默认 fix）
//   priority: high       （可选，默认 high）
//   rationale: 一句话理由（进 proposal 动机首行）
//   -->
//   （可选多行正文：作为新提案 proposal.md 的方案骨架）
//   <!-- /schflow:spawn -->
//
// 用法：harvest.mjs [--task <investigate 任务 id>] [--all] [--dry-run] [--json]
//   --task 指定单任务；--all 扫 open 区 done 态 + done/<YYYY-MM>/ 归档区的
//   investigate/research（调查类任务一 done 即归档——只扫 open 会让 --all 永远零源）
//   幂等：源任务 id + 块序号 记入新任务 proposal 头部 harvest 锚（harvestSource），
//   锚检查覆盖 open+归档，源归档后重跑不重发。

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { resolveHome, paths, ymd } from '../lib/home.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { findTaskDir, loadCard, listAllCards, createTask } from '../lib/store.mjs';
import { appendEvent } from '../lib/events.mjs';
import { emit, die, EXIT } from '../lib/out.mjs';
import { atomicWriteJson } from '../lib/atomic.mjs';
import { validateTaskCard } from '../lib/taskcard.mjs';

const { values } = parseArgs({
  options: {
    home: { type: 'string' }, json: { type: 'boolean' },
    task: { type: 'string' }, all: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  },
});
if (!values.task && !values.all) die(EXIT.MISSING, { text: '用法: harvest.mjs --task <done 的 investigate/research id> | --all [--dry-run]' });

const home = resolveHome(values.home);
const lock = acquireLock(paths(home).writeLock);
if (!lock) die(EXIT.BUSY, { text: 'harvest: HOME 写锁忙——稍后重试' });

const SPAWN_RE = /<!--\s*schflow:spawn\s*\n([\s\S]*?)-->\n([\s\S]*?)<!--\s*\/schflow:spawn\s*-->/g;
const results = [];

try {
  // 候选源任务：--task 指定（须 done + investigate/research）或 --all 扫 open done 态 + 归档区两 kind
  let sources = [];
  if (values.task) {
    const dir = findTaskDir(home, values.task);
    if (!dir) die(EXIT.FAIL, { text: `harvest: 任务 ${values.task} 不存在` });
    const card = loadCard(dir);
    if (card.status !== 'done') die(EXIT.REJECT, { text: `harvest: 源任务须 done 态（${values.task} 是 ${card.status}）` });
    if (!['investigate', 'research'].includes(card.kind)) die(EXIT.REJECT, { text: `harvest: 源任务 kind 须 investigate/research（${values.task} 是 ${card.kind}）` });
    sources.push({ card, dir });
  } else {
    const seen = new Set();
    for (const { card, dir } of listAllCards(home)) {
      if (card.status !== 'done' || !['investigate', 'research'].includes(card.kind)) continue;
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      sources.push({ card, dir });
    }
  }

    for (const { card, dir } of sources) {
    // RCA 报告位置：deliverables/ 下全部 md（契约=§6.3 deliverables/rca-*.md）
    const delivDir = path.join(dir, 'deliverables');
    const reports = fs.existsSync(delivDir)
      ? fs.readdirSync(delivDir).filter((f) => f.endsWith('.md')).map((f) => path.join(delivDir, f))
      : [];
    if (!reports.length) {
      results.push({ source: card.id, spawned: 0, note: 'no deliverables/*.md reports' });
      continue;
    }

    let blockIdx = 0;
    for (const report of reports) {
      const text = fs.readFileSync(report, 'utf8');
      for (const m of text.matchAll(SPAWN_RE)) {
        blockIdx++;
        const meta = {};
        for (const line of m[1].split('\n')) {
          const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
          if (kv) meta[kv[1].trim().toLowerCase()] = kv[2].trim();
        }
        const body = m[2].trim();
        if (!meta.title) {
          results.push({ source: card.id, spawned: 0, note: `block ${blockIdx} in ${path.basename(report)}: missing title — skipped` });
          continue;
        }
        const anchor = `harvest:${card.id}#${blockIdx}`;
        // 幂等：扫 open+归档区是否已有该锚的转生件（源归档后重跑不重发）
        const dup = listAllCards(home).some(({ card: c }) =>
          String(c.harvestSource ?? '') === anchor);
        if (dup) { results.push({ source: card.id, spawned: 0, note: `${anchor} already spawned` }); continue; }

        if (values['dry-run']) {
          results.push({ source: card.id, spawned: 0, dryRun: true, wouldSpawn: meta.title });
          continue;
        }

        // 取号（经 next-id 程序同一原子面——直接复用其库逻辑：读计数器走写锁已由外层持有，
        // 进程内重入安全）
        const id = nextId(home);

        const kind = ['fix', 'code', 'chore', 'docs'].includes(meta.kind) ? meta.kind : 'fix';
        const priority = ['high', 'medium', 'low'].includes(meta.priority) ? meta.priority : 'high';
        const now = new Date().toISOString();
        const proposal = [
          `# ${meta.title}`,
          '',
          `> harvest 自 **${card.id}**（${card.kind}）${meta.rationale ? `——${meta.rationale}` : ''}`,
          `> 来源报告：${path.basename(report)}；转生锚：${anchor}`,
          '',
          '## 动机',
          '',
          meta.rationale || `源任务 ${card.id} 的分析结论指出本问题（见来源报告）。`,
          '',
          '## 方案',
          '',
          body || '（转生块未附方案骨架——实施时自行补齐。）',
          '',
          '## 价值',
          '',
          '消除源分析指认的问题（详见来源报告）。',
          '',
          '## 规模',
          '',
          '由评审/实施时评估。',
          '',
          '## 风险',
          '',
          '详见源任务 RCA 报告的风险节。',
        ].join('\n') + '\n';

        const newCard = {
          id, kind, title: meta.title, status: 'pending', priority,
          source: { type: 'harvest', trust: 'trusted' },
          dependsOn: [], sessionOnly: false, attempts: 0,
          harvestSource: anchor,
          ...(card.repo ? { repo: card.repo } : {}),
          ...(card.base ? { base: card.base } : {}),
          ...(card.project ? { project: card.project } : {}),
          createdAt: now, updatedAt: now,
        };
        const violations = validateTaskCard(newCard);
        if (violations.length) die(EXIT.REJECT, { text: `harvest: 生成的任务卡不合法（${violations.join('; ')}）——拒绝落盘` });
        createTask(home, newCard, proposal);
        results.push({ source: card.id, spawned: id, title: meta.title, kind, priority });
      }
    }
    if (blockIdx === 0) results.push({ source: card.id, spawned: 0, note: 'no schflow:spawn blocks in reports（报告未含转生提案块——模板见 harvest.mjs 头注）' });
  }
} finally {
  lock.release();
}

emit({
  json: values.json ? { ok: true, results } : null,
  text: values.json ? '' : formatReport(results),
});

function nextId(home) {
  // 与 next-id.mjs 同一原子语义（外层已持 HOME 写锁，进程内直接读写计数器）
  const counterFile = paths(home).idCounter;
  const today = ymd();
  let counter = { date: '', last: 0 };
  if (fs.existsSync(counterFile)) counter = JSON.parse(fs.readFileSync(counterFile, 'utf8'));
  if (counter.date !== today) counter = { date: today, last: 0 };
  counter.last += 1;
  atomicWriteJson(counterFile, counter);
  return `P-${today}-${counter.last}`;
}


function formatReport(r) {
  const L = [];
  for (const x of r) {
    if (x.spawned) L.push(`+ ${x.source} → ${x.spawned}（${x.kind}/${x.priority}）${x.title}`);
    else if (x.dryRun) L.push(`? ${x.source} dry-run：将转生「${x.wouldSpawn}」`);
    else L.push(`- ${x.source}：${x.note}`);
  }
  return L.length ? `harvest: ${L.length} 项——\n${L.map((l) => `  ${l}`).join('\n')}` : 'harvest: 无候选源任务';
}
