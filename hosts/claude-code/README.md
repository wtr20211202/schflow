# hosts/claude-code

claude code 接入包——**官方插件形态**（`.claude-plugin/plugin.json` + skills/commands/agents 内嵌；仓库根 `.claude-plugin/marketplace.json` 使本仓库本身即一个 marketplace）。

## 安装（官方分发路径）

```bash
# 官方 marketplace 机制（本仓库即 marketplace）
/plugin marketplace add wtr20211202/schflow
/plugin install schflow@schflow
```

开发期本地路径同款可用（`claude plugin marketplace add <本地仓库路径>`，已真机验证：details 显示 7 skills + 1 agent + 3 commands）；GitHub 定址安装见上。skills 与仓库正典的逐字节一致性由 CI 守卫（`core/test/unit/claude-plugin-sync.test.mjs`）。

## 包内容

| 项 | 说明 |
|---|---|
| `.claude-plugin/plugin.json` | 官方插件元数据 |
| `skills/` | proposer / orchestrator / executor / improve（正典拷贝） |
| `commands/` | `/propose`（human 特权立件）`/board`（只读看板）`/tick`（手动一轮 tick） |
| `agents/schflow-executor.md` | 执行器子代理（官方 .md 形态）：per-agent 工具白名单承载挂载面强制——§5.1 对策 3 的 claude code 落点 |

## P0 真机验证结论（2026-11-16，Claude Code 2.1.215 / Node 25）

| 能力 | 实测 |
|---|---|
| headless | ✅ `claude -p "…" --output-format json`：`{type:"result", subtype, result, session_id, usage, total_cost_usd, permission_denials}` 齐备 |
| 会话续跑 | ✅ `--resume` / `--continue` |
| 结构化输出 | ✅ `--output-format json / stream-json` |
| 权限门禁 | ✅ `--permission-mode`、`--allowedTools` / `--disallowedTools` |
| 知识挂载 | ✅ `--add-dir`；skills/CLAUDE.md 目录注入 |
| 模型选择 | ✅ `--model` / `--fallback-model` |

## 环境实测注记（v1.0.13~15 验收，Windows + Git Bash）

- **宿主会话形态**：`claude -p --dangerously-skip-permissions --output-format json "<提示词>"` 前台运行正常（Cycle B/J1 验收形态）。cron 场景直接用系统 cron 拉起同款前台命令。
- **执行器子进程家族本机受限**：从 node 程序 spawn `claude.exe`（直启 / `cmd /c` / `bash -c`，任意 stdio/detached/windowsHide/env 组合）均零输出挂死；交互 bash 前台启动正常。判定为本机 MSYS Pty 环境特例——**Windows 下派发执行器走原生家族（`--no-spawn` + 宿主 subagent）或 cron 前台形态**；POSIX 上子进程家族按 runner 默认形态使用。
- **配额墙**：`429 [1308] 5 小时限额` 可打断会话（实测两次）——引擎侧兜底=fold `--native-timeout-min` / `--force <id>`；备用通道=dsh（独立配额，J1 即以此完成）。
