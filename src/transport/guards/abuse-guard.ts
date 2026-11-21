// IP-abuse protection guard: counts every `/v1/*` attempt against the per-IP
// ceiling via the root `request` hook.
import { Elysia } from "elysia";
import type { TrustedProxyBoundary } from "../../config/network";
import { isLoopbackAddress, resolveClientIdentity } from "../../security/ip-boundary";
import type { ProxyRequestStateStore } from "../request/state";
import { fastPathname } from "../pathname";
import type { IpAbuseProtectionService } from "../../security/abuse";
import { GatewayError } from "../../protocol/gateway-error";
import { peerAddressUnavailableError } from "./guard-errors";

/**
 * Counts every `/v1/*` attempt against the per-IP ceiling, including the ones
 * that never reach a route.
 *
 * Mounted at the root through the `request` hook, deliberately not as a
 * gateway plugin stage. A plugin `beforeHandle` only runs for a request that
 * matches a registered route, and so does a root `beforeHandle` — measured:
 * 300 attempts rotating unregistered `/v1/*` paths produced zero 429s and no
 * ban, while the same attempts against a real route escalated normally. A
 * caller that has already decided to hammer the gateway could therefore pick
 * the cheapest evasion available: address a path that does not exist, or a
 * real path with the wrong method, and the counter was never touched. Only
 * the root `request` hook runs for every inbound request regardless of
 * whether anything matches it.
 *
 * The root `request` hook runs ahead of the gateway plugin's `beforeHandle`
 * chain, so the counter still executes before authentication: an
 * unauthenticated attempt is counted, and a rejected attempt keeps counting
 * toward the ban — which is the escalation path, not an exemption from it.
 * Throwing here short-circuits the request, so a banned or over-limit caller
 * is rejected before it can reach routing.
 */
export function createIpAbuseProtectionMiddleware(deps: {
  readonly stateStore: ProxyRequestStateStore;
  readonly ipAbuseProtection: IpAbuseProtectionService;
  readonly trustedProxyBoundary: TrustedProxyBoundary;
  readonly resolvePeerAddress?: (request: Request) => string | null;
}): Elysia {
  const app = new Elysia() as unknown as {
    request(
      handler: (context: {
        request: Request;
        server?: { requestIP(request: Request): { address: string } | null };
      }) => void | Promise<void>,
    ): unknown;
  };
  app.request(async ({ request, server }) => {
    const path = fastPathname(request.url);
    if (
      path === "/health" ||
      path === "/health/ready" ||
      // Scoped to /v1/* only: /console/api/auth/* already has its own
      // fail-closed, DB-persisted ConsoleLockoutService with a lower
      // (5-failure) threshold that always trips first — running both
      // here paid a second sequential counter per login with zero
      // effect (dual-throttler refinement pass).
      !path.startsWith("/v1/")
    )
      return;
    // The client identity is resolved here rather than read off request state:
    // this hook runs at the root, ahead of the gateway plugin's `beforeHandle`
    // chain, so `state.clientIdentity` is not populated yet. Resolving it from
    // the same boundary the identity middleware uses keeps one answer for the
    // same request, and keeps the counter independent of middleware ordering.
    const peer = deps.resolvePeerAddress
      ? deps.resolvePeerAddress(request)
      : (server?.requestIP(request)?.address ?? null);
    if (!peer)
      throw peerAddressUnavailableError();
    const address = resolveClientIdentity(request, deps.trustedProxyBoundary, peer);
    const state = deps.stateStore.get(request);
    // The identity middleware runs later in the plugin chain and resolves the
    // same value from the same boundary; stashing it here means the request
    // pays for one resolveClientIdentity instead of two, and the middleware can
    // skip its own when it finds the stash.
    if (state !== undefined) {
      state.clientIdentity ??= {
        address,
        source: address === peer ? "tcp-peer" : "trusted-forwarded-header",
      };
    }
    // A loopback identity is this host talking to itself: the co-located
    // consumers (a local gateway in front, the seller node, the operator's own
    // tooling) all arrive as 127.0.0.1 and therefore share ONE abuse bucket.
    // Counting them is right — a runaway local client must not be able to melt
    // the box — but *banning* that identity takes the whole install down, and
    // the ban cannot be evaded the way a public one can: there is no other
    // address to come from. Measured 2026-11-21: an upstream provider's daily
    // allowance ran out, retries pushed the shared loopback counter past the
    // escalation ceiling, and the gateway banned itself for an hour — every
    // `/v1/*` call then answered `ip-banned`, including the operator's.
    //
    // So the per-window ceiling still applies (it sheds load without a
    // deadline), and only the escalation to a ban is skipped. A public client
    // is unaffected: it arrives with its own address, or with a trusted
    // forwarded one, and keeps the full ban path.
    if (isLoopbackAddress(address)) {
      const overWindow = await deps.ipAbuseProtection.countOnly({
        identity: {
          address,
          source: address === peer ? "tcp-peer" : "trusted-forwarded-header",
        },
        route: path,
        ...(state === undefined ? {} : { signal: state.abortController.signal }),
      });
      if (!overWindow) return;
      throw new GatewayError(
        "rate_limited",
        429,
        "This address is sending requests faster than the abuse limit allows (request {requestId}). Back off and retry after the window rolls over. You've maxed this window — pace yourself ⏳",
        { reason: "ip-rate-limited", ip: address, route: path },
      );
    }
    try {
      await deps.ipAbuseProtection.checkBeforeAccess({
        identity: {
          address,
          source: address === peer ? "tcp-peer" : "trusted-forwarded-header",
        },
        route: path,
        ...(state === undefined ? {} : { signal: state.abortController.signal }),
      });
    } catch (error) {
      // No fixed `retry-after` here. The store measures the real remainder —
      // a ban's marker TTL, or the age of the oldest attempt in a rate-limited
      // window — and carries it as `retryAfterMs`, which the error
      // normalization middleware turns into the header. Assigning a constant
      // here pre-empted that hint (`retry-after` is only filled when unset) and
      // told a client facing a 60-second window to wait a full hour.
      throw error;
    }
  });
  return app as unknown as Elysia;
}
