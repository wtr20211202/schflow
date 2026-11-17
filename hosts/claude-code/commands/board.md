---
description: schflow 看板一屏（在途/待合/受阻/暂缓原因）
---

读取 `$SCHFLOW_HOME` 状态并输出一屏看板（全部只读，不写任何状态）：

1. 先跑 `node core/programs/status.mjs --json`（索引健康）；
2. 按 index/tasks.json 分栏输出：**在途**（running：id/标题/runNo/家族）｜**待合**（done 未归档：id/分支/(repo,base) 队列位置）｜**受阻**（blocked：result.summary 一句话）｜**待决策**（pending）｜**已批准未派发**（含 dispatch 上次报告的暂缓原因——events 里最近的 deferred 清单）；
3. 尾部一行：今日合并笔数（events 当日 merge.done 计数）+ 租约占用（state/leases.json）。
