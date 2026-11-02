#!/usr/bin/env bash
# worktree.sh — Git worktree lifecycle management tool for omnimux-desktop-fork.
#
# Implements standardized worktree contracts:
#   1. Primary checkout stays clean on default branch (omnimux/main/master).
#   2. Task work lives strictly in <repo>/.worktrees/<task>.
#   3. Worktrees MUST be removed after merge or abandon; no orphaned dirs.
#   4. Worktrees MUST NOT be created as repository siblings or long-lived in /tmp.
#   5. Task naming strictly conforms to ASCII kebab-case (^[a-z0-9][a-z0-9-]*$).
#
# Usage:
#   worktree.sh init                        initialize .worktrees/ and .gitignore in current repo
#   worktree.sh new <task> [base] [--type feat|fix|chore|agent]
#                                           create .worktrees/<task> on <type>/<task>
#   worktree.sh list                        list all worktrees and dirty status
#   worktree.sh ship <task>                 finish: verify -> push branch -> sync primary ->
#                                           merge -> push primary -> remove worktree + branch
#   worktree.sh remove <task> [--discard]   remove worktree; --discard drops uncommitted changes,
#                        [--abandon]        --abandon drops an unmerged branch
#   worktree.sh prune                       drop stale registrations; report merged branches
#   worktree.sh clean                       one-shot sweep: remove worktrees + branches
#                                           merged into default branch (skips dirty/unmerged)
#   worktree.sh help
#
# Environment Overrides:
#   WORKTREE_REMOTE          explicit remote (default: detected 'fork' or 'origin')
#   WORKTREE_DEFAULT_BRANCH  explicit baseline branch (default: detected 'omnimux', 'main', or 'master')

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${ROOT}" ]; then
  echo "worktree.sh: not inside a git work tree" >&2
  exit 2
fi

WT_DIR="${ROOT}/.worktrees"
TASK_RE='^[a-z0-9][a-z0-9-]*$'

die() { echo "worktree.sh: $*" >&2; exit 1; }
say() { echo "==> $*"; }

# -----------------------------------------------------------------------------
# Remote & Branch Detection
# -----------------------------------------------------------------------------

detect_remote() {
  if [ -n "${WORKTREE_REMOTE:-}" ]; then
    echo "${WORKTREE_REMOTE}"
    return 0
  fi
  # Priority: fork remote for omnimux development, then origin
  if git remote 2>/dev/null | grep -qx "fork"; then
    echo "fork"
    return 0
  fi
  if git remote 2>/dev/null | grep -qx "origin"; then
    echo "origin"
    return 0
  fi
  local first_remote
  first_remote="$(git remote 2>/dev/null | head -n 1 || true)"
  if [ -n "${first_remote}" ]; then
    echo "${first_remote}"
    return 0
  fi
  echo "fork"
}

REMOTE="$(detect_remote)"

