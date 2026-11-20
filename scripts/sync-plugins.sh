#!/bin/bash
# sync-plugins.sh —— 宿主插件镜像生成器（分发自足：插件装完即用，引擎 + 内置 yaml 随包走）。
#
# 正典 = 仓库根的 skills/ 与 core/{lib,programs,vendor}；镜像 = 各宿主插件包内的同名子树：
#   hosts/claude-code/   (claude code 官方插件形态，marketplace source)
#   hosts/dsh/plugin/    (dsh bundle 包，package.json files 声明 core)
#
# 纪律：镜像内容只允许「正典的逐字节拷贝」——先 rm -rf 再 cp -a，重复执行结果一致（幂等）；
# 漂移由 core/test/unit/{claude,dsh}-plugin-sync.test.mjs 递归逐字节守卫拦截。
#
# 用法：bash scripts/sync-plugins.sh
#   改正典 skills/ 或 core/ 后必跑；输出每个宿主的同步清单（路径 + 文件数）。

set -euo pipefail
cd "$(dirname "$0")/.."

HOSTS=(hosts/claude-code hosts/dsh/plugin)
SYNC_SUBTREES=(skills core/lib core/programs core/vendor)

count_files() {
  find "$1" -type f | wc -l | tr -d ' '
}

for host in "${HOSTS[@]}"; do
  [ -d "$host" ] || { echo "FATAL: 宿主目录不存在：$host" >&2; exit 1; }
  rm -rf "$host/skills" "$host/core"
  mkdir -p "$host/core"
  cp -a skills "$host/skills"
  cp -a core/lib "$host/core/lib"
  cp -a core/programs "$host/core/programs"
  cp -a core/vendor "$host/core/vendor"

  echo "==> $host"
  for g in "${SYNC_SUBTREES[@]}"; do
    printf '    %-16s %3s files\n' "$g" "$(count_files "$host/$g")"
  done
done

echo "==> 同步完成：${#HOSTS[@]} 个宿主 × (${SYNC_SUBTREES[*]})（正典 → 镜像，逐字节）"
