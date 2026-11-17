# schflow-dsh-plugin

dsh 宿主接入插件（bundle 形态）：让 schflow 的四个 skill（proposer / orchestrator / executor / improve）出现在 dsh 会话的技能目录里，会话内的 agent 据此操作用户的 schflow 流水线（`node core/programs/*.mjs` 动词面）。

## 原理

dsh 的 profile 是「plugin-bundle 补丁层的有序堆叠」。本包声明 `dsh.bundle.patch: ./cordis.patch.yml`，其补丁只做一件事——给内置的 `skill-filesystem`（本地技能供给器，读 `<name>/SKILL.md`，与 schflow skills 同格式）追加技能根：

```yaml
- id: skill-filesystem
  config:
    includeDefaultRoots: true
    customSkillDirs: !!js 'process.env.SCHFLOW_SKILLS_DIR ? [process.env.SCHFLOW_SKILLS_DIR] : [process.env.HOME + "/.schflow/skills"]'
    watch: true
```

技能根解析（首中者胜）：`SCHFLOW_SKILLS_DIR` → `~/.schflow/skills`（用户层约定，`schflow setup` 会把 skills 放这里）。

## 安装（实测流程，2026-11-17 dsh 0.2.2-rc.1）

```bash
# 1. 派生一个专用 profile（或直接装进现有 profile）
dsh --profile schflow --from-default-profile headless --dump-config >/dev/null

# 2. 装插件（pnpm file: 依赖；dsh 会自动把包名挂进 dsh.profile.bundles）
dsh plugin --profile schflow add file:/path/to/schflow/hosts/dsh/plugin

# 3. 指向技能根并验证（SESSION 里问「列出你的技能」应出现 schflow-*）
export SCHFLOW_SKILLS_DIR=/path/to/schflow/skills
dsh --profile schflow "列出你的技能"
```

## 包内容与同步纪律

- `skills/` 是仓库正典 `skills/` 的逐字节拷贝（发布产物）；改正典后跑
  `rsync -a skills/{proposer,orchestrator,executor,improve} hosts/dsh/plugin/skills/`；
- 漂移由 CI 单测 `core/test/unit/dsh-plugin-sync.test.mjs` 拦截（逐字节比对）。

## 边界

本插件管「宿主会话 → schflow」（操作面）。**执行器雇佣面**（schflow 派活给 dsh）走 headless CLI 契约，不经插件——见 `../launcher/` 与 `../README.md`。
