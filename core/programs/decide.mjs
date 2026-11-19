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

// 九程序 decide：人工裁决面（judge③「转人」承诺的人侧闭环）——blocked/stale/rejected 三态的人侧出口。
// 语义：分诊转人后，「人」的可脚本化裁决入口——回炉（→approved，重走 dispatch 评估器全链守卫，
// 不绕审批闸）/ 关闭（→rejected）/ 收官（→stale）。转移必经 store.transition() 唯一出口
// （actor=human，status.changed 事件自动落，--note 经 extra 随事件留痕可审计）；
// 目标态不在转移表=76 拒绝并列出该状态合法去向（TRANSITIONS 正典，程序不私设转移面）。
// 与 fold/merge 同一原子面（HOME 写锁）；退出码沿用八程序约定（0/2/75/76/1）。

// 用法：decide.mjs [--home <dir>] [--json] --task <id> --to <approved|rejected|stale> [--note <一句话裁决理由>]

import { parseArgs } from 'node:util';
import { resolveHome, paths } from '../lib/home.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { findTaskDir, loadCard, transition } from '../lib/store.mjs';
import { emit, die, EXIT } from '../lib/out.mjs';
import { canTransition, TRANSITIONS } from '../lib/taskcard.mjs';

const USAGE = '用法: decide.mjs --task <id> --to <approved|rejected|stale> [--note <一句话裁决理由>] [--json]';

const { values } = parseArgs({
  options: {
    home: { type: 'string' }, json: { type: 'boolean' },
    task: { type: 'string' }, to: { type: 'string' }, note: { type: 'string' },
  },
});
if (!values.task || !values.to) die(EXIT.MISSING, { text: USAGE });

const home = resolveHome(values.home);
const lock = acquireLock(paths(home).writeLock);
if (!lock) die(EXIT.BUSY, { text: 'decide: HOME 写锁忙——稍后重试' });

let result;
try {
  const dir = findTaskDir(home, values.task);
  if (!dir) die(EXIT.FAIL, { text: `decide: 任务 ${values.task} 不存在` });
  const card = loadCard(dir);
  if (!canTransition(card.status, values.to)) {
    const targets = (TRANSITIONS[card.status] || []).join(' | ') || '（无）';
    die(EXIT.REJECT, { text: `decide: ${card.status} → ${values.to} 不在转移表（task ${values.task}）——合法去向: ${targets}` });
  }
  // 状态翻转唯一出口：transition 自动落 status.changed（actor=human；note 缺省时不带该字段）
  result = transition(home, values.task, values.to, { actor: 'human', extra: values.note ? { note: values.note } : undefined });
} finally {
  lock.release();
}

emit({
  json: values.json
    ? { ok: true, id: values.task, from: result.from, to: result.to, ...(values.note ? { note: values.note } : {}) }
    : null,
  text: values.json ? '' : `decide: ${values.task} ${result.from} → ${result.to}${values.note ? `（${values.note}）` : ''}`,
});
