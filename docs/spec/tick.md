# Spec · 规范 tick 序列（v1，两形态共用正典）

> 「拨盘两端行为等价」的前提：序列有唯一定义点。orchestrator skill（拨盘左）与 `schflow tick`（拨盘右）都是**本规范的实现**，不各自定序。先行流水线的宿主私有步骤（推送兜底、实例保鲜）归 Profile 钩子位，不入主序列。

## 主序列（每 tick，幂等，从文件重建认知）

| # | 步骤 | 实现 | 判断点 | 失败语义 |
|---|---|---|---|---|
| 0 | 心跳落盘 | `event` 程序写 `heartbeat.tick` 事件 | – | 失败=本 tick 立即放弃（宿主离线可判定，ADR-0031f） |
| 1 | 取锁 | **八程序通用约定的内置锁协议**（per-project tick 锁；写状态另取 HOME 写锁短临界区——非独立动词，程序内前置） | – | 取不到=本 tick 退出（另一 tick 在跑） |
| 2 | 状态同步 | status 程序：校验任务卡 + 重建派生索引 | – | **fail-closed**：校验失败跳过一切状态判定动作（ADR-0026） |
| 3 | 折叠在途 | fold 程序：查活性（落盘面证据）→ 读 result.json → 状态翻转；**3b 收割**：本轮 `folded{outcome:done}` 且源 `kind ∈ {investigate, research}` ⇒ 逐源 `harvest --task <id> --json`（RCA 报告显式 spawn 块→fix 提案转生，spawned/跳过原因原样入本轮报告——§6.3 RCA→fix 闭环；无块=不转生，fail-soft） | 死运行判定（ADR-0004/0017 三条件） | 非 running 当 tick 处置；跨 ≥2 tick 未处置=违规（ADR-0031a） |
| 4 | 补位派发 | dispatch 程序：优先级排序→依赖核对（已终结即解除）→逻辑冲突治理→**env 租约（等租约者跳过、暂缓原因 env-wait 入报告）**→占槽起执行器（家族自动判定；多候选循环派发至槽满） | **judge①** 逻辑冲突 | 空槽+可派（含已获租约）+无冲突⇒必须填满（ADR-0001/0011）；派发事件含 family/mounts/promptVersion |
| 3 | 折叠在途 | fold 程序：查活性（落盘面证据）→ 读 result.json → 状态翻转（**blocked 时程序化受阻分诊**：结论 `triage` 落卡+folded 事件带 triage/signals/hint——单一事实源，orchestrator 只消费不重算） | 死运行判定（ADR-0004/0017 三条件）；**受阻分诊=judge③ 判断钩子（程序内，core/lib/triage.mjs，三档 env-retry/dep-wait/design-human）** | 非 running 当 tick 处置；跨 ≥2 tick 未处置=违规（ADR-0031a） |
| 5 | 合并队列推进 | merge 程序：**per-branch lock** →守卫→rebase→复验（零交集跳过）→--no-ff→**出口扫描**→快进推送→删支 | **judge②** 窄口径裁决 | 复验失败=**ejected**（该支标受阻回炉，队列继续下一支——不队头阻塞）；推送非快进=树等价消解（同父+树哈希一致→对齐远端，ADR-0023），否则挂起人工 |
| 6 | 收尾 | 归档/事件分卷检查/释放锁 | – | 尽力而为 |

## Profile 钩子位（引擎外，可选）

- `on-tick-end`：推送兜底重试（先行 1c 同款）、实例保鲜（先行 1d 同款）、通知 sink flush——由 schflow.yaml 声明，主序列不感知。

## 全阶段义务

存在已批准未派发 ⇒ 必须报告并说明暂缓原因（队列报告义务，ADR-0025③）。
