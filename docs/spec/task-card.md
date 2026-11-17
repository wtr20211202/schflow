# Spec · 任务卡 task.yaml（v1，两形态共用正典）

> 拨盘两端与八程序的共同读写对象。字段级 schema 是「与 v1 逐字段同构」承诺（§14 P0.5）的验收依据。校验器：P0.5 随包脚本 `validate-task`（八程序之一）；M0 起并入 `schflow`。

## 字段表

| 字段 | 类型 | 必选 | 约束 |
|---|---|---|---|
| `id` | string | ✓ | 正则 `^P-\d{8}-\d+$`；HOME 级全局唯一（取号程序保证） |
| `kind` | enum | ✓ | `code` \| `fix` \| `investigate` \| `docs` \| `research` \| `chore`（六类封闭集，registry 可扩但 v1 封闭） |
| `title` | string | ✓ | 非空，≤120 字符 |
| `status` | enum | ✓ | `待决策` \| `已批准` \| `进行中` \| `已做` \| `受阻` \| `已过时` \| `已否`（七态封闭集）——写英文键 `pending/approved/running/done/blocked/stale/rejected`，展示层映射中文 |
| `priority` | enum | ✓ | `highest` \| `high` \| `medium` \| `low`；`highest` 仅 source=human 合法（校验器机械拒绝，P2-2） |
| `source` | object | ✓ | `{type, direction?, trust}`；type 枚举 `generator` \| `human` \| `patrol` \| `harvest` \| `improve` \| `webhook`；direction 引用 `directions/<name>`；trust ∈ `trusted`（human/harvest）\| `semi`（generator/patrol/**improve**）\| `untrusted`（webhook）——**内容面防御输入（§5.2 对策 6；正典位见 programs.md direction schema）** |
| `dependsOn` | string[] | ✓ | 各项为合法 id；依赖目标已终结（done/stale/rejected）即视为解除 |
| `sessionOnly` | bool | ✓ | 默认 false |
| `project` | string? | – | 项目区名；缺省 = 全局池任务（§8） |
| `profile` | string? | – | 显式 Profile 名；路由规则见 §7 |
| `repo` | string? | – | **任务级仓库绑定**（绝对路径，免项目注册——任意目录使用/上下文注入场景）；解析序 task.repo → project.repo |
| `parent` | string? | – | L 级拆解的父任务 id；父任务收口前子步骤按 dependsOn 正常流转 |
| `base` | string? | – | **基准分支**（git 轨道任务）：worktree 起点、合并回该支、合并队列分键（(repo,base) 复合键）；解析序 `task.base → 项目 default-base → repo HEAD 默认分支` |
| `env` | string \| labels[]? | – | **验证环境需求**（如 `staging-a` 或 `[linux, has-db]` 标签匹配）——声明即触发派发时租约协调（§8 环境池） |
| `branch` | string? | – | git 轨道任务派发后回填（工作分支名） |
| `deliverables` | object[] | – | `[{path, type: report\|code\|doc}]`；kind 契约见 §6.3 |
| `docs` | string[] | – | design/ 等外链文档相对路径 |
| `attempts` | int | ✓ | 默认 0；配额墙类失败不递增（契约底线⑤） |
| `createdAt` / `updatedAt` | ISO8601 | ✓ | 引擎/程序维护，人工直改走 `reconcile` |
| `result` | object? | – | 执行收编后回填，结构 = result.json 契约（docs/spec/result.md） |
| `triage` | enum? | – | 受阻分诊结论（fold blocked 分支与 result 同写，单一事实源）：`env-retry` \| `dep-wait` \| `design-human` |
| `harvestSource` | string? | – | harvest 转生血缘锚（源任务 id+块序号），正则 `^harvest:P-\d{8}-\d+#\d+$`；harvest 程序生成并以此幂等去重（open+归档全扫） |
| `triage` | enum? | – | 受阻分诊结论，fold blocked 分支回填（唯一写入者=程序）：`env-retry` \| `dep-wait` \| `design-human`；env-retry 可 `dispatch --retry <id>` 原子重派（attempts<上限），其余两档只转人 |
| `harvestSource` | string? | – | harvest 转生血缘锚 `harvest:<id>#<n>`（harvest 程序回填，幂等判重依据） |

## 校验规则（格式门禁）

1. 未知字段拒绝（ADR-0022 严格校验教训）；2. 枚举/正则如上；3. status 流转只允许下述转移表（非法跳转拒绝——**实现正典**，v1.0.13 落档）；4. `priority=highest ∧ source.type≠human` → 拒绝；5. direction 含 `exclusive-human: true` 且调用源非 human → 拒绝（**validate-task 程序**机械防线）。

### 转移表（规则 3 的显式形态）

```
pending  → approved | rejected | stale
approved → running | rejected | stale
running  → done | blocked | stale | approved   # approved = interrupted 重派回炉
blocked  → approved | stale | rejected         # approved = 回炉重派（人工/修复后）
done     → blocked                             # 合并复验失败 ejected 回炉
stale    → approved                            # 人工 reopen
rejected → approved                            # 人工 reopen
```

设计注：done→blocked 仅为合并队列 ejected 保留（复验失败/出口扫描命中回炉）；done 的常规去向是归档（月分卷），归档不改 status。
