---
description: 手动跑一轮 schflow tick（等价于 orchestrator cron 触发）
---

按 skills/orchestrator/SKILL.md 执行一轮完整 tick（七步序列）。本会话有 subagent 工具——派发走原生家族（`dispatch --task <id> --no-spawn --launcher claude-code` + subagent 派生，任务书路径在返回 JSON）。结束输出三行摘要 + deferred 清单。
