# Local patches on top of upstream Cartethyia

This repo is a fork of [risunCodex/Cartethyia](https://github.com/risunCodex/Cartethyia)
(mirrored to `AyuTriphasari/Cartethyia`) with our fixes kept as **ordinary
commits on `local/patched`**, so an upstream update is a `git merge` — never a
re-apply of a patch file.

```
origin    https://github.com/AyuTriphasari/Cartethyia.git   (our fork)
upstream  https://github.com/risunCodex/Cartethyia.git      (the source)
main      → tracks upstream
local/patched → upstream tag + our 10 commits   ← the branch we run
```

## Updating

```sh
./update.sh check     # dry-run merge: lists the files that would conflict
./update.sh merge     # real merge, conflicts left in the tree
./update.sh verify    # typecheck + the tests that cover the patches
./update.sh restart   # dashboard build + pm2 restart
```

Resolve a conflict by keeping upstream's structure and re-stating our intent
inside it — the commit message below says what the intent is, and the code
comments at each site say why. After resolving, run `./update.sh verify`
before restarting.

## The patch series

| commit | area | what it fixes | upstream may already have it if |
|---|---|---|---|
| `fix(antigravity)` | `providers/integrations/antigravity` | transcript ending on a model turn → 400 `Requests ending with a model turn` | `grep -rn "Continue from your last message" src/providers/integrations/antigravity` |
| `fix(qoder)` | `providers/integrations/qoder`, `operations/client-versions` | PAT identity: COSY signed with the account id from `userinfo`, not the machine id (403 `105 Login expired`); `cosy-version` pin `1.1.86-hotfix.5` | `grep -rn "resolveQoderPatIdentity" src/providers/integrations/qoder` |
| `feat(providers): [CC] CLI identity` | `operations/claude-client-identity.ts`, `custom-cli-headers`, `provider-catalog-service` | `(external, sdk-cli)` UA, `anthropic-beta`, `metadata.user_id` device/session for [CC]-only anthropic groups | `test -f src/providers/operations/claude-client-identity.ts` |
| `feat(workers)` | `workers/proxy-rotation.ts`, `workers/reset-credit-sweep.ts`, `boot/dependencies` | rotating single-address upstream proxy; auto-spend a saved rate-limit reset when the weekly window is gone | `test -f src/workers/proxy-rotation.ts` |
| `fix(health)` | `transport/failure-policy`, `operations/account-*`, `config/cooldowns` | DeepAI `409 session_busy` → retryable capacity; `403 machine_bound` → model-scoped quota instead of `auth_invalidated`; Tencent `14003` short model-busy cooldown | `grep -rn "session_busy" src/transport` |
| `fix(freepi)` | `integrations/freepi` | one session per account (4-session upstream cap), derived session id, always stream upstream | `grep -rn "freepiSessionIdFor" src/providers/integrations/freepi` |
| `fix(buddy,codex,dispatch)` | buddy chat/codebuddy, codex, `session-resolution`, `dispatch/*` | tenant system text carried into the leading user turn; 429 whose reset exceeds the retry budget retires instead of stalling; `created` as int64 seconds; conversation key = system **and** first turn | `grep -rn "carryOverSystemTextIntoUserTurn" src/providers/integrations/buddy` |
| `chore(local)` | `adapters/compatible-adapter.ts`, `scripts/` | `CARTETHYIA_DUMP_WIRE=1` wire dump to `/tmp/wire-dump.json`; 9router import/probe helpers | `grep -rn "CARTETHYIA_DUMP_WIRE" src` |

If a row's check already matches upstream, drop that commit on the next merge
(`git rebase --onto` or `git revert`) instead of forcing a duplicate.

## Environment notes

- `.env` is **not** in git. It is copied from the running deployment; keep it
  out of commits.
- `node_modules/` is not in git either — `bun install` after a merge.
- Base of the series: `v2.8.1` (`fcaab9f6`). Upstream had already moved to
  `v2.8.4` with a large transport/provider refactor when this fork was cut, so
  the first `./update.sh check` is expected to report conflicts; the ones that
  matter are the files whose *owner* moved (`src/transport/failure-policy.ts`
  no longer exists upstream).
