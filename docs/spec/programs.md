# Spec · 通用层八程序（v1，两形态共用正典）

> P0.5 随包脚本形态（node 直跑，动词=文件名）；M0 起收拢进 `schflow` CLI 子命令。八程序↔引擎模块吸收映射见文末（P2-4）。全部幂等、退出码语义统一。

## 通用约定

- **退出码**：`0` 成功；`1` 业务失败（有明确输出）；`2` 前提缺失（环境/文件不存在）；`75` 忙等/锁（调用方可稍后重试）；`76` 校验拒绝（schema/权限）。
- **输出**：人读默认 + `--json` 机读；长文本入参走 `--body-file`（CLI 即 API 纪律）。

## 八程序

| 程序（CLI 子命令名） | 职责 | 输入 → 输出 | 失败语义 |
|---|---|---|---|
| `next-id` | HOME 级原子取号（`--peek`=只读预告下一号：date 滚动语义照常，不取锁不写计数，坏计数文件如实报错） | – → 新 id | 锁忙 exit 75 |
| `status` | 任务卡校验（task-card spec）+ 派生索引重建；**新介质下不再解析散文**——判定=校验+索引 | 路径 → index/ 更新 | 校验失败 exit 76 + fail-closed 清单 |
| `dup-check` | 双通道查重（jaccard+实锚） | 标题/锚点 → 命中清单 | 告警非拒绝 |
| `validate-task` | intake 格式门禁（task-card spec 全规则，含 highest/exclusive-human 机械拒绝） | task.yaml → 通过/违规清单 | 违规 exit 76 |
| `dispatch` | 选任务（「可派」=已批准+依赖解除+无逻辑冲突+**已获 env 租约**——等租约者跳过不阻塞后续候选，暂缓原因 `env-wait` 落队列报告；多候选循环派发至槽满）→解析仓库（task.repo → project.repo）→按解析序定 base（task.base→项目 default-base→repo HEAD）建/占 worktree（分支名 `schflow/<id>`）→家族自动判定→起执行器→落 dispatched 事件。**`--no-spawn`**=宿主原生家族：只记账（worktree/租约/翻转/事件/pool，无 pid），执行器由宿主 subagent 派生，任务书路径回传调用方。**`--retry <id>`**=env-retry 受阻原子重派（与 `--task`/`--auto` 互斥）：仅当 `status=blocked ∧ triage=env-retry ∧ attempts<上限`（`--max-attempts` 缺省 10）——先 transition `blocked→approved`（actor=engine，reason=`retry:<triage>`）再复用显式单发路径一体派发；否则 exit 76 附可行动说明。**runner-cmd（custom）支持 argv 数组（推荐，零 shell 直启）或字符串（经平台 shell——引号/重定向语义平台相关，跨平台请用数组）** | id → runNo/事件 | 槽满 exit 1；白名单拒绝 exit 76；env 无租约=跳过该候选（非终止） |
| `fold` | 查活性（runs/ 落盘面）→读 result.json→状态翻转→落 folded 事件。**blocked 折叠即程序化受阻分诊**（judge③ 判断钩子，core/lib/triage.mjs）：结论落卡 `triage` 字段（单一事实源，orchestrator 只消费不重算），`triage/triageSignals/triageHint` 入 folded 事件供审计（三档 `env-retry/dep-wait/design-human`）。**attempts 语义**：派发时递增、runNo=attempts；interrupted 折叠回 approved 不再加计（「+1 重派」净效果由下次派发兑现）。**原生家族条目（无 pid）只认 result.json + 超时判定**（`--native-timeout-min`，默认 120 同租约 TTL 口径）——宿主会话中断（配额墙/崩溃）无活性信号，超时或 `--force <id>` 人工强制折叠为 interrupted | id → 新状态 | 解析失败=interrupted 重派 |
| `merge` | 规范 tick 序列第 5 步全过程（含 ejected/树等价两分支与出口扫描）。**零交集判定在 rebase 前算原始 fork**（rebase 后分支必坐在 base 上、谓词恒真——实测教训）；rebase 冲突按 ejected 同族处置（本支回炉，队列继续） | 队首 id → merge.done/failed/ejected | 见 tick spec |
| `event` | 事件追加（信封+分卷）；**`--list`**=只读回放查询（按分卷顺序回放，`--type a,b`/`--task <id>` 过滤、`--last N` 尾取，人读一行 `seq ts type taskId 摘要k=v`，`--json` 对象数组；损坏行跳过并注记；不取锁） | 事件对象 → 行号；过滤条件 → 事件清单 | seq 冲突=拒绝；`--list` 与 `--body-file` 同给 exit 2；`--last` 非法 exit 76 |
| `harvest`（八程序扩展⑨，tick 第 3b 步） | 转生收割（§6.3 RCA→fix 闭环收口）：done 的 investigate/research 报告（deliverables/*.md）中**显式 `schflow:spawn` 块** → 自动转生新提案（kind=fix 缺省，沿用源 repo/base/project，status=pending 走评审闸；血缘锚 `harvestSource` 幂等——锚检查覆盖 open+归档，源归档后重跑不重发；**落盘前自过 validateTaskCard**，程序生成与 intake 同一门禁） | `--task <id>`（含归档源，findTaskDir 语义）/ `--all`（open done 态 + done/<YYYY-MM>/ 归档区两 kind）/ `--dry-run` → spawned/跳过清单 | 源非 done 或 kind 不符 exit 76；生成的卡不合法 exit 76 **不落盘**（防毒化 status fail-closed 面） |

## direction schema（正典 = skills/directions/ 现骨架，逐字段一致）

`{name, mode: propose|patrol, trust: trusted|semi|untrusted, focus, quota:{per-round:[min,max]|null}, priority-cap 与 priority-default（两个可选字段，cap=上限约束 / default=缺省档）, perspectives[], prompt-overrides[], exclusive-human?, privileges:{priority}?}`——枚举键一律英文（P2-3）。**trust 正典位**：direction.trust 是方向的默认信任级，intake 时抄入 task.yaml 的 `source.trust`（逐任务事实记录）；webhook 源无 direction，恒 `untrusted`（§5.2 对策 6 输入）；improve 源恒 `semi`。`quota.per-round: null` = 不适用（human 人工立件）。

## 八程序 ↔ 引擎模块吸收映射（P2-4）

`next-id/validate-task/status/dup-check → intake+store`；`dispatch/fold → pool+runner`；`merge → mergeq`；`event → events`——v1 引擎逐模块**行为等价吸收**（拨盘精确化承诺），状态文件为唯一兼容契约。
