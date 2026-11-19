/**
 * Spends a saved rate-limit reset before an account is parked for the rest of
 * its weekly window.
 *
 * A Codex/Claude account that has burned its weekly allowance answers 429
 * `usage_limit_reached` with the *reset time of the window* — hours away, or
 * days for the weekly one. The health machine parks the account until then,
 * which is correct but leaves a healthy credential idle while the operator's
 * saved reset credit — granted for exactly this situation — sits unspent. The
 * console has offered the redemption by hand since the reset endpoints were
 * reverse-engineered; this sweep is the same operation on the trigger the
 * provider itself gives us: the weekly window is (nearly) exhausted and a
 * redeemable credit exists.
 *
 * Two rules keep it from being wasteful or noisy:
 *
 * - The credit is perishable but not free: it is only spent when the weekly
 *   window is at or below {@link DEFAULT_WEEKLY_FLOOR_PERCENT}. A 5-hour window
 *   that resets in twenty minutes is deliberately *not* a trigger — waiting is
 *   free, a credit is not.
 * - One attempt per account per {@link DEFAULT_RETRY_MS}. A failed redemption
 *   (network, provider refusal) must not become a hot loop against the reset
 *   endpoint, and a successful one leaves nothing to redeem anyway.
 *
 * The reading comes from the quota cache the refresh sweep already keeps warm;
 * a cold entry is refreshed through the same refresh-aware credential path so
 * the sweep never invents a second way to reach the provider.
 */
import { log } from "../observability/logger";
import {
  QUOTA_REFRESH_TIMEOUT_MS,
  listQuotaRefreshTargets,
  refreshAccountQuota,
  signalFetch,
  targetLens,
  type QuotaRefreshDeps,
  type QuotaRefreshTarget,
} from "../providers/quota/refresh";
import { cachedQuotaAgeMs, getCachedQuotaEntry } from "../providers/quota/cache";
import type { ProviderQuotaResult } from "../providers/quota/quota-contracts";
import type { ProviderId } from "../providers/provider-contracts";
import {
  consumeAccountResetCredit,
  listAccountResetCredits,
  supportsAccountReset,
} from "../providers/operations/account-reset-service";

/** Weekly remaining percent at or below which a saved reset is spent. */
export const DEFAULT_WEEKLY_FLOOR_PERCENT = 1;
/** Minimum spacing between two redemption attempts for one account. */
export const DEFAULT_RETRY_MS = 10 * 60_000;
/** A cached reading older than this is refreshed before it decides anything. */
export const DEFAULT_MAX_CACHE_AGE_MS = 15 * 60_000;

/**
 * The three provider reads the pass depends on, injectable so a test can drive
 * the decision logic without a network or a provider adapter.
 */
export interface ResetCreditSweepHooks {
  /** Weekly reading for one account; `null` when it could not be read. */
  readonly readQuota?: (target: QuotaRefreshTarget) => Promise<ProviderQuotaResult | null>;
  /** Saved resets available to the credential; `null` when the read failed. */
  readonly listCredits?: (
    providerId: string,
    credential: string,
  ) => Promise<{ readonly availableCount: number } | null>;
  /** Redeems one saved reset. */
  readonly consume?: (args: {
    readonly accountId: string;
    readonly providerId: string;
    readonly credentialRaw: string;
  }) => Promise<{ readonly ok: boolean; readonly code?: string; readonly status?: number }>;
}

export interface ResetCreditSweepOptions {
  /** Weekly remaining percent that triggers a redemption. Defaults to 1. */
  readonly weeklyFloorPercent?: number;
  /** Per-account attempt spacing. Defaults to 10 minutes. */
  readonly retryMs?: number;
  /** Freshness required from the quota cache. Defaults to 15 minutes. */
  readonly maxCacheAgeMs?: number;
  /** Cap on accounts attempted per pass. Defaults to 20. */
  readonly maxPerPass?: number;
  readonly now?: () => number;
  readonly fetcher?: typeof fetch;
  readonly hooks?: ResetCreditSweepHooks;
}

export interface ResetCreditSweepResult {
  readonly checked: number;
  readonly consumed: number;
  readonly skipped: number;
  readonly failed: number;
}

/**
 * The account's weekly remaining percent, or `null` when the provider reports
 * no weekly window at all.
 *
 * `kind` is what the provider collectors classify by window length, so this
 * never guesses from the label: a 168-hour window is `weekly` and a 5-hour one
 * is `session`, and only the former justifies spending a credit.
 */
export function weeklyRemainingPercent(quota: ProviderQuotaResult): number | null {
  for (const window of quota.windows) {
    if (window.kind !== "weekly") continue;
    if (typeof window.remainingPercent === "number" && Number.isFinite(window.remainingPercent)) {
      return window.remainingPercent;
    }
    if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)) {
      return Math.max(0, 100 - window.usedPercent);
    }
  }
  return null;
}

/**
 * Last redemption attempt per account, so a failure cannot turn the sweep into
 * a hot loop. Module scope, like the refresh sweep's announcement memory: the
 * spacing has to survive between passes.
 */
const lastAttemptAt = new Map<string, number>();

/** Test hook: forget the per-account attempt spacing. */
export function clearResetCreditSweepMemoryForTests(): void {
  lastAttemptAt.clear();
}

