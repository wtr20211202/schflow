<div align="center">

# schflow

**面向 AI 编码智能体的提案驱动任务流水线**

[English](README.md) | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)

*提案经立项、评审、批准——批准的任务经你选择的智能体 CLI 在并行 git worktree 中执行，完成的分支经 per-branch 串行合并队列合回。确定性记账全部在代码里，模型判断只出现在需要判断的地方。*

</div>

---

## 为什么

让 LLM 驱动编排会漂移：住在提示词里的状态机会被误读，每个 tick 都烧 token，宿主怪癖破坏无人值守。schflow 保留一套久经实跑的智能体流水线骨架——文件即状态、幂等 tick、并行 worktree、串行合并——并把确定性的一半搬进小型可运行程序。智能体仍然是智能体。

| | |
|---|---|
| 🧠 **拨盘模型** | tick 循环可以由 LLM 技能驱动（今天在任何宿主可用），也可以是零 LLM 脚本。同一套状态文件、同一套提示词——向右拨是升级，不是迁移。 |
| 🔌 **任意 harness 当执行器** | 一份 runner 契约：自包含任务书 + shell 工具 + 产物落盘 + 结构化 `result.json`。claude `-p`、dsh headless、任意自定义命令皆可。 |
| 📦 **不止代码** | 六类任务（`code / fix / investigate / docs / research / chore`）共享同一条 intake 与状态机；只有 git 轨道任务走 worktree 与合并队列。 |
| 🌿 **串行合并队列** | 按 `(repo, base)` FIFO：rebase → 复验 → no-ff 合并 → 出口扫描 → 快进推送。复验弹出不堵队列；推送失败停队列。 |
| 🏝️ **环境租约** | 共享验证环境按派发租约（独占/共享、TTL 回收）——池子是配置文件，供给方式可插拔。 |
| 🛡️ **提示注入防御** | 不可信内容围栏、来源信任分级、出口 secret 扫描、来源强制可见。 |
| 🧩 **官方插件分发** | 每个宿主一条命令——零手动复制（见[安装](#安装)）。 |

## 安装

两个宿主都走**官方插件机制**——零手动复制、零 npm 步骤：

**claude code**（清单过官方 `claude plugin validate` 校验）：

```bash
# 在 claude code 会话里
/plugin marketplace add wtr20211202/schflow
/plugin install schflow@schflow
```

**dsh**（标准 bundle，公开仓匿名可读）：

```bash
dsh plugin --profile schflow add "github:wtr20211202/schflow#path:hosts/dsh/plugin"
```

前置：node ≥ 20 与 git。插件让你的智能体会话获得操作流水线的技能（`schflow-proposer` / `schflow-orchestrator` / `schflow-executor` / `schflow-improve` / `schflow-audit`）；确定性程序在本仓库（`core/programs/*.mjs`），纯 node 直跑。

## 快速上手

```bash
git clone https://github.com/wtr20211202/schflow.git && cd schflow && npm install
export SCHFLOW_HOME=~/.schflow            # 流水线家目录（自动创建）

# 立一条提案（human 快车道：即批准）
node core/programs/next-id.mjs                                        # → P-YYYYMMDD-1
node core/programs/dup-check.mjs --title "想法一句话" --anchor 锚点    # 查重
node core/programs/validate-task.mjs --task <id>                      # 格式门禁

# 批准 + 派发（fake 执行器零 LLM 跑通——第一次体验的最佳路径）
node core/programs/dispatch.mjs --auto --runner fake --json
node core/programs/fold.mjs --json && node core/programs/merge.mjs --json
```

装好插件的智能体会话里（claude code 或 dsh），直接说：*「列出你的 schflow 技能」「提一个改进提案」「跑一轮 tick」「看看板」「审计一下纪律」*。

> 完整生命周期——提案 → 评审闸 → 并行执行 → 合并队列 → 推送——见[设计文档](docs/design.md)与宿主说明：[claude code](hosts/claude-code/README.md) · [dsh](hosts/dsh/README.md) · [ZCode](hosts/zcode/README.md)。

## 宿主支持

| 宿主 | 安装 | 执行器家族 | 说明 |
|---|---|---|---|
| claude code | marketplace 插件 | 原生 subagent（会话内）/ `claude -p` 子进程 | per-agent 工具白名单；[README](hosts/claude-code/README.md) |
| dsh | bundle 插件 | `dsh --profile headless` 子进程 / GUI 原生 | 技能经 `skill-filesystem`；[README](hosts/dsh/README.md) |
| ZCode | cron 模板 + skills | 宿主原生 | [README](hosts/zcode/README.md) |

## 文档

- [docs/design.md](docs/design.md) — 完整设计（架构、拨盘模型、扩展点、合并队列、安全模型）
- [docs/spec/](docs/spec/) — 契约：任务卡 · 事件 · result · tick · 八程序
- [docs/adr/](docs/adr/) — 从久经实跑的前代流水线蒸馏的 31 条 ADR
- [golden/](golden/) — 金场景：性质断言（CI）+ judge 评分表

## 路线图

- `schflow` CLI 收拢（子命令 + `setup`/`doctor`——下两条命令随 M0 交付）：

  ```bash
  npx schflow@latest setup --host auto   # 规划中（M0）：探测已装宿主
  npx schflow doctor                     # 规划中（M0）：环境体检
  ```

- tick 循环引擎吸收（零 LLM `schflow tick`，拨盘最右）
- 更多适配器（codex 等）、daemon 调度、通知 sink

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。设计变更走 [docs/design.md](docs/design.md)；「为什么这样设计」住在 [ADR](docs/adr/) 里。

## 许可

[Apache-2.0](LICENSE)
