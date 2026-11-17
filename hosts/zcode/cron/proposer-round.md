# ZCode cron · proposer 提案轮模板（薄壳）

> CronCreate 提示词用本文件全文。节奏建议：每天 1~2 轮（`0 9,21 * * *`），每轮一个 direction。

---

按 skills/proposer/SKILL.md 执行一轮提案（schflow 提案员）。本轮 direction：`industry`（次日轮换 `polish`——视角池与产出纪律以 `$SCHFLOW_HOME/directions/` 用户层覆盖为准）。

要点：取号（next-id）→ 查重（dup-check，命中即弃）→ 产出五件套 → 内嵌冷眼评审（勉强=弃稿）→ validate-task 过闸 → 入库（task.created 事件）。每轮配额按 direction 文件（industry 默认每轮 1~3 条）。只提不做。

结束输出：本轮产出条数 + 弃稿数（一句话理由）+ 新任务 id 列表。
