import { describe, expect, test } from "bun:test";
import { InMemoryIpAbuseStore, IpAbuseProtectionService } from "../../src/security/abuse";

/**
 * A loopback identity must never be *banned*.
 *
 * Measured 2026-11-21 on the production install: every co-located consumer (the
 * gateway in front, the seller node, the operator's tooling) arrives as
 * 127.0.0.1, so they share one abuse bucket. When an upstream provider's daily
 * allowance ran out, retries pushed that shared counter past the escalation
 * ceiling and the gateway banned 127.0.0.1 for an hour — after which every
 * `/v1/*` call answered `ip-banned`, including the operator's own.
 *
 * `countOnly` is what the guard uses for that identity: the window ceiling
 * still sheds load (it clears on its own), the ban never fires.
 */
function service(opts: { maxRequestsPerWindow?: number; banThreshold?: number } = {}) {
  const store = new InMemoryIpAbuseStore();
  const service = new IpAbuseProtectionService(store, () => 1_000_000, {
    maxRequestsPerWindow: opts.maxRequestsPerWindow ?? 10,
    banThreshold: opts.banThreshold ?? 20,
    banDurationMs: 60 * 60 * 1000,
  });
  return { store, service };
}

const loopback = { address: "127.0.0.1", source: "tcp-peer" } as const;

describe("loopback identity is throttled but never banned", () => {
  test("countOnly keeps admitting until the window ceiling, then sheds", async () => {
    const { service: svc } = service();
    for (let index = 0; index < 10; index += 1) {
      expect(await svc.countOnly({ identity: loopback, route: "/v1/chat/completions" })).toBe(false);
    }
    expect(await svc.countOnly({ identity: loopback, route: "/v1/chat/completions" })).toBe(true);
  });

  test("countOnly never records a ban, however far past the ceiling it runs", async () => {
    const { store, service: svc } = service();
    for (let index = 0; index < 500; index += 1) {
      await svc.countOnly({ identity: loopback, route: "/v1/chat/completions" });
    }
    // The ban marker is the only state a later request can be refused on.
    expect(await store.isBanned("127.0.0.1", 1_000_000)).toBe(false);
    // And the escalation counter must not have been armed either: a later
    // `checkBeforeAccess` from a different route is judged on that route's own
    // window, not on a ban inherited from this one.
    const outcome = await store.checkAndRecord({
      identity: "127.0.0.1",
      route: "/v1/models",
      now: 1_000_000,
      limit: 10,
      banThreshold: 20,
      banDurationMs: 60 * 60 * 1000,
    });
    expect(outcome.banned).toBe(false);
  });

  test("the ban path still fires for a public address", async () => {
    const { service: svc } = service();
    const publicClient = { address: "203.0.113.9", source: "tcp-peer" } as const;
    // 20 is the escalation ceiling: the 21st attempt bans.
    for (let index = 0; index < 20; index += 1) {
      await svc
        .checkBeforeAccess({ identity: publicClient, route: "/v1/chat/completions" })
        .catch(() => undefined);
    }
    const refusal = await svc
      .checkBeforeAccess({ identity: publicClient, route: "/v1/chat/completions" })
      .then(() => null)
      .catch((error: unknown) => error as { code?: string; details?: { reason?: string } });
    expect(refusal).not.toBeNull();
    expect(refusal?.details?.reason).toBe("ip-banned");
  });
});
