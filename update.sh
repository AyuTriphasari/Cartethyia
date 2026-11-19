#!/usr/bin/env bash
# Update this patched Cartethyia fork from upstream.
#
#   ./update.sh check    dry-run: which files a rebase onto upstream/main would conflict on
#   ./update.sh update   rebase the patch series onto upstream/main (conflicts left for you)
#   ./update.sh verify   typecheck + the tests that cover the local patches
#   ./update.sh restart  rebuild the dashboard and restart the PM2 service
#
# Why rebase and not merge: upstream rewrote its history, so `upstream/main`
# shares no ancestor with the release the patches were written against
# (v2.8.1 / fcaab9f6). A merge would be "unrelated histories" and conflict on
# every file. A rebase replays only our own commits, so a conflict is always
# one of the ~40 files this fork actually touches.
set -euo pipefail
cd "$(dirname "$0")"

BRANCH="local/patched"
UPSTREAM_REF="upstream/main"
BASE_FILE=".local-upstream-base"

say() { printf '\n== %s\n' "$*"; }

fetch_upstream() {
  git fetch upstream --tags --prune --quiet
  say "upstream  $(git log --oneline -1 "$UPSTREAM_REF")"
  say "local     $(git log --oneline -1 "$BRANCH")"
  printf 'patch series: %s commits on top of %s\n' \
    "$(git rev-list --count "$(cat "$BASE_FILE")..$BRANCH")" "$(cat "$BASE_FILE")"
}

conflict_list() { git diff --name-only --diff-filter=U; }

cmd_check() {
  fetch_upstream
  local base wt rc=0 conflicts
  base="$(cat "$BASE_FILE")"
  wt="$(mktemp -d /tmp/cart-rebasecheck.XXXXXX)"
  git worktree add -q --detach "$wt" "$BRANCH"
  ( cd "$wt" && git rebase --onto "$UPSTREAM_REF" "$base" >/tmp/cart-rebase.log 2>&1 ) || rc=$?
  conflicts="$( cd "$wt" && conflict_list )"
  if [ -z "$conflicts" ] && [ "$rc" -eq 0 ]; then
    say "clean rebase — no conflicts"
  else
    say "rebase stops at the first conflicting commit; more may follow"
    say "conflicted files ($(printf '%s\n' "$conflicts" | grep -c . || true))"
    printf '%s\n' "$conflicts"
    say "log tail"
    tail -5 /tmp/cart-rebase.log || true
  fi
  ( cd "$wt" && git rebase --abort >/dev/null 2>&1 ) || true
  git worktree remove --force "$wt" >/dev/null 2>&1 || true
}

cmd_update() {
  fetch_upstream
  git switch "$BRANCH"
  if ! git rebase --onto "$UPSTREAM_REF" "$(cat "$BASE_FILE")" --empty=drop; then
    say "CONFLICTS — resolve, then: git add <file> && git rebase --continue"
    conflict_list
    say "abandon with: git rebase --abort"
    return 1
  fi
  say "rebase clean"
  cmd_record_base
}

# Pins the upstream commit the series now sits on, so the next rebase has a
# boundary. Kept in its own commit so the patch commits stay upstream-shaped.
cmd_record_base() {
  git rev-parse "$UPSTREAM_REF" > "$BASE_FILE"
  git add "$BASE_FILE"
  git commit -q -m "chore(local): rebase base $(git rev-parse --short "$UPSTREAM_REF")" || true
  say "base recorded: $(cat "$BASE_FILE")"
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
  update)  cmd_update ;;
  verify)  cmd_verify ;;
  restart) cmd_restart ;;
  *)       sed -n '2,13p' "$0"; exit 1 ;;
esac
