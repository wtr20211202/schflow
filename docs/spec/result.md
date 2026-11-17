# Spec · 执行器产物 result.json（v1，两形态共用正典）

> 不可再精简清单④的本体：executor 每次尝试在 `runs/<n>/result.json` 落此结构；折叠程序与 L3 poll 契约都消费它。

## 字段表

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `status` | enum | ✓ | `done` \| `blocked` \| `stale` \| `dirty`（四态封闭；dirty=工作树有非预期未提交改动） |
| `summary` | string | ✓ | 一句话实施摘要（进提交信息/board） |
| `commit` | string? | done 时 ✓ | 提交哈希（幂等重入：重派发现已有则原样返回，ADR-0023） |
| `deliverables` | object[] | – | 非代码交付物路径（investigate/research/docs） |
| `flags` | object | – | 可选标志位（如 `linuxPending: true`——门禁排队后置，ADR-0018⑦/0020⑦ 先例族） |
| `freshness` | enum? | – | 时效三岔结论 `valid` \| `adapted` \| `stale`（stale 时 status 必为 stale，ADR-0006） |
| `specs` | string[] | – | 建议复验的定向用例（合并闸组装输入） |

## 与 poll 五态的映射

L3 delegate 的 `{running, done, blocked, stale, dirty}` 中，除 `running`（委托工作流长驻语义占位）外，`done/blocked/stale/dirty` 四态直通本契约——引擎折叠程序对内只消费本契约四态，对外（board/timeline）补 `running` 展示态。

## 校验

schema 严格校验（未知字段拒绝）；解析失败 = 该次尝试折叠为 interrupted，attempts+1 重派（附前次 runs/ 引用，契约底线④）。

**原子写要求（v1.0.13 落档）**：result.json 必须 tmp+rename 原子写——折叠程序与观测面并发读取，半行 JSON 视同解析失败。git 轨道任务的提交信息带 `(<id>)` 尾注（幂等重入的 grep 锚，ADR-0023）。
