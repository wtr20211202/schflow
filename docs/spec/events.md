# Spec · 事件流 events.jsonl（v1，两形态共用正典）

> 事件是**崩溃恢复的正确性来源**（§8 队列重建）兼可观测性唯一原料（§10）。只存元数据与引用，不存任务内容。分卷：`events-YYYY-MM.jsonl`（按月滚动，追加线程内单调）。

## 公共信封（每行一个 JSON 对象）

| 字段 | 说明 |
|---|---|
| `ts` | ISO8601 |
| `seq` | 全局单调递增（跨分卷延续） |
| `schemaVersion` | 本 spec 版本（`1`） |
| `actor` | `proposer` \| `orchestrator` \| `executor` \| `fixer` \| `patrol` \| `improve` \| `engine` \| `human` \| `webhook` |
| `taskId` / `runNo` | 可选引用 |

## 事件类型（封闭枚举）

`task.created` · `status.changed{from,to}` · `dispatched` · `folded{outcome}` · `env.leased{env}` · `env.released{env}` · `verify.run{cmd,exitCode}` · `review.recorded{verdict}` · `merge.started{branch}` · `merge.done{branch,sha}`（**记分支 SHA**，防拿错 head 类事故可核对）· `merge.failed{branch,reason}` · `merge.ejected{branch,reason}`（复验失败弹出，P1-10）· `lock.acquired/released{name}` · `heartbeat.tick{gapMin}` · `note.appended`

## dispatched 专有字段（防漂移与审计的载体）

`{family: native|subprocess, launcher, cli, model, mounts:[{path,version}], worktree, branch, promptVersion}`

- `promptVersion` = 所加载提示词文件 frontmatter `version`（P1-14：派发事件记录版本；doctor 比对 skills 包与 core 期望版本，不一致=警告）；
- `mounts[].version` = 解析后 pin（§5.1 对策 2）。

## 回放协议

崩溃恢复按 seq 顺序重放 `dispatched/folded/merge.*/env.leased/env.released` 重建执行池、合并队列与环境租约（§8）；事件流不可读时降级推导（任务卡 result + 分支存在性），歧义=挂起人工。

## 版本策略

新增事件**类型**不升 schemaVersion（前向兼容：消费方忽略未知 type）；既有类型**字段**变更才升版。
