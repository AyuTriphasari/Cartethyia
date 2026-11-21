/**
 * Inception's per-minute limit gets a 1-minute cooldown, not a skip and not a
 * long generic window.
 *
 * The Free tier throttles per minute (1 000 requests / 1M input tokens / 100K
 * output tokens) and the window resets every minute. The generic rate-limit
 * arm would *skip* an unstated 429 entirely — the account stays active and is
 * re-dialled every request — while Inception's own cadence is a known 1
 * minute. The arm pins that cadence so routing moves to the next account and
 * the flagged one returns almost at once.
 */
import { afterEach, expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import { resetCooldownCacheForTests } from "../../src/config/cooldowns";

const INCEPTION = "inception";
const UPSTREAM = { origin: "upstream" as const, scope: "provider" as const };

afterEach(() => {
  resetCooldownCacheForTests();
});

test("an Inception 429 cools the account for exactly 1 minute", () => {
  const classification = classifyAccountError(new Error("Rate limit exceeded. Please try again later."), {
    ...UPSTREAM,
    providerId: INCEPTION,
    statusCode: 429,
  });
  expect(classification.category).toBe("rate_limit_transient");
  expect(classification.status).toBe("cooldown");
  expect(classification.mutatesAccount).toBe(true);
  expect(classification.cooldownMs).toBe(60_000);
  expect(classification.retryAt?.getTime()).toBeGreaterThan(Date.now() + 55_000);
  expect(classification.retryAt?.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
});

test("an Inception input-token-limit message matches too", () => {
  const classification = classifyAccountError(
    new Error("Input token limit reached for this minute: 1,000,000 tokens"),
    {
      ...UPSTREAM,
      providerId: INCEPTION,
      statusCode: 429,
    },
  );
  expect(classification.category).toBe("rate_limit_transient");
  expect(classification.cooldownMs).toBe(60_000);
  expect(classification.mutatesAccount).toBe(true);
});

test("an Inception rate-limit code shape matches", () => {
  const classification = classifyAccountError(new Error("Rate limit exceeded"), {
    ...UPSTREAM,
    providerId: INCEPTION,
    providerCode: "rate_limit_reached",
  });
  expect(classification.category).toBe("rate_limit_transient");
  expect(classification.cooldownMs).toBe(60_000);
});

test("a non-Inception 429 with no stated window parks for the fallback", () => {
  // Upstream 2.8.5 stopped parking here, leaving the account active with only
  // an audit row. Measured 2026-11-21 that is what turns a bounded provider
  // outage into an unbounded request storm: nothing is cooled, so routing keeps
  // re-dialling a refused account and the caller never fails over.
  const classification = classifyAccountError(new Error("Rate limit exceeded. Please try again later."), {
    ...UPSTREAM,
    providerId: "openai",
    statusCode: 429,
  });
  expect(classification.category).toBe("rate_limit_transient");
  expect(classification.mutatesAccount).toBe(true);
  expect(classification.cooldownMs).toBe(900_000);
  expect(classification.retryAt).not.toBeNull();
});

test("a non-Inception stated window is honored verbatim, not floored to 15 minutes", () => {
  const classification = classifyAccountError(new Error("Rate limit exceeded"), {
    ...UPSTREAM,
    providerId: "openai",
    statusCode: 429,
    retryAfterMs: 120_000,
  });
  expect(classification.category).toBe("rate_limit_transient");
  expect(classification.mutatesAccount).toBe(true);
  expect(classification.cooldownMs).toBe(120_000);
});

test("an upstream-stated retry-after still wins over the 1-minute fallback", () => {
  const classification = classifyAccountError(new Error("Rate limit exceeded"), {
    ...UPSTREAM,
    providerId: INCEPTION,
    statusCode: 429,
    retryAfterMs: 5_000,
  });
  expect(classification.cooldownMs).toBe(5_000);
});
