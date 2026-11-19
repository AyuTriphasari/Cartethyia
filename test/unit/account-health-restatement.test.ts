/**
 * Why a single bad minute parked an account all day.
 *
 * Three separate mechanisms conspired to make a cooldown permanent, and each of
 * them is pinned here because each one is invisible from outside — the account
 * row simply reads `cooldown` with a deadline far in the future:
 *
 * 1. **A cancelled exchange cooled the account.** `Provider network failure:
 *    aborted` arrived 45 times in seventeen hours on the Codex pool and every
 *    one of them parked a healthy account for the transient window. An abort
 *    says the exchange was cancelled, not that the account is unusable.
 * 2. **A re-statement of the same verdict extended the window.** The retry
 *    chain walks accounts within one request, so the same (account, model) pair
 *    reports its verdict again while its window is still in force; the
 *    unsupported-model ladder counted each report as a fresh hit and doubled
 *    the window (6h → 12h) inside the same second.
 * 3. **A fallback failure re-armed an account that was already cooling.** A
 *    cooling account is still dialled as a last resort, and every one of those
 *    attempts wrote `now + escalated`, which the monotonic maximum could only
 *    ever push later — so the operator's only way back was a manual recovery.
 *
 * A database double stands in for the handle: the behavior under test is
 * exactly which values reach `.set()`.
 */
import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import { classifyUpstreamFailure } from "../../src/transport/failure-policy";
import {
  classifyAccountError,
  recordAccountFailure,
} from "../../src/providers/operations/account-health-service";

interface Captured {
  readonly updates: Record<string, unknown>[];
  readonly events: Record<string, unknown>[];
}

function dbDouble(account: Record<string, unknown>): { db: CartethyiaDatabase; captured: Captured } {
  const updates: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const client = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [account],
        }),
      }),
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        updates.push(payload);
        return { where: async () => undefined };
      },
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        events.push(row);
      },
    }),
  };
  const db = {
    ...client,
    transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  } as unknown as CartethyiaDatabase;
  return { db, captured: { updates, events } };
}

function account(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acc-1",
    status: "active",
    consecutiveFailures: 0,
    staticToken: false,
    cooldownUntil: null,
    modelCooldowns: {},
    modelBlockHits: null,
    ...extra,
  };
}

/** A stream that the upstream dropped mid-flight, as the pool reports it. */
function abortedError(): GatewayError {
  return new GatewayError("transport_unavailable", 502, "Provider network failure: aborted", {}, "upstream");
}

/** The buddy family's "this model does not exist" answer. */
function unsupportedModelError(): GatewayError {
  return new GatewayError(
    "invalid_request",
    400,
    "upstream 400: service info not found",
    { providerCode: "11102" },
    "upstream",
  );
}

/** An account-scoped verdict, which is what makes `canMutate` true. */
const ACCOUNT_EVIDENCE = { origin: "upstream", scope: "account" } as const;

describe("an abort is a cancellation, not an account verdict", () => {
  test("classifies as a transport fault but does not mutate the account", () => {
    const classification = classifyAccountError(abortedError(), {
      ...classifyUpstreamFailure(abortedError()),
      ...ACCOUNT_EVIDENCE,
    });
    // The same scope and origin that parked the account before.
    expect(classification.category).toBe("server_error");
    expect(classification.mutatesAccount).toBe(false);
  });

  test("writes the cause to the health log without touching status or deadline", async () => {
    const { db, captured } = dbDouble(account());
    const error = abortedError();
    await recordAccountFailure(db, "acc-1", error, {
      ...classifyUpstreamFailure(error),
      ...ACCOUNT_EVIDENCE,
    });
    // Nothing reached `.set()`: the account stays `active` and routable.
    expect(captured.updates).toHaveLength(0);
    // The row is still written, so the request-log symptom has a cause.
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]?.["reason"]).toContain("aborted");
  });

  test("a real 5xx on the same scope still cools the account", () => {
    const error = new GatewayError("transport_unavailable", 502, "upstream 502: bad gateway", {}, "upstream");
    const classification = classifyAccountError(error, {
      ...classifyUpstreamFailure(error),
      ...ACCOUNT_EVIDENCE,
    });
    expect(classification.mutatesAccount).toBe(true);
  });
});

