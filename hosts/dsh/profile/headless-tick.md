# dsh 插件 · headless tick 调用模板（pnpm 插件制 + 手册兜底两种形态）

> dsh 插件面已实证（`dsh plugin --profile X add <pkg>`，pnpm 制 + `--patch` overlay + `--from-default-profile` 派生——详 hosts/dsh/README）。
> 本文件是**无插件场景的手册兜底**（cheatsheet 注入形态）：系统 cron 喂给 `dsh --profile headless` 的任务文本直接用下方模板。

## cron 形态（系统 crontab）

**key 注入（必需）**：cron 不继承登录 shell 的 `export`，且 web 凭据服务写入的 refs 形态不被 headless route 消费（实测 `MISSING_CREDENTIAL`）。二选一：① crontab 顶部环境变量行；② 命令前从凭据文件内联读取（示例即此形态，凭据文件权限 600、勿入库）。key 属用户凭据，schflow/dsh 均不代管（零凭据纪律同构）。

```cron
# 形态①：DEEPSEEK_API_KEY=sk-...   （写在 crontab 顶部，后续命令均继承）
# 形态②（示例）：从凭据文件内联注入
*/20 * * * *  cd ~/schflow && DEEPSEEK_API_KEY="$(cat ~/.config/dsh/deepseek.key)" dsh --profile headless "$(cat hosts/dsh/profile/headless-tick.md)"
```

## 任务文本（headless 单发自包含——dsh 无 resume 的补偿四条底线由任务书自包含承载）

```
你是 schflow 编排器，执行一轮完整 tick（序列=docs/spec/tick.md，七步，幂等）。
SCHFLOW_HOME 已就位。逐步执行：
1. 心跳：先写临时 JSON 文件（{"type":"heartbeat.tick","actor":"engine","gapMin":0}），再
   node core/programs/event.mjs --body-file <该文件>
2. node core/programs/status.mjs     # 状态同步；exit 76=fail-closed，报告后结束本轮
3. node core/programs/fold.mjs       # 折叠在途
4. node core/programs/dispatch.mjs --auto --json   # 补位派发（dsh 无 subagent——子进程家族）
5. node core/programs/merge.mjs      # 合并队列
6. 输出三行摘要：派发/折叠/合并各几笔 + deferred 清单（已批准未派发必须带原因）
判断点（冲突治理/裁决/分诊）按 skills/orchestrator/SKILL.md 出结构化结论；读不懂状态=挂起并说明，绝不猜。
不手工 git merge、不 push、不手工翻转状态。
```

## 提案轮（proposer）

同形态，任务文本换成「按 skills/proposer/SKILL.md 执行一轮提案，direction=industry」——五件套/查重/评审闸纪律以 skill 文件为准（headless 无渐进披露时把 SKILL.md 内容并入任务文本）。

## 韧性注记（429 配额墙/宿主中断）

- **症状**：宿主会话可能被 `429 [1308] 5 小时限额` 中途打断（实测）。原生家族（`--no-spawn`，条目无 pid）此时没有活性信号，任务会停在 running，dsh 进程退出本身不等于 tick 完成。
- **引擎侧兜底**（405e162）：`node core/programs/fold.mjs --native-timeout-min <分钟>`——按超时折叠（默认 120，与租约 TTL 同口径）；或 `node core/programs/fold.mjs --force <task-id>` 人工强制折叠为 interrupted，再由下一轮幂等重派。不要手改状态或手工翻卡。
- **cron 节奏**：间隔与限额窗口对齐（如 5 小时窗口用 `*/20` 起步，窗口耗尽后不要加密空转）；被打断的 tick 下一轮靠心跳/事件/折叠的幂等性续跑。
- **首查**：重启 tick 前先确认 key 仍在启动环境（见上节），否则只会重复 `MISSING_CREDENTIAL`，与配额墙无关。
