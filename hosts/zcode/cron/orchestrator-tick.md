# ZCode cron · orchestrator 逐 tick 驱动模板（薄壳——提示词文件是唯一事实源）

> CronCreate 提示词就用本文件全文（或指向本文件路径让 cron 读入）。cron 本身零逻辑：到点=把这段话喂给一个新编排器会话。
> 节奏建议：`*/20 * * * *`（先行流水线实证节奏；任务少可放宽，任务急可收紧——节奏是参数不是纪律）。

---

按 skills/orchestrator/SKILL.md 执行一轮完整 tick（schflow 编排器）。要点重申：

1. 环境变量 `SCHFLOW_HOME` 已就位（缺省 `~/.schflow`）；
2. 七步序列照 docs/spec/tick.md：心跳（event 程序）→ 状态同步（status 程序，fail-closed）→ 折叠（fold）→ 补位派发（dispatch --auto）→ 合并队列（merge）→ 收尾报告；
3. 派发前做家族自检：本会话有 subagent 工具 → `dispatch --task <id> --no-spawn --launcher zcode` 后以 subagent 派生 executor（任务书路径在返回 JSON）；没有 → `dispatch --auto` 走子进程；
4. 判断点（冲突治理/窄口径裁决/受阻分诊/时效预检）出结构化结论；读不懂状态=挂起等人，绝不猜；
5. 结束时输出三行内摘要：派发/折叠/合并各几笔 + 挂起项（deferred 清单原样带出）。

不要做的事：手工 git merge / 手工 push / 手工翻转任务状态 / 跳过序列步骤。
