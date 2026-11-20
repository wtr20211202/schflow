#!/usr/bin/env node

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

// 八程序⑧ event：事件追加（信封自动补 ts/seq/schemaVersion；分卷按月）+ --list 回放查询。
// 追加：入参走 --body-file（CLI 即 API 纪律）；未知 type 拒绝（exit 76）——确需新增类型走 --allow-unknown-type，
// 并遵守 events.md 版本策略（新增 type 前向兼容不升版）。
// 查询：--list 与追加互斥；按分卷顺序回放，--type a,b / --task <id> 过滤、--last N 尾取；只读不取锁
// （外部持 HOME 写锁照常查询）。
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { resolveHome } from '../lib/home.mjs';
import { appendEvent, readEvents } from '../lib/events.mjs';
import { emit, die, EXIT } from '../lib/out.mjs';

const USAGE = '用法: event.mjs --body-file <event.json>（追加；字段: type, actor, taskId?, runNo?, …载荷）\n'
  + '      event.mjs --list [--type a,b] [--task <id>] [--last N] [--json]（查询）';

let values;
try {
  ({ values } = parseArgs({
    options: {
      home: { type: 'string' }, json: { type: 'boolean' }, list: { type: 'boolean' },
      type: { type: 'string' }, task: { type: 'string' }, last: { type: 'string' },
      'body-file': { type: 'string' }, 'allow-unknown-type': { type: 'boolean' },
    },
  }));
} catch (e) {
  die(EXIT.REJECT, { text: `event: 参数错误——${e.message.split('\n')[0]}` });
}

if (values.list && values['body-file']) die(EXIT.MISSING, { text: 'event: --list（查询）与 --body-file（追加）互斥，只能二选一' });
if (!values.list && !values['body-file']) die(EXIT.MISSING, { text: USAGE });

if (values.list) {
  // —— 查询面：只读，不取锁 ——
  const home = resolveHome(values.home);
  let last = null;
  if (values.last !== undefined) {
    last = Number(values.last);
    if (!Number.isInteger(last) || last < 0) die(EXIT.REJECT, { text: `event: --last 需为非负整数（得到 "${values.last}"）` });
  }
  const types = values.type ? values.type.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const all = readEvents(home, { types });
  const malformed = all.malformed; // filter/slice 会丢数组附加属性，先取走
  let evts = all;
  if (values.task) evts = evts.filter((e) => e.taskId === values.task);
  if (last !== null) evts = last === 0 ? [] : evts.slice(-last); // 注：slice(-0)=全量，0 须显式置空
  if (values.json) {
    emit({ json: evts }); // 损坏行不入数组（stdout 纯 JSON，计数字段不进机读面）
  } else {
    const lines = evts.length ? evts.map(fmtEvent) : ['event: 无匹配事件'];
    if (malformed) lines.push(`# 跳过损坏行 ${malformed}`);
    emit({ text: lines.join('\n') });
  }
} else {
  // —— 追加面（原路径） ——
  const home = resolveHome(values.home);
  let evt;
  try {
    evt = JSON.parse(fs.readFileSync(values['body-file'], 'utf8'));
  } catch (e) {
    die(EXIT.REJECT, { text: `event: body-file 解析失败——${e.message}` });
  }
  try {
    const full = appendEvent(home, evt, { allowUnknownType: !!values['allow-unknown-type'] });
    emit({ json: values.json ? { ...full, home } : null, text: values.json ? '' : `seq=${full.seq} ${full.type}` });
  } catch (e) {
    if (e.code === 'LOCK_BUSY') die(EXIT.BUSY, { text: e.message });
    die(EXIT.REJECT, { text: `event: ${e.message}` });
  }
}

/** 人读一行一条：`seq ts type taskId 摘要字段`——信封（ts/seq/schemaVersion/type/actor/taskId）外字段 k=v，taskId 缺位显 - */
function fmtEvent(e) {
  const pairs = Object.entries(e)
    .filter(([k]) => !['ts', 'seq', 'schemaVersion', 'type', 'actor', 'taskId'].includes(k))
    .map(([k, v]) => `${k}=${v !== null && typeof v === 'object' ? JSON.stringify(v) : v}`);
  return [e.seq, e.ts, e.type, e.taskId ?? '-', ...pairs].join(' ');
}
