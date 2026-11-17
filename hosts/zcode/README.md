# hosts/zcode

ZCode 接入包（P0.5）。ZCode 是 schflow 设计的出身宿主（先行流水线在其上实跑两个月+）。

## 打包形态（P0.5）

- skills + cron 提示词模板（先行流水线同款「cron 是薄壳、提示词文件是唯一事实源」形态）；
- 过渡期：zcode-legacy 执行适配器（宿主工作流引擎原路径，见 design.md §9/§12——运行确认闸与客户端进程宿命两缺口仍在，仅作桥接）。

## 样例文件（v1.0.13 落地）

- `cron/orchestrator-tick.md`（编排器逐 tick 模板，建议 `*/20 * * * *`）+ `cron/proposer-round.md`（提案轮模板，建议每日 1~2 轮）——CronCreate 提示词直接引用全文。
