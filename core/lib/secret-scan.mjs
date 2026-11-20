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

// 合并出口扫描（design §5.2 对策 7——gitleaks 类的内置最小特征集；接入外部扫描器留位 Profile）。
// 独立成 lib 而非留在 merge.mjs：merge 是 CLI 入口（顶层 parseArgs/取锁/队列回放），
// 导入即执行无法单测；扫描器是纯函数，单测直接导入本模块。
// allowlist 只收公开文档示例值（精确匹配）——不得放宽模式本身，新增条目须附出处。

export const SECRET_PATTERNS = Object.freeze([
  /AKIA[0-9A-Z]{16}/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
]);

// 公开文档示例值（精确匹配——不是前缀规则）：AWS 官方文档通用示例访问密钥，公开非密。
// 新增条目须附出处；真实形态（即使与示例值同前缀）不在放行之列。
export const SECRET_ALLOWLIST = Object.freeze([
  'AKIAIOSFODNN7EXAMPLE', // AWS SDK/CLI 文档示例（dogfood P-20261120-3 出口扫描误报源）
  'AKIAI44QH8DHBEXAMPLE', // AWS 文档示例访问密钥
]);

/**
 * 扫描合并提交增量 diff：逐模式逐匹配遍历（g 语义），命中 allowlist 的公开示例值跳过、
 * 继续找同一模式的下一个匹配；只有非示例值才返回命中描述。全量扫描，不截断。
 * @param {string} diffText
 * @returns {string|null} 命中描述（模式前缀 + 值前 12 字符）或 null
 */
export function secretScan(diffText) {
  for (const re of SECRET_PATTERNS) {
    // 每次新建带 g 的副本：matchAll 不依赖共享正则的 lastIndex（并发/重入无残留）
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of diffText.matchAll(g)) {
      if (SECRET_ALLOWLIST.includes(m[0])) continue; // 公开示例值：放行并继续找下一个
      return `${re.source.slice(0, 40)}… "${m[0].slice(0, 12)}…"`;
    }
  }
  return null;
}