describe("a re-statement does not extend an in-force window", () => {
  const sixHoursOut = () => new Date(Date.now() + 6 * 3600_000).toISOString();

  test("the same (account, model) pair keeps its deadline on a second report", async () => {
    const until = sixHoursOut();
    const { db, captured } = dbDouble(
      account({ modelBlockHits: { x: 1 }, modelCooldowns: { x: until } }),
    );
    await recordAccountFailure(db, "acc-1", unsupportedModelError(), {
      origin: "upstream",
      scope: "model",
      modelId: "x",
    });
    const payload = captured.updates[0]!;
    const cooldowns = payload["modelCooldowns"] as Record<string, string>;
    // Not 12h: the window was already in force, so this report added no news.
    expect(cooldowns["x"]).toBe(until);
    // The ladder still records the hit, so a later episode escalates.
    expect(payload["modelBlockHits"]).toEqual({ x: 2 });
    // And no duplicate audit row claimed a second episode.
    expect(captured.events).toHaveLength(0);
  });

  test("a lapsed window is written fresh, ladder and all", async () => {
    const { db, captured } = dbDouble(
      account({
        modelBlockHits: { x: 1 },
        modelCooldowns: { x: new Date(Date.now() - 60_000).toISOString() },
      }),
    );
    await recordAccountFailure(db, "acc-1", unsupportedModelError(), {
      origin: "upstream",
      scope: "model",
      modelId: "x",
    });
    const cooldowns = captured.updates[0]!["modelCooldowns"] as Record<string, string>;
    const window = Date.parse(cooldowns["x"]!) - Date.now();
    expect(window).toBeGreaterThanOrEqual(12 * 3600_000 - 5_000);
  });
});

describe("a cooling deadline is extended, never shortened", () => {
  const deadline = () => new Date(Date.now() + 15 * 60_000).toISOString();

  test("an unstated failure never releases a deadline already in force", async () => {
    // Monotonic, not frozen: a fresh fallback may land later than the window in
    // force, but it may never recompute the deadline backwards and hand a
    // closed account straight back to routing.
    const until = new Date(Date.now() + 11 * 3600_000);
    const { db, captured } = dbDouble(account({ status: "cooldown", cooldownUntil: until }));
    const error = new GatewayError("transport_unavailable", 502, "upstream 502: bad gateway", {}, "upstream");
    await recordAccountFailure(db, "acc-1", error, {
      ...classifyUpstreamFailure(error),
      ...ACCOUNT_EVIDENCE,
    });
    const payload = captured.updates[0]!;
    expect(payload["status"]).toBe("cooldown");
    expect((payload["cooldownUntil"] as Date).getTime()).toBeGreaterThanOrEqual(until.getTime());
  });

  test("a provider-stated window still lands over a shorter fallback", async () => {
    const until = deadline();
    const { db, captured } = dbDouble(account({ status: "cooldown", cooldownUntil: until }));
    const error = new GatewayError("quota_exceeded", 429, "You have hit your ChatGPT usage limit", {}, "upstream");
    await recordAccountFailure(db, "acc-1", error, {
      ...classifyUpstreamFailure(error),
      ...ACCOUNT_EVIDENCE,
      retryAfterMs: 3600_000,
    });
    const payload = captured.updates[0]!;
    const next = Date.parse(String(payload["cooldownUntil"])) - Date.now();
    // The upstream named an hour; the 15-minute fallback must not cap it.
    expect(next).toBeGreaterThanOrEqual(3600_000 - 5_000);
  });

  test("an active account is still parked by the same failure", async () => {
    const { db, captured } = dbDouble(account());
    const error = new GatewayError("transport_unavailable", 502, "upstream 502: bad gateway", {}, "upstream");
    await recordAccountFailure(db, "acc-1", error, {
      ...classifyUpstreamFailure(error),
      ...ACCOUNT_EVIDENCE,
    });
    const payload = captured.updates[0]!;
    expect(payload["status"]).toBe("cooldown");
    expect(Date.parse(String(payload["cooldownUntil"]))).toBeGreaterThan(Date.now());
  });
});
