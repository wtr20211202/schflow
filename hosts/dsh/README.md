# hosts/dsh

dsh（DeepSeek Harness）接入包。**两个面分开**（与 design §9「执行器两家族」同构）：

| 面 | 机制 | 本目录资产 |
|---|---|---|
| **插件面**（dsh 会话 → schflow）：会话里的 agent 会操作你的流水线 | **原生 dsh 插件**（bundle 包 + profile 补丁层；dsh 官方扩展点） | `plugin/`（已验证安装） |
| **雇佣面**（schflow → dsh）：流水线派活给 dsh 执行器 | headless CLI 契约（`dsh --profile headless -`） | `launcher/`（Windows+WSL 桥）、`profile/`（cron 模板） |

## 插件面（主路线，2026-11-17 实测）

`plugin/` 是标准 bundle 包：`package.json` 声明 `dsh.bundle.patch`，补丁给内置 `skill-filesystem` 追加技能根——**dsh 的 SKILL.md 技能供给器与 schflow skills 同格式（Agent Skills 开放标准）**，所以四个 skill 原样进入会话技能目录。安装三步与验证命令见 [plugin/README.md](plugin/README.md)：

```bash
dsh --profile schflow --from-default-profile headless --dump-config >/dev/null
dsh plugin --profile schflow add file:/path/to/schflow/hosts/dsh/plugin
export SCHFLOW_SKILLS_DIR=/path/to/schflow/skills   # 或让 schflow setup 落 ~/.schflow/skills
dsh --profile schflow "列出你的技能"                  # 应出现 schflow-{proposer,orchestrator,executor,improve}
```

实测记录：`--dump-config` 组合树可见 `skill-filesystem.customSkillDirs` 来自插件补丁（`!!js` 表达式）；headless 冒烟四个 skill 名全中。

## 雇佣面（执行器启动）

- **POSIX 原生**：`runner: dsh`（core 内置）——`dsh --profile headless -`，任务书走 stdin（0.2.2 实证 `-` 读 stdin）；
- **Windows 宿主 + WSL 内 dsh**：`runner: custom` + argv 数组形态（零 shell，跨平台纪律）：

```yaml
runner: custom
runner-cmd: ["node", "<schflow>/hosts/dsh/launcher/wsl-dsh.mjs", "{book}"]
```

`launcher/wsl-dsh.mjs` 做三件事：Windows 路径 → `/mnt` 形态、从 dsh 凭据文件注入 `DEEPSEEK_API_KEY`（不影响引擎零凭据纪律——key 只在宿主包脚本内流转）、heredoc 喂任务书给 dsh stdin。

## 能力矩阵（P0 → P0.5 复验，0.2.2-rc.1）

| 能力 | 实测 |
|---|---|
| headless | ✅ `--profile headless`（answer→stdout、诊断→stderr；`-` 读 stdin） |
| 模型往返 | ✅ pong 全绿；凭据必须**启动环境注入**（web Models 页写入的 refs 形态不被 headless route 消费——实测 MISSING_CREDENTIAL） |
| 会话续跑 | ✅ `--session-id <id>`（headless 挂持久会话；记词复问实测通过——0.1.5「无 resume」旧结论已推翻） |
| 结构化输出 | ⚠️ `--json` = 逐行 run 事件（session/status/thinking/text/usage），非 final-message JSON——result 契约仍以任务书落盘为准 |
| 插件系统 | ✅ bundle 包（`dsh.bundle.patch`）+ profile 补丁层 + `dsh plugin add`（pnpm 制，自动挂 bundles） |
| 工具能力 | ✅ 文件/命令工具可用（实测建文件）——可作真执行器 |
| 已知限制 | dsh `workspace-write` 沙箱拒写 worktree 外的仓库 `.git` 元数据 → commit 由宿主代收（Cycle D 实录）；worktree 布局改进方向见 design §15 |

## cron 形态

`profile/headless-tick.md`（系统 cron 拉起 headless 逐 tick 的任务文本，含 key 注入两形态与 429 配额墙韧性注记）。

## 双安装注记（WSL）

`npm i -g` 装的新版在 npm prefix（`/usr/bin/dsh`）；历史手动安装的旧件可能占 `/usr/local/bin/dsh`（PATH 优先）——用绝对路径或清掉旧件。

## 沙箱授权（git 轨道任务，v1.0.15）

dsh `workspace-write` 默认只允许写会话 cwd（worktree）；worktree 的 `.git` 文件指向 `<repo>/.git/worktrees/<id>`（工作区之外）→ commit 被拒。官方推荐形态是显式授权：

```
dsh --profile headless --permission-mode workspace-write --add-dir <repo>/.git -
```

core 内置 `runner: dsh` 对 git 轨道任务已自动追加这两组参数；`hosts/dsh/launcher/wsl-dsh.mjs` 经 `SCHFLOW_REPO` 同款处理。**worktree 创建仍归引擎**：dsh rc.3 的 `dsh-experimental-worktree` 是会话级探索式 checkout（随会话归档清理、无 (repo,base) 队列），与本引擎任务级 worktree 职责不重叠、默认不挂载；执行器红线另禁止新建 worktree。

## 分发（官方插件机制）

本目录 `plugin/` 是标准 bundle 包，安装即官方机制（pnpm 依赖解析）：

```bash
# 从本 GitHub 仓库直接安装（公开仓匿名可读，真机验证 ✅ 2026-11-18）
dsh plugin --profile schflow add "github:wtr20211202/schflow#path:hosts/dsh/plugin"
# 开发期本地路径亦可用
dsh plugin --profile schflow add file:/path/to/schflow/hosts/dsh/plugin
```

skills 内嵌拷贝与仓库正典逐字节一致，CI 守卫（`core/test/unit/dsh-plugin-sync.test.mjs`）。

## GUI（web 控制台）驱动注记（主流使用面）

dsh 的主流使用方式是 GUI（`dsh web`，浏览器控制台）。在此驱动 schflow 时：

- **orchestrator/proposer 技能在 GUI 会话中同样可用**（装插件进 `schflow` profile 后按名调用；web 会话的技能目录同源）；
- **worktree 工具共存**：GUI 启用 forge 后 `create_worktree` 在场——那是会话级探索 checkout（`.agents/worktrees/`，随会话归档清理），与引擎 worktree（`<repo 父>/.schflow-worktrees/`）物理分离；执行器红线禁建新 worktree，引擎的版本隔离不被触碰。想彻底隔离可在自有 profile patch 里 disable `tool-worktree`；
- **沙箱写面**：GUI 会话默认 `workspace-write` 限定 cwd——原生家族执行器要写引擎 worktree（cwd 之外），需在会话/工作区设置里把 worktree 目录加入可写区（等价 headless 的 `--add-dir`）。