detect_default_branch() {
  # 1. Explicit override via environment variable
  if [ -n "${WORKTREE_DEFAULT_BRANCH:-}" ]; then
    echo "${WORKTREE_DEFAULT_BRANCH}"
    return 0
  fi

  # 2. Check current checkout branch of ROOT
  local current_branch
  current_branch="$(git -C "${ROOT}" symbolic-ref --short HEAD 2>/dev/null || true)"
  if [ "${current_branch}" = "omnimux" ]; then
    echo "omnimux"
    return 0
  fi

  # 3. Check if local omnimux branch exists
  if git show-ref --verify --quiet "refs/heads/omnimux"; then
    echo "omnimux"
    return 0
  fi

  # 4. Check if refs/remotes/fork/HEAD or refs/remotes/<remote>/HEAD points to omnimux
  local fork_head
  fork_head="$(git symbolic-ref --short refs/remotes/fork/HEAD 2>/dev/null || true)"
  if [ "${fork_head#fork/}" = "omnimux" ]; then
    echo "omnimux"
    return 0
  fi
  local remote_head
  remote_head="$(git symbolic-ref --short "refs/remotes/${REMOTE}/HEAD" 2>/dev/null || true)"
  if [ "${remote_head#"${REMOTE}/"}" = "omnimux" ]; then
    echo "omnimux"
    return 0
  fi

  # 5. Check remote omnimux refs
  if git show-ref --verify --quiet "refs/remotes/fork/omnimux" || \
     git show-ref --verify --quiet "refs/remotes/${REMOTE}/omnimux"; then
    echo "omnimux"
    return 0
  fi

  # 6. Secondary fallback: main
  if [ "${current_branch}" = "main" ] || \
     git show-ref --verify --quiet "refs/heads/main" || \
     [ "${remote_head#"${REMOTE}/"}" = "main" ] || \
     git show-ref --verify --quiet "refs/remotes/${REMOTE}/main" || \
     git show-ref --verify --quiet "refs/remotes/origin/main"; then
    echo "main"
    return 0
  fi

  # 7. Tertiary fallback: master
  if [ "${current_branch}" = "master" ] || \
     git show-ref --verify --quiet "refs/heads/master" || \
     [ "${remote_head#"${REMOTE}/"}" = "master" ] || \
     git show-ref --verify --quiet "refs/remotes/${REMOTE}/master" || \
     git show-ref --verify --quiet "refs/remotes/origin/master"; then
    echo "master"
    return 0
  fi

  echo "omnimux"
}

DEFAULT_BRANCH="$(detect_default_branch)"

# -----------------------------------------------------------------------------
# Input Validation
# -----------------------------------------------------------------------------

validate_task() {
  local task="$1"
  if [ -z "${task}" ]; then
    die "missing <task> (kebab-case, e.g. fix-node-runtime)"
  fi
  case "${task}" in
    main | master | omnimux | origin | fork | upstream | "${REMOTE}" | feat | fix | chore | agent | codex | merge | .git | .worktrees)
      die "reserved name: ${task}" ;;
  esac
  if ! printf '%s' "${task}" | grep -Eq "${TASK_RE}"; then
    die "task must be ASCII kebab-case (^[a-z0-9][a-z0-9-]*$): ${task}"
  fi
  if [ "${#task}" -gt 60 ]; then
    die "task too long (max 60 chars): ${task}"
  fi
}

# -----------------------------------------------------------------------------
# Commands
# -----------------------------------------------------------------------------

