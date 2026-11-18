# core · 通用层（八程序 + 状态目录约定）

> P0.5 随包脚本形态（node ≥20 直跑，动词=文件名，零构建）；M0 起收拢进 `schflow` CLI 子命令（M0~M5 见 [docs/design.md §17](../docs/design.md)）——
> 状态文件 schema 是两形态唯一兼容契约（拨盘精确化承诺）。规格正典：`docs/spec/`（programs/task-card/events/result/tick）。

## 用法

```bash
export SCHFLOW_HOME=~/.schflow          # 缺省即此
node core/programs/next-id.mjs          # → P-20261117-3
node core/programs/dispatch.mjs --auto --json
```

全部程序：`--home <dir>`（覆盖 HOME）+ `--json`（机读）+ `--body-file`（长文本入参）。
退出码：`0` 成功 / `1` 业务失败 / `2` 前提缺失 / `75` 忙等锁 / `76` 校验拒绝。

| 程序 | 一句话 | 关键语义 |
|---|---|---|
| `next-id` | HOME 级原子取号 | 跨日重置；锁忙 75；`--peek` 只读预告下一号（不取锁不写计数） |
| `status` | 校验全部任务卡+重建索引 | **fail-closed**：违规 exit 76 且不重建索引 |
| `dup-check` | 标题 jaccard + 实锚双通道查重 | 告警非拒绝（恒 0）；阈值 0.20 可调 |
| `validate-task` | 格式门禁（task-card spec 全规则） | highest/exclusive-human 机械拒绝 |
| `dispatch` | 补位派发 | 见下 |
| `fold` | 折叠在途 | 活性=落盘面证据（result.json / pid） |
| `merge` | per-(repo,base) 合并队列 | 见下 |
| `event` | 事件追加（信封自动补） | 封闭枚举；`--allow-unknown-type` 逃生口；`--list` 只读回放查询（`--type/--task/--last`，不取锁） |
| `harvest` | 转生收割（八程序扩展⑨；tick 第 3b 步） | done 的 investigate/research 报告显式 `schflow:spawn` 块 → fix 提案转生（pending 走评审闸）；`--all` 扫 open+归档区，`harvestSource` 锚幂等（源归档后重跑不重发）；落盘前自过门禁（违规 76 不落盘） |

### dispatch 补充

- 可派 = 已批准 + 依赖已解除（目标终态）+ env 租约已获（取不到=跳过，原因 `env-wait` 入报告）+ 槽位（项目 `concurrency`，缺省 2；无项目任务吃 HOME 全局池）。多候选循环派发至槽满（满并行纪律）。
- runner：Profile `runner:` 或 `--runner` ∈ `fake | claude | dsh | custom`（**无静默缺省**——防误用 fake）；custom 配 `runner-cmd`：**argv 数组形态（推荐，零 shell 直启，逐参数替换 `{book}`/`{cwd}`）** 或字符串形态（经平台 shell，引号/重定向语义平台相关——跨平台用数组）。claude/dsh 任务书恒走 stdin（dsh 用 `-`）。Windows 宿主 + WSL 内 dsh：`runner-cmd: ["node", "<schflow>/hosts/dsh/launcher/wsl-dsh.mjs", "{book}"]`（宿主包资产，core 无平台分支——跨平台纪律见下）。
- **`--no-spawn`**：宿主原生家族（拨盘左）——只记账（worktree/租约/翻转/事件/pool），执行器由宿主 subagent 派生（任务书路径在返回 JSON 的 `taskBook`）。fold 对无 pid 条目只认 result.json + **超时判定**（`--native-timeout-min` 默认 120，与租约 TTL 同口径）或 `--force <id>` 人工强制折叠——宿主会话被配额墙/崩溃打断时无活性信号，这是唯一兜底（P0.5 dogfood 实测 429 配额墙暴露的缺口）。
- **attempts 语义**：attempts 在**派发时**递增，runNo=attempts（第 n 次尝试=runs/n）；interrupted 折叠回 approved 不再加计——「中断=attempts+1 重派」的净效果由下一次派发兑现；配额类失败不进派发（无从递增）。
- **`--plan`**：只读候选预演（dry-run，judge①/⑥ 派发前裁决的结构化候选面）——与真实派发共用同一评估器（status/依赖/槽位/repo·base 解析/env 匹配+租约可得性，同序同原因），输出每候选 将派发/暂缓+原因（`--json` 形态 `{plan:[{id,wouldDispatch,reason}]}`）。零状态变更零事件（不取写锁/不回收孤儿租约/不建 worktree/不取租约/不翻转），恒 exit 0（参数非法才非 0；与 `--retry` 互斥）。advisory only——预演不预留租约/槽位，真实派发仍重新评估。
- 逻辑冲突治理=judge①（orchestrator 判断点），程序不越权。

