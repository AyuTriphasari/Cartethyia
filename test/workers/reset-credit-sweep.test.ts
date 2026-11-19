/**
 * When a saved rate-limit reset is spent.
 *
 * The credit is the only thing that returns a weekly-exhausted account to
 * service before the provider's own reset — days later — and it is perishable
 * but finite, so the trigger has to be exact. These pin the decision, not the
 * HTTP: the provider wire format is the reset service's contract, and the sweep
 * only decides *whether* to call it.
 *
 * The rules under test:
 *   (a) the weekly window at or below the floor is the trigger — nothing else;
 *   (b) a 5-hour window is never a trigger, however empty (waiting is free);
 *   (c) no saved credit means no call, and a refusal is not retried in a loop;
 *   (d) one attempt per account per window, whatever the outcome.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import type { ProviderQuotaResult } from "../../src/providers/quota/quota-contracts";
import {
  clearResetCreditSweepMemoryForTests,
  resetCreditSweep,
  weeklyRemainingPercent,
  type ResetCreditSweepHooks,
} from "../../src/workers/reset-credit-sweep";

function quota(windows: Array<{ kind: string; remainingPercent: number }>): ProviderQuotaResult {
  return {
    source: "codex",
    plan: "plus",
    windows: windows.map((window) => ({
      kind: window.kind,
      label: window.kind,
      usedPercent: 100 - window.remainingPercent,
      remainingPercent: window.remainingPercent,
      resetsAt: null,
    })),
    error: null,
  } as unknown as ProviderQuotaResult;
}

/** A database double whose only job is to return the target rows. */
function dbWith(accounts: Array<{ id: string; providerId: string }>): CartethyiaDatabase {
  const rows = accounts.map((account) => ({
    accountId: account.id,
    providerId: account.providerId,
    tenantId: null,
    credentialKind: "oauth",
    label: account.id,
    authState: null,
  }));
  const client = {
    select: () => ({ from: () => ({ where: async () => rows }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: () => ({ values: async () => undefined }),
  };
  return {
    ...client,
    transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  } as unknown as CartethyiaDatabase;
}

interface Recorded {
  readonly lists: string[];
  readonly consumes: string[];
}

function harness(options: {
  readonly accounts?: Array<{ id: string; providerId: string }>;
  readonly quota?: ProviderQuotaResult | null;
  readonly available?: number | null;
  readonly ok?: boolean;
  readonly code?: string;
  readonly clock?: { t: number };
}): {
  readonly deps: Parameters<typeof resetCreditSweep>[0];
  readonly hooks: ResetCreditSweepHooks;
  readonly recorded: Recorded;
  readonly clock: { t: number };
} {
  const recorded: Recorded = { lists: [], consumes: [] };
  const clock = options.clock ?? { t: 1_000_000 };
  const hooks: ResetCreditSweepHooks = {
    readQuota: async () => (options.quota === undefined ? quota([{ kind: "weekly", remainingPercent: 0.4 }]) : options.quota),
    listCredits: async (_providerId, _credential) => {
      recorded.lists.push(_credential);
      const available = "available" in options ? options.available : 1;
      return available === null || available === undefined ? null : { availableCount: available };
    },
    consume: async (args) => {
      recorded.consumes.push(args.accountId);
      return options.ok === false
        ? { ok: false, code: options.code ?? "network_error", status: 0 }
        : { ok: true };
    },
  };
  const deps = {
    db: dbWith(options.accounts ?? [{ id: "acc-1", providerId: "codex" }]),
    redis: undefined,
    providerRegistry: {} as never,
    resolveCredential: async () => "credential",
  } as unknown as Parameters<typeof resetCreditSweep>[0];
  return { deps, hooks, recorded, clock };
}

beforeEach(() => {
  clearResetCreditSweepMemoryForTests();
});

describe("weeklyRemainingPercent", () => {
  test("reads the weekly window, not the session one", () => {
    const reading = quota([
      { kind: "session", remainingPercent: 0 },
      { kind: "weekly", remainingPercent: 4 },
    ]);
    expect(weeklyRemainingPercent(reading)).toBe(4);
  });

  test("is null when the provider reports no weekly window", () => {
    expect(weeklyRemainingPercent(quota([{ kind: "session", remainingPercent: 0 }]))).toBeNull();
  });
});

describe("resetCreditSweep", () => {
  test("spends a saved reset when the weekly window is under the floor", async () => {
    const { deps, hooks, recorded } = harness({});
    const result = await resetCreditSweep(deps, { hooks, now: () => 1_000_000 });
    expect(result).toEqual({ checked: 1, consumed: 1, skipped: 0, failed: 0 });
    expect(recorded.consumes).toEqual(["acc-1"]);
  });

  test("leaves an account with weekly room alone", async () => {
    const { deps, hooks, recorded } = harness({
      quota: quota([{ kind: "weekly", remainingPercent: 37 }]),
    });
    const result = await resetCreditSweep(deps, { hooks, now: () => 1_000_000 });
    expect(result.consumed).toBe(0);
    expect(result.skipped).toBe(1);
    // The bank was never opened: no list call, no consume call.
    expect(recorded.lists).toHaveLength(0);
  });

  test("an exhausted 5-hour window is not a trigger", async () => {
    const { deps, hooks, recorded } = harness({
      quota: quota([
        { kind: "session", remainingPercent: 0 },
        { kind: "weekly", remainingPercent: 42 },
      ]),
    });
    await resetCreditSweep(deps, { hooks, now: () => 1_000_000 });
    expect(recorded.consumes).toHaveLength(0);
  });

  test("no saved credit means no redemption", async () => {
    const { deps, hooks, recorded } = harness({ available: 0 });
    const result = await resetCreditSweep(deps, { hooks, now: () => 1_000_000 });
    expect(result.consumed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(recorded.consumes).toHaveLength(0);
  });

  test("an unreadable credit list is not zero, but it is not a redemption either", async () => {
    const { deps, hooks, recorded } = harness({ available: null });
    const result = await resetCreditSweep(deps, { hooks, now: () => 1_000_000 });
    expect(result.consumed).toBe(0);
    expect(recorded.consumes).toHaveLength(0);
  });

  test("an unreadable quota reading is left alone", async () => {
    const { deps, hooks, recorded } = harness({ quota: null });
    const result = await resetCreditSweep(deps, { hooks, now: () => 1_000_000 });
    expect(result.skipped).toBe(1);
    expect(recorded.consumes).toHaveLength(0);
  });

  test("a refusal is counted and not retried inside the window", async () => {
    const clock = { t: 1_000_000 };
    const { deps, hooks, recorded } = harness({ ok: false, code: "rate_limited", clock });
    const first = await resetCreditSweep(deps, { hooks, now: () => clock.t });
    expect(first.failed).toBe(1);

    // Nine minutes later the provider is not asked again.
    clock.t += 9 * 60_000;
    const second = await resetCreditSweep(deps, { hooks, now: () => clock.t });
    expect(second.checked).toBe(0);
    expect(second.skipped).toBe(1);
    expect(recorded.consumes).toHaveLength(1);

    // Past the spacing the next pass may try again.
    clock.t += 2 * 60_000;
    const third = await resetCreditSweep(deps, { hooks, now: () => clock.t });
    expect(third.checked).toBe(1);
    expect(recorded.consumes).toHaveLength(2);
  });

  test("a successful redemption is also spaced", async () => {
    const clock = { t: 1_000_000 };
    const { deps, hooks, recorded } = harness({ clock });
    await resetCreditSweep(deps, { hooks, now: () => clock.t });
    await resetCreditSweep(deps, { hooks, now: () => clock.t });
    expect(recorded.consumes).toHaveLength(1);
  });

  test("only reset-capable providers are swept", async () => {
    const { deps, hooks, recorded } = harness({
      accounts: [
        { id: "cb-1", providerId: "cb" },
        { id: "codex-1", providerId: "codex" },
      ],
    });
    const result = await resetCreditSweep(deps, { hooks, now: () => 1_000_000 });
    expect(result.checked).toBe(1);
    expect(recorded.consumes).toEqual(["codex-1"]);
  });

  test("the floor is inclusive and configurable", async () => {
    const exactly = harness({ quota: quota([{ kind: "weekly", remainingPercent: 1 }]) });
    expect((await resetCreditSweep(exactly.deps, { hooks: exactly.hooks, now: () => 1 })).consumed).toBe(1);

    clearResetCreditSweepMemoryForTests();
    const raised = harness({ quota: quota([{ kind: "weekly", remainingPercent: 5 }]) });
    const result = await resetCreditSweep(raised.deps, {
      hooks: raised.hooks,
      weeklyFloorPercent: 10,
      now: () => 1,
    });
    expect(result.consumed).toBe(1);
  });
});
