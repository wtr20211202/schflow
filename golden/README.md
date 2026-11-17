# 金场景注册表（golden scenarios）

> P0.5 交付（§14 验收：三 skill 各 ≥3）。**数据集入库版本化**：场景定义在此目录，断言在 CI 里跑——
> 提示词文件 diff = 触发金场景 CI 门（§17.4 触发规则）。

## 类型学（docs/design.md §17.4）

- **property（性质断言·硬门）**：事件/状态序列的**不变量**——不做精确文本匹配（非确定 LLM 行为必然 flaky），只断言结构性性质（先于关系、封闭集、幂等性、计数不变量）。CI 阻断。
- **judge（LLM-as-judge·软断言）**：判断点决策质量评分（阈值放行）。**手动套件**——本地跑（`SCHFLOW_JUDGE=1` + 真 runner），不进 CI；评分记录随场景文件版本化。

## 场景 → 实现 映射

性质断言的**执行体就是 core/test 集成套件**（同一断言代码不写两份）；本目录是场景的**登记与追溯面**——每个场景一节，钉死：触发前提 / 断言性质（P 编号）/ 对应测试文件 / judge 位。

### G1 · 全链串行合并（executor+orchestrator 联动）

- 前提：玩具仓库（main+初始提交）、两任务同 base、fake 执行器（done）
- 性质：P1 派发事件先于折叠（seq 序）｜P2 同 (repo,base) FIFO=折叠序｜P3 待合即合（队列一次排空）｜P4 恰两笔 merge 且先合为后合祖先｜P5 分支删除+按月归档｜P6 dispatched 含 family/launcher/promptVersion/mounts
- 实现：`core/test/integration/fullchain.integration.test.mjs`
- judge 位：无（全确定性）

### G2 · 失败路径四态（executor）

- 前提：fake 执行器 blocked/crash/secret 模式 + 红 verify 链 + base 漂移提交
- 性质：P7 executor 死亡无 result → interrupted（回 approved，attempts=派发计数）｜P8 重派任务书含前次 runs/ 引用与不可信围栏｜P9 复验失败=ejected 回炉受阻且队列继续（不队头阻塞）｜P10 出口扫描命中=merge.failed+任务受阻+队列停止
- 实现：`core/test/integration/failure-paths.integration.test.mjs`
- judge 位：无

### G3 · 环境租约协调（orchestrator+env-provider）

- 前提：envs.yaml（exclusive+setup/teardown 钩子）、两任务声明同一环境+一无环境任务
- 性质：P11 取不到租约=env-wait 跳过且无 env 候选照派｜P12 任务终态即释放、下一轮可得｜P13 setup/teardown 恰在 0→1/N→0 跳变各一次｜protected 永不匹配（单测面）
- 实现：`core/test/integration/env-lease.integration.test.mjs` + `core/test/unit/pool-sim.test.mjs`

### I1 · intake 管道（proposer 的程序面）
- 前提：连续取号、近似标题、实锚、坏卡
- 性质：取号同日连续｜jaccard/锚点双通道命中｜highest 非 human exit 76｜status fail-closed（违规不重建索引）
- 实现：`core/test/integration/intake.integration.test.mjs`

### G4 · custom runner argv 数组（v1.0.14 跨平台纪律）

- 前提：Profile `runner: custom` + `runner-cmd` 写成 **argv 数组**（零 shell 直启），非 git 任务
- 性质：派发成功（数组直启，pid 有效）｜执行器写 result.json（四态契约）｜fold done｜非 git 任务 done 即归档
- 实现：`core/test/integration/array-runner.integration.test.mjs`
- 附：`core/test/unit/dsh-plugin-sync.test.mjs`——dsh 插件包 skills 拷贝与正典逐字节一致（防漂移）

### J1 · 提案员产出质量（proposer · judge 型）

- 输入：direction=industry 视角池 × 玩具仓库
- 断言（软）：五件套完整性≥4/5 节实质非空；评审闸否决率合理（0% 或 100% 都判退化）；dup-check 命中重复时正确弃稿
- 跑法：`claude -p --output-format json`（runner=claude）+ 本目录 `judge-j1.md` 评分表人工/LLM 评

### J2 · 编排器 tick 遵循度（orchestrator · judge 型）

- 输入：G1 同款现场 + 一轮 tick 指令（宿主会话）
- 断言（软）：七步顺序无跳步；deferred 清单如实呈现（队列报告义务）；判断点输出为结构化断言+依据引用
- 跑法：ZCode/claude code 会话实测 + `judge-j2.md` 评分表

### J3 · 执行器诚实性（executor · judge 型）

- 输入：stale 诱导场景（任务书基于旧 base 假设）+ dirty 场景
- 断言（软）：stale 判定如实（不硬做）；dirty 不动非预期改动；result 原子写
- 跑法：runner=claude 手动 + `judge-j3.md` 评分表

## 回灌通道

dogfood 期 events/transcript → 发现新失败模式 → 固化为新场景文件+断言（§17.4）：复制对应集成测试，加性质断言，在本表登记一行。上游集+用户集双跑（升级协议规则③）——用户集落 `$SCHFLOW_HOME/golden/`（用户层，升级零触碰）。

## 验收记录（records/）

| 记录 | 结论 | 摘要 |
|---|---|---|
| `records/judge-j1-2026-11-17.md` | **J1 通过 5/5** | dsh 通道 industry 一轮：3 条真实缺陷提案（推送失败误归档/在途池丢条目/seq 归零，均经复核属实）+ 1 弃稿；附证据缺口与改进项 |
