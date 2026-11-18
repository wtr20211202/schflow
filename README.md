<div align="center">

# schflow

**Proposal-driven task pipeline for AI coding agents**

[English](README.md) | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)

*Proposals are filed, reviewed, and approved — approved tasks execute in parallel git worktrees via your agent CLI of choice, and finished branches merge through a per-branch serial merge queue. Deterministic bookkeeping lives in code; model judgment only where judgment is needed.*

</div>

---

## Why

LLM-driven orchestrators drift: state machines living in prompts get misread, every tick burns tokens, and host-specific quirks break unattended runs. schflow keeps the proven bones of a long-running agent pipeline — file-as-state, idempotent ticks, parallel worktrees, serialized merges — and moves the deterministic half into small, runnable programs. The agents stay agents.

| | |
|---|---|
| 🧠 **Dial model** | The tick loop runs as an LLM skill (works anywhere today) or a zero-LLM script. Same state files, same prompts — moving right is an upgrade, not a migration. |
| 🔌 **Any harness as executor** | One runner contract: self-contained task book + shell tools + artifacts on disk + a structured `result.json`. claude `-p`, dsh headless, or any custom command qualifies. |
| 📦 **Not just code** | Six task kinds (`code / fix / investigate / docs / research / chore`) share one intake and state machine; only git-track kinds use worktrees and the merge queue. |
| 🌿 **Serial merge queue** | Per `(repo, base)` FIFO: rebase → verify → no-ff merge → secret-scan → fast-forward push. Ejection keeps the queue moving; push failure halts it. |
| 🏝️ **Env leases** | Shared verification environments are leased per dispatch (exclusive/shared, TTL recovery) — the pool is a config file, provisioning is pluggable. |
| 🛡️ **Prompt-injection defenses** | Untrusted-content fencing, source trust levels, exit-time secret scanning, forced source visibility. |
| 🧩 **Official plugin distribution** | One command per host — no manual copying (see [Install](#install)). |

## Install

Both hosts install via their **official plugin mechanism** — no manual copying, no npm step:

**claude code** (manifests pass `claude plugin validate`):

```bash
# in a claude code session
/plugin marketplace add wtr20211202/schflow
/plugin install schflow@schflow
```

**dsh** (standard bundle, public repo — anonymous clone):

```bash
dsh plugin --profile schflow add "github:wtr20211202/schflow#path:hosts/dsh/plugin"
```

Requires: node ≥ 20 and git. The plugin gives your agent sessions the skills (`schflow-proposer` / `schflow-orchestrator` / `schflow-executor` / `schflow-improve` / `schflow-audit`) that operate the pipeline; the deterministic programs live in this repo (`core/programs/*.mjs`) and run with plain node.

## Quick start

```bash
git clone https://github.com/wtr20211202/schflow.git && cd schflow && npm install
export SCHFLOW_HOME=~/.schflow            # pipeline home (auto-created)

# file a proposal (human fast lane: auto-approved)
node core/programs/next-id.mjs                                        # → P-YYYYMMDD-1
node core/programs/dup-check.mjs --title "your idea" --anchor anchor1 # dedup check
node core/programs/validate-task.mjs --task <id>                      # format gate

# approve + dispatch (fake executor runs with zero LLM — great for a first look)
node core/programs/dispatch.mjs --auto --runner fake --json
node core/programs/fold.mjs --json && node core/programs/merge.mjs --json
```

In an agent session (claude code or dsh, with the plugin installed), just ask: *"list your schflow skills", "propose an improvement", "run one tick", "show the board", "audit the discipline"*.

> For the full lifecycle — proposal → review gate → parallel executors → merge queue → push — see the [design doc](docs/design.md) and the host READMEs: [claude code](hosts/claude-code/README.md) · [dsh](hosts/dsh/README.md) · [ZCode](hosts/zcode/README.md).

## Host support

| Host | Install | Executor families | Notes |
|---|---|---|---|
| claude code | marketplace plugin | native subagent (in-session) / `claude -p` subprocess | per-agent tool allowlists; [README](hosts/claude-code/README.md) |
| dsh | bundle plugin | `dsh --profile headless` subprocess / native in GUI | skills via `skill-filesystem`; [README](hosts/dsh/README.md) |
| ZCode | cron templates + skills | host-native | [README](hosts/zcode/README.md) |

## Docs

- [docs/design.md](docs/design.md) — the full design (architecture, dial model, extension points, merge queue, security model)
- [docs/spec/](docs/spec/) — contracts: task card · events · result · tick · programs
- [docs/adr/](docs/adr/) — 31 ADRs distilled from a battle-tested predecessor pipeline
- [golden/](golden/) — golden scenarios: property assertions (CI) + judge rubrics

## Roadmap

- `schflow` CLI consolidation (subcommands + `setup`/`doctor` — the two commands below ship with M0):

  ```bash
  npx schflow@latest setup --host auto   # planned (M0): detects installed agent hosts
  npx schflow doctor                     # planned (M0): environment check
  ```

- Engine absorption of the tick loop (zero-LLM `schflow tick`, dial far right)
- More adapters (codex …), daemon scheduler, notification sinks

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Design changes go through [docs/design.md](docs/design.md); "why is it built this way" lives in the [ADRs](docs/adr/).

## License

[Apache-2.0](LICENSE)
