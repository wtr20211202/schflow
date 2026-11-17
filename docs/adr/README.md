# ADR 索引 —— 31 条先行流水线实战决策（完整匿名化改写）

这些 ADR 源自一套在单一宿主上实跑约两个月的「提案→批准→并行 worktree 执行→串行合并」增强流水线（下称**先行流水线**）。它们不是理论推演：每条背后都有真实事故或代价。schflow 的引擎纪律直接从这里继承——**学费已交过的地方，不再靠提示词自觉**。

## 匿名化对照表（先读）

| 原文语境 | 本卷统一表述 |
|---|---|
| 宿主 IDE/编排器产品名 | 先行宿主（Agent IDE + cron + 工作流引擎） |
| 自托管 Git 服务（私有部署） | 自托管 Git 服务 |
| Linux 子环境（跑 Linux 门禁与交叉编译） | Linux 子环境 |
| 各真实端口号 | 验证实例 / 真实使用实例 / 槽位端口段（去具体数字） |
| 模型商品名 | 高判断模型（贵）/ 廉价执行模型（廉）/ 备用模型 A/B |
| 宿主产品仓库名 | 目标仓库 |
| 产品加密凭据库 | 加密凭据库 |
| 台账 proposals.md + 脚本家族 | 提案台账（单文件 markdown）+ 随包脚本 |

## 落点图例（schflow 中的归属）

- `E` 引擎代码（硬编码纪律）｜`D` 引擎默认值 + Profile/kind 可调｜`P` Profile/适配器配置｜`S` 提示词/评审策略（智能体侧）

## 索引

| # | 标题 | 落点 | 状态 |
|---|---|---|---|
| [0001](ADR-0001-rolling-batch-refill.md) | 滚动批次与补位派发 | E | accepted |
| [0002](ADR-0002-continuous-merge-within-tick.md) | tick 内连续合并 | E | accepted |
| [0003](ADR-0003-judgment-vs-implementation-split.md) | 判断与实施分层（修码剥离） | S/E | accepted |
| [0004](ADR-0004-no-timeout-dead-run-alert.md) | 运行无时限，死运行只提示 | E | accepted |
| [0005](ADR-0005-full-e2e-trigger-evolution.md) | 全量回归触发演进 | D | superseded-by-0030 |
| [0006](ADR-0006-freshness-triage.md) | 提案时效性三岔 + 已过时终态 | D | accepted |
| [0007](ADR-0007-logical-conflict-only.md) | 只治逻辑冲突，文件重叠交串行合并 | D | accepted |
| [0008](ADR-0008-delete-merged-branches.md) | 已合分支删除（-d 安全阀） | E | accepted |
| [0009](ADR-0009-shared-verification-instance.md) | 常驻验证实例验证的是合并整体 | P | accepted |
| [0010](ADR-0010-single-push-authority.md) | 推送主体唯一（快进-only） | E | accepted |
| [0011](ADR-0011-full-parallelism-mandate.md) | 满并行硬要求 | E | accepted |
| [0012](ADR-0012-merge-on-complete.md) | 待合即合（四守卫） | E | accepted |
| [0013](ADR-0013-quota-window-history.md) | 配额与夜间窗口的设立与撤销史 | D | superseded-by-0030 |
| [0014](ADR-0014-regression-decoupling.md) | 全量红与流水线解耦 + 环境方差治理 | D | accepted |
| [0015](ADR-0015-status-slot-write-discipline.md) | 状态槽位写纪律（最小插入） | E | accepted |
| [0016](ADR-0016-two-tier-fuel.md) | 两级燃料 | P | superseded-by-0017 |
| [0017](ADR-0017-fuel-chain.md) | 燃料链：任意模型 + 顺延 + 自动切换 | P | accepted |
| [0018](ADR-0018-gate-queue-and-wip-salvage.md) | 门禁并发队列锁 + 重置前 WIP 保全 | P/E | accepted |
| [0019](ADR-0019-real-usage-instance.md) | 真实使用实例与外部数据面安全阀 | P | accepted |
| [0020](ADR-0020-batch-tail-governance.md) | 批次长尾治理七项 | D | accepted |
| [0021](ADR-0021-embedded-proposal-review.md) | 提案产出内嵌冷眼评审 | S | accepted |
| [0022](ADR-0022-dispatch-validation.md) | 派发参数严格校验（path 源教训） | E | accepted |
| [0023](ADR-0023-no-history-rewrite.md) | 禁改写已推历史 + 非快进树等价消解 | E | accepted |
| [0024](ADR-0024-runtime-rebrand-contract.md) | 运行时标识变更的契约跟进 | P | accepted |
| [0025](ADR-0025-claim-hardening.md) | 领取判定硬化（只认状态槽） | E | accepted |
| [0026](ADR-0026-machine-readable-status.md) | 状态判定层（机读唯一来源） | E | accepted |
| [0027](ADR-0027-debounce-window.md) | 攒批去抖窗 | D | superseded-by-0030 |
| [0028](ADR-0028-static-branch-exemption.md) | 静态支免全量 | D | absorbed-by-0030/kind |
| [0029](ADR-0029-dual-repo-release-chain.md) | 双仓发布链适配定案 | P | accepted |
| [0030](ADR-0030-on-demand-full-e2e.md) | 全量回归按需制 | D | accepted |
| [0031](ADR-0031-fold-timing-and-gate-relief.md) | 折叠时效/补位硬约束 + 门禁链减负 + 心跳（合集） | E/D | accepted |

> 先行流水线的「已知问题/观察项」未入本卷（属观察项非决策）；其中两条（宿主运行确认闸、宿主进程退出即执行全灭）是 schflow 选择独立进程 + headless 调用的直接动因，见 docs/design.md §2/§3-D1。