### merge 补充（tick spec 第 5 步的程序化身）

序列：per-branch lock → 合并工作树净守卫 → **零交集判定（在 rebase 前算原始 fork**——rebase 后算必恒真）→ rebase（**冲突三级自动恢复链 v1.0.26**：L0 abort+300ms 退避重试一次 → L1 非交叠语义合并——逐文件 `merge-file --diff3` 块级安全判据〔base 段空=双侧纯追加拼接 / 单侧==base=取对侧 / 双侧改写同段=不安全弃〕+增量行多重集完整性后验 → L2 judge② 仅 `--judge-resolve` 启用——三方内容喂 LLM 出一行 JSON `{verdict: adopt-theirs|adopt-ours|merge-both|escalate, rationale, files?}`，adopt/merge 自动应用，escalate/不可解析/缺盖/超时 fail-closed abort；缺省零 LLM，L0/L1 照常；自愈落 `merge.auto-resolved{level}`、裁决落 `merge.resolved{verdict}`）→ 复验（零交集跳过；`when: always|specs-nonempty` 谓词；复验链是 L1/L2 的语义兜底）→ `--no-ff` 合并 → 出口扫描（内置 secret 特征集）→ base 推进（被主 checkout 持有时=主树干净守卫+ff-only；否则 update-ref 带旧值校验）→ push（快进-only，非快进=树等价消解或挂起）→ 删支（`-d` 安全阀）→ 归档。

- **ejected 族**：复验失败 / rebase 冲突（恢复链 L0~L2 穷尽后仍败）→ 该支标受阻回炉（blocked→approved→重派），队列继续下一支（不队头阻塞）；
- **挂起人工（停队列）**：secret-scan 命中 / 分支失踪 / 未知 verify 谓词 / 主树脏 / 推送非快进且非树等价 / merge 冲突 / 合并工作树脏；
- 幂等恢复：已合入分支（is-ancestor）→ 补 merge.done+归档；merge.done 事件已落但未归档 → 补归档。

## 状态目录约定（两形态同构正典——v1 引擎逐字段继承）