cmd_init() {
  say "initializing worktree infrastructure in ${ROOT}"
  mkdir -p "${WT_DIR}"
  local gi="${ROOT}/.gitignore"
  local git_common_dir
  git_common_dir="$(git rev-parse --git-common-dir 2>/dev/null || echo "${ROOT}/.git")"
  case "${git_common_dir}" in
    /*) ;;
    *) git_common_dir="${ROOT}/${git_common_dir}" ;;
  esac
  local exclude="${git_common_dir}/info/exclude"

  if [ -f "${exclude}" ] && grep -q "^\.worktrees/\{0,1\}$" "${exclude}" 2>/dev/null; then
    say ".git/info/exclude already ignores .worktrees/ (clean primary)"
  elif [ ! -f "${gi}" ]; then
    echo ".worktrees/" > "${gi}"
    say "created .gitignore with .worktrees/"
  elif ! grep -q "^\.worktrees/\{0,1\}$" "${gi}" 2>/dev/null; then
    printf '\n# Git worktrees isolation directory\n.worktrees/\n' >> "${gi}"
    say "appended .worktrees/ to .gitignore"
  else
    say ".gitignore already ignores .worktrees/"
  fi

  # Defensive: ensure node_modules (symlinks & directories) is ignored in .git/info/exclude
  if [ -f "${exclude}" ]; then
    if ! grep -q "^node_modules/\{0,1\}$" "${exclude}" 2>/dev/null; then
      printf '\n# Ignore node_modules directory and symlinks\nnode_modules\n' >> "${exclude}"
      say "appended node_modules to .git/info/exclude"
    else
      say ".git/info/exclude already ignores node_modules"
    fi
  else
    mkdir -p "$(dirname "${exclude}")"
    printf '# Ignore node_modules directory and symlinks\nnode_modules\n' > "${exclude}"
    say "created .git/info/exclude with node_modules"
  fi
  echo "Done. Default remote: ${REMOTE}, default branch: ${DEFAULT_BRANCH}"
}

print_wt() {
  local wt="$1" branch="$2" rel dirty
  case "${wt}" in
    "${ROOT}") rel="(primary)" ;;
    "${ROOT}"/*) rel="${wt#${ROOT}/}" ;;
    *) rel="${wt}" ;;
  esac
  if [ -d "${wt}" ]; then
    dirty="$(git -C "${wt}" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  else
    dirty="missing"
  fi
  printf '  %-50s %-32s dirty:%s\n' "${rel}" "${branch}" "${dirty}"
}

cmd_new() {
  local task="" base="" btype="feat"
  
  while [ $# -gt 0 ]; do
    case "$1" in
      --type)
        shift
        [ $# -gt 0 ] || die "missing argument for --type (feat|fix|chore|agent)"
        btype="$1"
        ;;
      *)
        if [ -z "${task}" ]; then
          task="$1"
        else
          base="$1"
        fi
        ;;
    esac
    shift
  done

  validate_task "${task}"

  if ! printf '%s' "${btype}" | grep -Eq '^[a-z0-9_-]+$'; then
    die "invalid branch type: ${btype} (alphanumeric, underscores and hyphens only)"
  fi

  if [ -z "${base}" ]; then
    base="${REMOTE}/${DEFAULT_BRANCH}"
  fi

  local branch="${btype}/${task}"
  local wt="${WT_DIR}/${task}"

  [ -e "${wt}" ] && die "worktree already exists: ${wt#${ROOT}/}"
  if git show-ref --verify --quiet "refs/heads/${branch}"; then
    die "branch already exists: ${branch}"
  fi

  # Auto ensure .worktrees exists and is ignored
  if [ ! -d "${WT_DIR}" ] || ! grep -q "^\.worktrees/\{0,1\}$" "${ROOT}/.gitignore" 2>/dev/null; then
    cmd_init >/dev/null 2>&1 || true
  fi

  say "fetch ${REMOTE} (refresh tracking refs)"
  git fetch "${REMOTE}" --prune 2>/dev/null || say "warning: git fetch ${REMOTE} failed, using local refs"

  if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; then
    if git rev-parse --verify --quiet "${DEFAULT_BRANCH}^{commit}" >/dev/null 2>&1; then
      say "base ref '${base}' not found, falling back to local '${DEFAULT_BRANCH}'"
      base="${DEFAULT_BRANCH}"
    else
      die "unknown base ref: ${base}"
    fi
  fi

  say "git worktree add -b ${branch} .worktrees/${task} ${base}"
  git worktree add -b "${branch}" "${wt}" "${base}" || die "git worktree add failed"

  echo "    path:   ${wt#${ROOT}/}"
  echo "    branch: ${branch}"
  echo "    base:   ${base}"
  echo "    next:   cd ${wt#${ROOT}/}   # implement and commit"
  echo "            worktree.sh ship ${task}"
}

cmd_list() {
  echo "worktrees in ${ROOT} (contract: <repo>/.worktrees/<task>):"
  echo
  local wt="" branch=""
  while IFS= read -r line; do
    case "${line}" in
      worktree*)
        if [ -n "${wt}" ]; then print_wt "${wt}" "${branch}"; fi
        wt="${line#worktree }"
        branch=""
        ;;
      branch*)
        branch="${line#branch refs/heads/}"
        ;;
      detached)
        branch="(detached)"
        ;;
    esac
  done < <(git worktree list --porcelain)
  if [ -n "${wt}" ]; then print_wt "${wt}" "${branch}"; fi
}

cmd_ship() {
  local task="$1"
  validate_task "${task}"

  local wt="${WT_DIR}/${task}"
  [ -d "${wt}" ] || die "no worktree found for task: ${task} (expected ${wt#${ROOT}/})"

  local branch
  branch="$(git -C "${wt}" symbolic-ref --short HEAD 2>/dev/null || true)"
  [ -n "${branch}" ] || die "worktree is in detached HEAD state; cannot ship automatically"

  if [ -n "$(git -C "${wt}" status --porcelain 2>/dev/null)" ]; then
    die "worktree ${wt#${ROOT}/} has uncommitted changes; commit or stash them first"
  fi

  # Primary checkout must be clean and on default branch
  local primary_branch
  primary_branch="$(git -C "${ROOT}" symbolic-ref --short HEAD 2>/dev/null || true)"
  if [ "${primary_branch}" != "${DEFAULT_BRANCH}" ]; then
    die "primary checkout is not on default branch (${DEFAULT_BRANCH}); got: ${primary_branch}"
  fi
  if [ -n "$(git -C "${ROOT}" diff --name-only)" ] || [ -n "$(git -C "${ROOT}" diff --cached --name-only)" ]; then
    die "primary checkout has tracked uncommitted changes; stash them before shipping"
  fi

  say "fetch ${REMOTE}"
  git fetch "${REMOTE}" --prune 2>/dev/null || true

  say "push ${branch} to ${REMOTE}"
  git -C "${wt}" push "${REMOTE}" "${branch}" 2>/dev/null || say "note: push branch upstream skipped or failed (offline / no remote write)"

  say "sync primary ${DEFAULT_BRANCH} with ${REMOTE}"
  git -C "${ROOT}" pull --ff-only "${REMOTE}" "${DEFAULT_BRANCH}" 2>/dev/null || true

  say "merge ${branch} into ${DEFAULT_BRANCH}"
  if ! git -C "${ROOT}" merge --ff-only "${branch}" 2>/dev/null; then
    git -C "${ROOT}" merge -m "merge: ${branch}" --no-ff "${branch}" || die "merge failed; resolve in primary checkout"
  fi

  say "push ${REMOTE} ${DEFAULT_BRANCH}"
  git -C "${ROOT}" push "${REMOTE}" "${DEFAULT_BRANCH}" 2>/dev/null || say "note: push ${DEFAULT_BRANCH} skipped or failed (offline / no remote write / protected branch)"

  say "remove worktree + branch"
  git worktree remove "${wt}" || die "git worktree remove failed; run 'worktree.sh prune'"
  if ! git branch -d "${branch}" 2>/dev/null; then
    echo "    note: branch ${branch} retained (force delete with: git branch -D ${branch})" >&2
  fi
  git worktree prune

  say "done: ${branch} merged and worktree cleaned up"
}

cmd_remove() {
  local task="$1"
  shift || true
  local wt="${WT_DIR}/${task}"
  local discard=0 abandon=0 flags=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --discard) discard=1 ;;
      --abandon) abandon=1 ;;
      *) die "unknown flag: $1 (use --discard to drop uncommitted changes, --abandon for unmerged branch)" ;;
    esac
    shift
  done

  validate_task "${task}"
  [ -d "${wt}" ] || die "no worktree found for task: ${task} (expected ${wt#${ROOT}/})"

  local branch
  branch="$(git -C "${wt}" symbolic-ref --short HEAD 2>/dev/null || true)"

  if [ -n "$(git -C "${wt}" status --porcelain 2>/dev/null)" ]; then
    if [ "${discard}" -eq 1 ]; then
      say "discarding uncommitted changes in ${wt#${ROOT}/}"
    else
      die "worktree ${wt#${ROOT}/} has uncommitted changes; use --discard to force remove"
    fi
  fi

  # Check if merged
  git fetch "${REMOTE}" --prune 2>/dev/null || true
  local merged=""
  if [ -n "${branch}" ]; then
    merged="$(git for-each-ref --merged="${REMOTE}/${DEFAULT_BRANCH}" --format='%(refname:short)' refs/heads 2>/dev/null | grep -x "${branch}" || true)"
    if [ -z "${merged}" ] && git rev-parse --verify --quiet "${DEFAULT_BRANCH}" >/dev/null 2>&1; then
      merged="$(git for-each-ref --merged="${DEFAULT_BRANCH}" --format='%(refname:short)' refs/heads 2>/dev/null | grep -x "${branch}" || true)"
    fi
    if [ -z "${merged}" ]; then
      if [ "${abandon}" -eq 1 ]; then
        say "branch ${branch} is not merged; removing as abandoned"
      else
        die "branch ${branch} is not merged into ${DEFAULT_BRANCH}; use --abandon to drop, or 'ship' it"
      fi
    fi
  fi

  [ "${discard}" -eq 1 ] && flags="--force"
  say "git worktree remove ${flags} .worktrees/${task}"
  git worktree remove ${flags} "${wt}" || die "git worktree remove failed"

  if [ -n "${branch}" ] && git show-ref --verify --quiet "refs/heads/${branch}"; then
    if [ "${abandon}" -eq 1 ]; then
      git branch -D "${branch}" 2>/dev/null || true
    else
      git branch -d "${branch}" 2>/dev/null || echo "    note: branch ${branch} kept" >&2
    fi
  fi
  git worktree prune
  say "done: .worktrees/${task} removed"
}

cmd_prune() {
  say "git worktree prune"
  git worktree prune
  echo
  echo "local branches merged into ${DEFAULT_BRANCH} (safe to delete):"
  if git rev-parse --verify --quiet "${DEFAULT_BRANCH}" >/dev/null 2>&1; then
    git for-each-ref --merged="${DEFAULT_BRANCH}" --format='%(refname:short)' \
      refs/heads/feat refs/heads/fix refs/heads/chore refs/heads/agent refs/heads/codex 2>/dev/null \
      | sed 's/^/  - /' || echo "  (none)"
  fi
  echo
  echo "active worktrees:"
  git worktree list
}

cmd_clean() {
  local removed=0 skipped=0 orphans=0
  local merged="" wt="" branch="" registered=""

  say "fetch ${REMOTE} (sweep against latest default branch: ${DEFAULT_BRANCH})"
  git fetch "${REMOTE}" --prune 2>/dev/null || true

  if git rev-parse --verify --quiet "${REMOTE}/${DEFAULT_BRANCH}" >/dev/null 2>&1; then
    merged="$(git for-each-ref --merged="${REMOTE}/${DEFAULT_BRANCH}" --format='%(refname:short)' refs/heads)"
  elif git rev-parse --verify --quiet "${DEFAULT_BRANCH}" >/dev/null 2>&1; then
    merged="$(git for-each-ref --merged="${DEFAULT_BRANCH}" --format='%(refname:short)' refs/heads)"
  else
    die "cannot resolve default branch: ${DEFAULT_BRANCH}"
  fi

  while IFS= read -r line; do
    case "${line}" in
      worktree*)
        if [ -n "${wt}" ]; then clean_one "${wt}" "${branch}" "${merged}" || true; fi
        wt="${line#worktree }"
        branch=""
        ;;
      branch*)
        branch="${line#branch refs/heads/}"
        ;;
      detached)
        branch=""
        ;;
    esac
  done < <(git worktree list --porcelain)
  if [ -n "${wt}" ]; then clean_one "${wt}" "${branch}" "${merged}" || true; fi

  # Check orphaned dirs in .worktrees
  if [ -d "${WT_DIR}" ]; then
    while IFS= read -r line; do
      case "${line}" in
        worktree*) registered="${registered}${line#worktree }
" ;;
      esac
    done < <(git worktree list --porcelain)
    for d in "${WT_DIR}"/*; do
      [ -e "${d}" ] || continue
      if ! printf '%s\n' "${registered}" | grep -Fqx "${d}"; then
        echo "  - orphan directory: ${d#${ROOT}/}"
        orphans=$((orphans+1))
      fi
    done
  fi

  git worktree prune
  say "clean finished: orphan dirs detected: ${orphans}"
}

clean_one() {
  local wt="$1" branch="$2" merged_list="$3" rel
  if [ "${wt}" = "${ROOT}" ]; then return 0; fi
  rel="${wt#${ROOT}/}"

  # Strict containment: only clean inside .worktrees/
  case "${wt}" in
    "${WT_DIR}"/*) ;;
    *)
      say "skip ${rel}: not inside .worktrees/ directory"
      return 0
      ;;
  esac

  case "${branch}" in
    feat/* | fix/* | chore/* | agent/* | codex/*) ;;
    *)
      say "skip ${rel}: branch '${branch:-detached}' is not feat/*/fix/*/chore/*/agent/*/codex/*"
      return 0
      ;;
  esac

  if ! printf '%s\n' "${merged_list}" | grep -qx "${branch}"; then
    say "skip ${rel}: ${branch} not merged into ${DEFAULT_BRANCH}"
    return 0
  fi

  if [ -n "$(git -C "${wt}" status --porcelain 2>/dev/null)" ]; then
    say "skip ${rel}: uncommitted changes (use: worktree.sh remove <task> --discard)"
    return 0
  fi

  say "removing ${rel} + ${branch} (merged into ${DEFAULT_BRANCH})"
  if git worktree remove "${wt}" 2>/dev/null; then
    git branch -d "${branch}" 2>/dev/null || true
  else
    say "warning: git worktree remove failed for ${rel}"
  fi
}

usage() {
  cat <<EOF
worktree.sh — Universal Git worktree lifecycle management.

Remote:         ${REMOTE}
Default Branch: ${DEFAULT_BRANCH}

Usage:
  worktree.sh init                        create .worktrees/ and update .gitignore
  worktree.sh new <task> [base] [--type feat|fix|chore|agent]
                                          create .worktrees/<task>
  worktree.sh list                        show all worktrees and dirty file counts
  worktree.sh ship <task>                 finish: push -> merge ${DEFAULT_BRANCH} -> remove worktree + branch
  worktree.sh remove <task> [--discard]   remove worktree; --discard drops dirty changes,
                       [--abandon]        --abandon drops unmerged branch
  worktree.sh prune                       drop stale registrations and show merged branches
  worktree.sh clean                       batch clean worktrees merged into ${DEFAULT_BRANCH}
  worktree.sh help

Environment variables:
  WORKTREE_REMOTE          explicit remote (default: auto-detected 'fork' or 'origin')
  WORKTREE_DEFAULT_BRANCH  explicit default branch (default: auto-detected 'omnimux', 'main', or 'master')
EOF
}

cmd="${1:-}"
shift || true
case "${cmd}" in
  init)   cmd_init ;;
  new)    [ "$#" -ge 1 ] || die "usage: worktree.sh new <task> [base] [--type feat|fix|chore|agent]"; cmd_new "$@" ;;
  list)   cmd_list ;;
  ship)   [ "$#" -ge 1 ] || die "usage: worktree.sh ship <task>"; cmd_ship "$1" ;;
  remove) [ "$#" -ge 1 ] || die "usage: worktree.sh remove <task> [--discard] [--abandon]"; cmd_remove "$@" ;;
  prune)  cmd_prune ;;
  clean)  cmd_clean ;;
  help | -h | --help) usage ;;
  "")     usage; exit 1 ;;
  *)      die "unknown command: ${cmd} (see: worktree.sh help)" ;;
esac