/**
 * One account's weekly reading, from the warm cache when it is fresh enough and
 * from the refresh path otherwise. Never throws: an unreadable account is left
 * alone and the next pass retries it.
 */
async function readQuotaFor(
  deps: QuotaRefreshDeps,
  target: QuotaRefreshTarget,
  fetcher: typeof fetch,
  maxCacheAgeMs: number,
  now: () => number,
): Promise<ProviderQuotaResult | null> {
  try {
    const cached = await getCachedQuotaEntry(targetLens(target), target.accountId, deps.redis);
    if (
      cached !== null &&
      cached.quota.error === null &&
      cachedQuotaAgeMs(cached, now()) <= maxCacheAgeMs
    ) {
      return cached.quota;
    }
    const outcome = await refreshAccountQuota(deps, target, fetcher);
    return outcome.failure === null ? outcome.quota : null;
  } catch (error) {
    log.warn("reset-credit sweep: quota read failed", {
      account: target.accountId,
      error: String(error),
    });
    return null;
  }
}

/**
 * One pass. Never throws: a sweep that cannot read an account leaves it alone
 * and the next tick retries.
 */
export async function resetCreditSweep(
  deps: QuotaRefreshDeps,
  options: ResetCreditSweepOptions = {},
): Promise<ResetCreditSweepResult> {
  const weeklyFloorPercent = options.weeklyFloorPercent ?? DEFAULT_WEEKLY_FLOOR_PERCENT;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const maxCacheAgeMs = options.maxCacheAgeMs ?? DEFAULT_MAX_CACHE_AGE_MS;
  const maxPerPass = options.maxPerPass ?? 20;
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? signalFetch(AbortSignal.timeout(QUOTA_REFRESH_TIMEOUT_MS));

  const readQuota =
    options.hooks?.readQuota ??
    ((target: QuotaRefreshTarget) => readQuotaFor(deps, target, fetcher, maxCacheAgeMs, now));
  const listCredits =
    options.hooks?.listCredits ??
    ((providerId: string, credential: string) =>
      listAccountResetCredits(providerId, credential, fetcher));
  const consume =
    options.hooks?.consume ??
    ((args: { accountId: string; providerId: string; credentialRaw: string }) =>
      consumeAccountResetCredit({
        db: deps.db,
        accountId: args.accountId,
        providerId: args.providerId,
        credentialRaw: args.credentialRaw,
        fetcher,
        snapshotInvalidator: deps.snapshotInvalidator,
      }));

  let checked = 0;
  let consumed = 0;
  let skipped = 0;
  let failed = 0;

  let targets: readonly QuotaRefreshTarget[];
  try {
    targets = (await listQuotaRefreshTargets(deps.db)).filter((target) =>
      supportsAccountReset(target.providerId),
    );
  } catch (error) {
    log.warn("reset-credit sweep: target list failed", { error: String(error) });
    return { checked, consumed, skipped, failed };
  }

  for (const target of targets) {
    if (checked >= maxPerPass) break;
    const attemptedAt = lastAttemptAt.get(target.accountId);
    if (attemptedAt !== undefined && now() - attemptedAt < retryMs) {
      skipped += 1;
      continue;
    }
    checked += 1;

    const quota = await readQuota(target);
    const weekly = quota === null ? null : weeklyRemainingPercent(quota);
    if (weekly === null || weekly > weeklyFloorPercent) {
      skipped += 1;
      continue;
    }

    // The quota says the week is gone; only now is the bank worth opening.
    let credential: string;
    try {
      credential = await deps.resolveCredential(target.providerId as ProviderId, target.accountId);
    } catch (error) {
      log.warn("reset-credit sweep: credential unavailable", {
        account: target.accountId,
        error: String(error),
      });
      skipped += 1;
      continue;
    }
    if (!credential) {
      skipped += 1;
      continue;
    }

    lastAttemptAt.set(target.accountId, now());

    let available = 0;
    try {
      const list = await listCredits(target.providerId, credential);
      available = list?.availableCount ?? 0;
    } catch (error) {
      log.warn("reset-credit sweep: credit list failed", {
        account: target.accountId,
        error: String(error),
      });
      available = 0;
    }
    if (available === 0) {
      // The interesting half of "no redemption": the week really is gone and
      // there is nothing left to spend, so this account is parked until the
      // provider's own reset. Silent when the weekly window still has room —
      // that is the ordinary case and would otherwise log every pass.
      log.info("reset-credit sweep: weekly exhausted with no saved reset left", {
        account: target.accountId,
        provider: target.providerId,
        weeklyRemainingPercent: weekly,
      });
      skipped += 1;
      continue;
    }

    try {
      const result = await consume({
        accountId: target.accountId,
        providerId: target.providerId,
        credentialRaw: credential,
      });
      if (result.ok) {
        consumed += 1;
        log.info("reset-credit sweep: weekly limit reset consumed", {
          account: target.accountId,
          provider: target.providerId,
          weeklyRemainingPercent: weekly,
        });
      } else {
        failed += 1;
        log.warn("reset-credit sweep: reset refused", {
          account: target.accountId,
          provider: target.providerId,
          code: result.code,
          status: result.status,
        });
      }
    } catch (error) {
      failed += 1;
      log.warn("reset-credit sweep: reset threw", {
        account: target.accountId,
        provider: target.providerId,
        error: String(error),
      });
    }
  }

  return { checked, consumed, skipped, failed };
}
