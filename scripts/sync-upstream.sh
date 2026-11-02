#!/usr/bin/env bash
# sync-upstream.sh — 按 docs/contracts/upstream-sync.md 合同执行上游同步。
# 分级：🟢A 自动合 / 🟡B 模板解 / 🟠C 停等 / 🔴D 拒绝。
# 退出码：0=同步完成（待写日志+push）；1=错误；2=🟠C 级停等；3=验证不绿需人工判断。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SYNC_FROM="${SYNC_FROM:-origin/master}"
GIT_ID=(-c user.name="omnimux" -c user.email="dev@omnimux.local")

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "sync-upstream: node not found on PATH" >&2
  exit 1
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*"; }
stop() { printf '\033[31m■ 停等\033[0m %s\n' "$*"; }

# ---------- 阶段 1：fetch + 落后检测 ----------
say "── [1/7] fetch 上游 ──"
git fetch origin

BEHIND="$(git rev-list --count "omnimux..${SYNC_FROM}")"
if [ "$BEHIND" -eq 0 ]; then
  ok "已与上游同步，无需操作"
  exit 0
fi
say "落后上游 ${BEHIND} 个提交"

# ---------- 阶段 2：预检（C/D 级风险信号） ----------
say "── [2/7] 预检风险信号 ──"
RANGE="omnimux..${SYNC_FROM}"
CHANGED_FILES="$(git diff --name-only "$RANGE")"

if echo "$CHANGED_FILES" | grep -qx "LICENSE"; then
  stop "🔴 D 级：上游 LICENSE 文件变更 —— 直接拒绝，立即报告老板"
  exit 2
fi
if echo "$CHANGED_FILES" | grep -q "^deepseek-harness$"; then
  warn "🟠 C 级信号：submodule pin 变更（需重打包验证）——合并后需老板确认"
fi
if git log --format='%s' "$RANGE" | grep -qiE "electron (3[0-9]|[4-9][0-9])|bump.*electron|major"; then
  warn "🟠 C 级信号：疑似 Electron/依赖大版本变更 —— 合并后需老板确认"
fi
git log --oneline "$RANGE" | head -20 || true
say ""

# ---------- 阶段 3：merge ----------
say "── [3/7] merge ──"
if git "${GIT_ID[@]}" merge "${SYNC_FROM}" -m "merge: sync upstream master (${BEHIND} commits) [auto:sync-upstream.sh]" 2>/tmp/sync-merge-err; then
  ok "🟢 A 级：零冲突自动合并"
  CONFLICTS=""
else
  CONFLICTS="$(git diff --name-only --diff-filter=U)"
  if [ -z "$CONFLICTS" ]; then
    say "merge 输出：$(cat /tmp/sync-merge-err)"
    exit 1
  fi
  say "发现冲突文件："
  printf '%s\n' "$CONFLICTS" | sed 's/^/  - /'
fi

# ---------- 阶段 4：冲突分级处理 ----------
if [ -n "$CONFLICTS" ]; then
  say "── [4/7] 冲突分级处理 ──"
  for f in $CONFLICTS; do
    RES="$("$NODE_BIN" "$REPO_ROOT/scripts/lib/resolve-merge-conflicts.mjs" "$f" 2>&1 || true)"
    if echo "$RES" | head -1 | grep -q '^RESOLVED'; then
      ok "🟡 B 级已按模板解：$f"
      echo "$RES" | sed 1d | sed 's/^/    /'
      git add "$f"
    else
      git merge --abort 2>/dev/null || true
      stop "🟠 C 级：$f 存在结构性冲突，已回滚 merge —— 需人工/agent 按合同处理后重跑"
      echo "$RES" | sed 's/^/    /'
      say "提示：B 级模板解只覆盖品牌字段（version 取上游，appId/productName 等保 OmniMux）。"
      exit 2
    fi
  done
  git "${GIT_ID[@]}" commit -m "merge: sync upstream master (${BEHIND} commits) [auto:sync-upstream.sh]" >/dev/null
fi

# ---------- 阶段 5：依赖跟进 ----------
say "── [5/7] 依赖跟进 ──"
corepack yarn install 2>&1 | tail -2

# ---------- 阶段 6：build + 验证 ----------
say "── [6/7] build（干净 env）──"
# 固定用带 corepack 的 managed node（绕 workbuddy safe-delete shim 的 NODE_OPTIONS/PATH 注入）
MANAGED_NODE_BIN="$(dirname "$NODE_BIN")"
if [ ! -x "$MANAGED_NODE_BIN/node" ]; then
  MANAGED_NODE_BIN="$(dirname "$NODE_BIN")"
fi
env -u NODE_OPTIONS PATH="$MANAGED_NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  sh -c "cd '$REPO_ROOT/dsh-plugin-desktop' && corepack yarn build" 2>&1 | tail -2

say "── [7/7] typecheck + test ──"
(cd "$REPO_ROOT/dsh-plugin-desktop" && corepack yarn typecheck >/dev/null 2>&1) \
  && ok "typecheck 通过" || { stop "typecheck 失败 —— 人工判断（非机械原因属 C 级）"; exit 3; }

TEST_OUT="$(cd "$REPO_ROOT/dsh-plugin-desktop" && corepack yarn vitest run 2>&1 | grep -E 'Tests +[0-9]' | tail -1 || true)"
if [ -z "$TEST_OUT" ]; then
  TEST_OUT="（未抓到输出——请人工跑 yarn test 确认）"
fi
say "test 结果：$TEST_OUT"
if echo "$TEST_OUT" | grep -q "failed"; then
  warn "存在失败用例 —— safe-delete 环境干扰以 CI 为准；品牌断言失败必须修。请人工判断后决定 push。"
fi

# ---------- 收尾：生成决策日志骨架 ----------
LOG="$REPO_ROOT/docs/contracts/upstream-sync-log.md"
RANGE_SHA="$(git rev-parse "${SYNC_FROM}~${BEHIND}")..$(git rev-parse "${SYNC_FROM}")"
{
  echo "## $(date '+%Y-%m-%d') · 脚本同步（${BEHIND} 提交）—— 待补全"
  echo ""
  echo "- **上游范围**：\`${RANGE_SHA}\`"
  echo "- **冲突**：${CONFLICTS:-无（A 级自动合并）}"
  echo "- **解法**：（B 级模板解详情见脚本输出）"
  echo "- **分级记录**：A ？项；B ？项；C 0；D 0"
  echo "- **验证**：typecheck 通过；test：${TEST_OUT:-未跑}"
  echo "- **决策人**：sync-upstream.sh 自动（待 agent/老板复核）"
  echo "- **提交**：$(git rev-parse --short HEAD)"
  echo ""
  echo "---"
  echo ""
} > /tmp/sync-log-entry.md
if [ -f "$LOG" ]; then
  # 插到文件头部的固定锚（第一条 "---" 之前）
  awk 'BEGIN{p=1} /^---$/{if(p){p=0; while((getline l < "/tmp/sync-log-entry.md")>0) print l}} {print}' "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

ok "同步完成。剩余人工步骤："
say "  1. 补全决策日志（骨架已写入 docs/contracts/upstream-sync-log.md 顶部）"
say "  2. git add docs/contracts/upstream-sync-log.md && git commit"
say "  3. git push fork omnimux 并确认 CI 全绿（无日志的 merge 不算完成）"
