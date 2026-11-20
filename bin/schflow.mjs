#!/usr/bin/env node
/**
 * schflow — proposal-driven task pipeline for AI coding agents.
 * Skeleton stub (P0). Real CLI wiring lands in milestone M0:
 *   init / setup / doctor / add / approve / list / show / board /
 *   timeline / watch / log / blocked / decide / reconcile / rebuild /
 *   import / tick / daemon
 * See docs/design.md §17 for the implementation blueprint.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 版本唯一来源：根 package.json（四处清单由 core/test/unit/version-sync.test.mjs 守平）。
const pkg = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
);
const version = pkg.version;
const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(`schflow ${version}`);
  process.exit(0);
}

const help = [
  'schflow: skeleton — CLI lands in M0 (see docs/design.md §17)',
  `schflow ${version}`,
  'Usage: schflow [--version] [--help]',
];

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(help.join('\n'));
  process.exit(0);
}

console.error(`schflow: unknown command: ${args.join(' ')}`);
console.error(help.join('\n'));
process.exit(2);
