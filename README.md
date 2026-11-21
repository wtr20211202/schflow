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

Requires: node ≥ 20 and git. The plugin is **self-contained**: it ships the skills (`schflow-proposer` / `schflow-orchestrator` / `schflow-executor` / `schflow-improve` / `schflow-audit`), the engine (`core/programs/*.mjs` + `core/lib/`) and a vendored copy of `yaml` — zero npm dependencies, so `node <plugin-root>/core/programs/<verb>.mjs` runs as-is with no `npm install`. To use the engine from a dev clone instead, point `SCHFLOW_PKG` at the clone root.

## Quick start

```bash
git clone https://github.com/wtr20211202/schflow.git && cd schflow
export SCHFLOW_HOME=~/.schflow            # pipeline home (auto-created)

# file a proposal (human-authored: approved at creation; agent-drafted: pending until decide)
node core/programs/next-id.mjs                                        # → P-YYYYMMDD-1
node core/programs/dup-check.mjs --title "your idea" --anchor anchor1 # dedup check
node core/programs/validate-task.mjs --task <id>                      # format gate

# approve + dispatch (fake executor runs with zero LLM — great for a first look)
node core/programs/dispatch.mjs --auto --runner fake --json
node core/programs/fold.mjs --json && node core/programs/merge.mjs --json
```

In an agent session (claude code or dsh, with the plugin installed), just ask: *"list your schflow skills", "propose an improvement", "run one tick", "show the board", "audit the discipline"*.

> For the full lifecycle — proposal → review gate → parallel executors → merge queue → push — see the [design doc](docs/design.md) and the host READMEs: [claude code](hosts/claude-code/README.md) · [dsh](hosts/dsh/README.md) · [ZCode](hosts/zcode/README.md).

## Filing a proposal

You don't need a full proposal to start — **one sentence is enough**. Your agent drafts the five-part proposal (motivation / plan / value / size / risks), runs the four-question cold review, and files the card as `source.author: model`, `status: pending` with a `评审：` line and `## 原始诉求（human）` (your request, verbatim). Nothing dispatches until you give one explicit approval (`decide --task <id> --to approved`), which stamps `approvedBy: human` + `approvedAt`; model-drafted cards are never created approved. Writing the full text yourself still works — a human-authored card keeps the fast lane.

## Register a project

Tasks run against repos you register under `$SCHFLOW_HOME/projects/` — one directory per project, holding a `schflow.yaml`:

```yaml
# ~/.schflow/projects/my-app/schflow.yaml
repo: /absolute/path/to/my-app   # absolute path — worktrees and merges happen inside this repo
default-base: main               # base branch used when the task card names none
verify:                          # command chain run at the merge gate (≥ 1 command)
  - cmd: npm test
```

The full field set is in [docs/design.md](docs/design.md) §6.1/§7; verification environments are leased from `envs.yaml` — a task declaring `env:` must take the lease at dispatch (§8). Smoke test: file a `docs` proposal and walk the whole chain — pending → approved → dispatched → folded → merged.

## Extending schflow

The skeleton is deliberately small — everything outside the flow templates is externalized. Strong model, add fewer constraints; weak model, mount more methodology (e.g. third-party skill packs) — both are legitimate.

Five slots, lightest to heaviest — all are "add a file / edit a config", zero changes to skill bodies (canonical: [docs/design.md](docs/design.md) §7):

| Slot | Action | Typical use | Intrusiveness |
|---|---|---|---|
| Prompt overrides (`overrides/*.md`) | merge extra prompt fragments at declared points | tweak behavior details, add business context | lightest |
| Mounts | declare knowledge dirs / third-party skill packs in a Profile | run plan discussions / execution with someone else's methodology | light |
| Phase files | insert or replace stages in the execution sequence | add your own plan-discussion / acceptance flow | medium |
| Direction files | add `directions/<name>.yaml` to open a new proposal direction | new proposer variants (security audit, test backfill …) | medium |
| Delegate | hand dispatch/poll to your existing workflow | take over execution entirely; the engine only bookkeeps | heavy |

Mounting third-party skill packs, one line per host: **dsh** — drop the pack under `~/.schflow/skills/` (the plugin already reads that root) or point `SCHFLOW_SKILLS_DIR` at it; **claude code** — install via its official plugin system (sessions see it naturally), and declare injection into tasks with a Profile `mounts` entry; **ZCode** — same, via `mounts`.

Trimming for strong models: the built-in executor/orchestrator disciplines (visual self-check, the four structure questions, …) are all conditional prompt-layer content — if they feel heavy, cut them back via `promptOverrides` (the first slot); the engine-enforced surface is only the safety floor (deliverable contract, fail-closed, red lines) — that part cannot be trimmed.

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