```
$SCHFLOW_HOME/                    # 默认 ~/.schflow；SCHFLOW_HOME 覆盖；程序 mkdir -p 幂等自举
  tasks/
    open/<ID>/                    # 活跃任务（目录自包含）
      task.yaml                   #   任务卡（唯一事实源，schema=docs/spec/task-card.md）
      proposal.md                 #   五件套正稿
      runs/<n>/                   #   每次尝试：task-book.md / result.json / transcript.{out,err} / output.md
      design/ plan/ deliverables/ review.md
    done/<YYYY-MM>/<ID>/          # 终态归档（月分卷；fold done(非git)与 merge.done 触发）
  projects/<name>/schflow.yaml    # 项目区 Profile（字段：repo/default-base/concurrency/runner/
                                  #   runner-cmd/executor/model-pool/mounts/verify/schemaVersion/ref）
  projects/<name>/envs.yaml       # 项目层环境池（同名覆盖 HOME 层）
  events-YYYY-MM.jsonl            # 事件流（月分卷，seq 跨卷全局单调；崩溃恢复正典源）
  envs.yaml                       # HOME 层环境池（provider: static|command）
  index/tasks.json                # 派生索引（可全量重建的缓存；status 程序维护）
  state/                          # 引擎内部状态（非用户层）
    id-counter.json               #   取号计数 {date,last}
    pool.json                     #   执行池 {inFlight:[{taskId,runNo,pid,family,launcher,worktree,branch,env,scope,startedAt}]}
    leases.json                   #   环境租约 {envs:{name:{mode,capacity,holders:[{taskId,runNo,acquiredAt}]}}}（可事件重放重建）
    locks/*.lock/                 #   mkdir O_EXCL 目录锁（write/tick-*/merge-*；同进程重入安全；>10min 陈旧可偷）
    mount-whitelist.txt           #   挂载白名单（登记制：存在即强制，一行一前缀）
  logs/  knowledge/               # 引擎日志 / 用户知识挂载位
```

**worktree 布局**（仓库外侧，同盘）：`<repo 父>/.schflow-worktrees/<repo 名>/<ID>`（执行工作树）与 `.../merge-<base>`（合并工作树，detached——与任何 checkout 零互斥）。工作分支 `schflow/<ID>`。

**并发纪律**：HOME 写锁=短临界区（一切状态写，程序内置）；tick 锁=per-project（orchestrator 侧）；merge 锁=per-(repo,base)。状态写全部 tmp+rename 原子写。

## 执行器环境契约（任务书之外的机读面）

| 变量 | 含义 |
|---|---|
| `SCHFLOW_TASK_ID / SCHFLOW_RUN_NO` | 任务 id / 尝试序号 |
| `SCHFLOW_TASK_DIR / SCHFLOW_RUN_DIR` | 任务目录 / 本次 runs/<n> |
| `SCHFLOW_WORKTREE / SCHFLOW_BASE` | worktree 绝对路径（非 git 任务为空）/ 基准分支 |
| `SCHFLOW_LEASE_ENV / SCHFLOW_LEASE_REF` | 租约环境名 / 其不透明 ref（参考文件/句柄——引擎不经手） |

result.json 必须 tmp+rename 原子写（fold 并发读）；git 提交带 `(<id>)` 尾注（幂等重入 grep 锚）。

## 跨平台实现注记（实测沉淀；win/mac/linux 红线的落点）

**三条纪律**（v1.0.14 定）：

1. **core 内置启动器一律 argv 数组直启、零 shell**——shell 字符串的引号/重定向语义在 cmd.exe 与 POSIX sh 间不可移植（实测：`cmd /S` 引号吞噬使 `<` 重定向静默挂死；`node -e '…'` 单引号在 cmd.exe 不剥离）；
2. **平台差异只允许出现在 `hosts/` 宿主包与 Profile 命令里**——core 不写平台分支（Windows+WSL 的 dsh 桥 = `hosts/dsh/launcher/wsl-dsh.mjs` + Profile `runner-cmd` 数组）；
3. **任务书恒走 stdin**（claude `-p` / dsh `-`）——避开 argv 长度上限与转义，天然跨平台。

- **子进程存亡**：executor 一律 `detached: true`——Windows 上脱离派发者 Job（`spawnSync` 场景 job 关闭连坐全部后代，实测复现）；POSIX 上新会话防 SIGHUP；spawn 异步错误写 transcript.err（ENOENT 等不让 unhandled error 掀翻派发器）；
- **shell 引号**：verify/envs 钩子命令经 `shell:true` 执行——Windows cmd.exe 对引号的二次包装会形变，**跨平台命令免引号或用脚本文件**；
- `pidAlive`：kill(pid,0) 的 EPERM/EACCES 均按存活处理（权限误报防假死）。
