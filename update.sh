#!/usr/bin/env bash
# Update this patched Cartethyia fork from upstream.
#
#   ./update.sh check    dry-run: what a merge with upstream/main would touch
#   ./update.sh merge    merge upstream/main into local/patched (conflicts left for you)
#   ./update.sh verify   typecheck + the tests that cover the local patches
#   ./update.sh restart  rebuild the dashboard and restart the PM2 service
#
# The patches live as ordinary commits on `local/patched`, so a conflict is
# always "this file changed on both sides" and never a re-apply from scratch.
set -euo pipefail
cd "$(dirname "$0")"

BRANCH="local/patched"
UPSTREAM_REF="upstream/main"

say() { printf '\n== %s\n' "$*"; }

fetch_upstream() {
  git fetch upstream --tags --prune --quiet
  say "upstream $(git log --oneline -1 "$UPSTREAM_REF")"
  say "local    $(git log --oneline -1 "$BRANCH")"
  local behind ahead
  read -r ahead behind < <(git rev-list --left-right --count "$BRANCH...$UPSTREAM_REF")
  printf 'local commits: %s   upstream commits not merged: %s\n' "$ahead" "$behind"
}

cmd_check() {
  fetch_upstream
  local wt
  wt="$(mktemp -d /tmp/cart-mergecheck.XXXXXX)"
  git worktree add -q --detach "$wt" "$BRANCH"
  local rc=0
  ( cd "$wt" && git merge --no-commit --no-ff "$UPSTREAM_REF" >/dev/null 2>&1 ) || rc=$?
  local conflicts
  conflicts="$( cd "$wt" && git diff --name-only --diff-filter=U )"
  if [ -z "$conflicts" ]; then
    say "clean merge — no conflicts"
  else
    say "conflicted files ($(printf '%s\n' "$conflicts" | wc -l))"
    printf '%s\n' "$conflicts"
  fi
  ( cd "$wt" && git merge --abort >/dev/null 2>&1 ) || true
  git worktree remove --force "$wt" >/dev/null 2>&1 || true
  [ "$rc" -eq 0 ] || [ -n "$conflicts" ] || say "merge aborted with an error; see git status"
}

cmd_merge() {
  fetch_upstream
  git switch "$BRANCH"
  if git merge --no-ff --no-commit "$UPSTREAM_REF"; then
    say "clean merge staged — commit it with: git commit"
    return 0
  fi
  say "CONFLICTS — resolve these, then: git add <file> && git commit"
  git diff --name-only --diff-filter=U
  say "abandon with: git merge --abort"
  return 1
}

cmd_verify() {
  say "typecheck (backend)"
  bun run typecheck
  say "typecheck (dashboard)"
  bun run dashboard:typecheck
  say "tests covering the local patches"
  bun test \
    test/unit test/transport test/workers \
    test/providers/integrations \
    test/providers/freepi-session.test.ts \
    test/providers/buddy-protocol.test.ts \
    test/providers/codex-429-budget.test.ts \
    test/providers/antigravity-trailing-model-turn.test.ts \
    test/providers/deepai-session-busy-and-theos.test.ts
}

cmd_restart() {
  say "dashboard build"
  bun run dashboard:build
  say "pm2 restart"
  pm2 restart cartethyia --update-env
  sleep 3
  curl -sf -o /dev/null -w 'health: %{http_code}\n' http://127.0.0.1:12800/health || true
}

case "${1:-check}" in
  check)   cmd_check ;;
  merge)   cmd_merge ;;
  verify)  cmd_verify ;;
  restart) cmd_restart ;;
  *)       sed -n '2,12p' "$0"; exit 1 ;;
esac
