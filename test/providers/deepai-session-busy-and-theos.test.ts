/**
 * DeepAI Code has two verdicts that used to be read as the wrong thing.
 *
 * 1. `409 {"type":"session_busy"}` — "Your coding requests are using the
 *    available capacity. Waiting for a slot." One concurrent coding slot per
 *    free account. The status table mapped 409 to `upstream_conflict`, which is
 *    neither retryable nor account-mutating, so the buyer got a hard 409
 *    instead of a sibling account's 200 (737 rows / 24 h on `deepai/minimax-m3`,
 *    every one a single telemetry row — no failover was attempted). Measured
 *    live 2026-11-19: two parallel requests to one account always produced one
 *    200 and one 409.
 *
 * 2. `403 {"code":"machine_bound"}` — "Free daily Theos are not available right
 *    now. Try again at <ISO>." A spent pooled daily allowance. Read as an auth
 *    failure it carried `credentialEvidence` and cooled healthy keys to
 *    `auth_invalidated`; one six-request burst flipped eight accounts. It must
 *    classify as quota, model-scoped (the catalog's zero-Theos models keep
 *    working), and honour the stated reset instead of a guessed window.
 */
import { expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import {
  classifyUpstreamError,
  mapUpstreamHttpError,
  upstreamErrorIdentifier,
} from "../../src/protocol/upstream-errors";
import { classifyUpstreamFailure } from "../../src/protocol/failure-classify";
import { GatewayError } from "../../src/protocol/gateway-error";

const SESSION_BUSY = {
  error: {
    message: "Your coding requests are using the available capacity. Waiting for a slot.",
    type: "session_busy",
    code: "session_busy",
  },
};

/**
 * A reset the provider states must be in the future for the parser to honour
 * it, so the stamp is computed: a hard-coded date made this test a time bomb
 * that started failing the day after it was written (the 23 h window silently
 * became "the past", and the assertion saw the 1 h fallback instead).
 */
const THEOS_RESET_AT = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
const THEOS_SPENT = {
  error: {
    message: `Free daily Theos are not available right now. Try again at ${THEOS_RESET_AT}.`,
    type: "machine_bound",
    code: "machine_bound",
  },
};

test("DeepAI session_busy is capacity, so the attempt loop fails over", async () => {
  expect(upstreamErrorIdentifier(SESSION_BUSY)).toBe("session_busy");
  expect(classifyUpstreamError(409, "session_busy")).toEqual({
    code: "upstream_overloaded",
    status: 529,
    origin: "upstream",
  });
  const error = await mapUpstreamHttpError(
    new Response(JSON.stringify(SESSION_BUSY), { status: 409 }),
    "deepai",
  ).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(GatewayError);
  const policy = classifyUpstreamFailure(error);
  expect(policy.category).toBe("upstream_overloaded");
  expect(policy.retryable).toBe(true);
  expect(policy.mutatesAccount).toBe(false);
  // A busy slot is not a credential signal, so the account is never cooled.
  const health = classifyAccountError(error, {
    origin: "upstream",
    scope: policy.scope ?? "provider",
    statusCode: 529,
    providerId: "deepai",
    providerCode: "session_busy",
    modelId: "minimax-m3",
  });
  expect(health.category).not.toBe("auth_invalidated");
});

test("DeepAI machine_bound is a spent allowance, not an invalid credential", async () => {
  expect(upstreamErrorIdentifier(THEOS_SPENT)).toBe("machine_bound");
  // The status table would call 403 an auth failure with credential evidence.
  expect(classifyUpstreamError(403, "machine_bound")).toEqual({
    code: "quota_exceeded",
    status: 429,
    origin: "upstream",
    rateLimitScope: "provider",
  });

  const error = await mapUpstreamHttpError(
    new Response(JSON.stringify(THEOS_SPENT), { status: 403 }),
    "deepai",
  ).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(GatewayError);
  const health = classifyAccountError(error, {
    origin: "upstream",
    scope: "provider",
    statusCode: 403,
    providerId: "deepai",
    providerCode: "machine_bound",
    modelId: "minimax-m3",
    upstreamBody: THEOS_SPENT,
  });
  expect(health.category).toBe("quota_exhausted");
  expect(health.status).toBe("cooldown");
  expect(health.mutatesAccount).toBe(true);
  // Scoped to the model: the zero-Theos rows on the same account still serve.
  expect(health.modelScoped).toBe(true);
  expect(health.rotateAccount).toBe(true);
  // The provider stated the reset (~23 h here); never the generic fallback.
  expect(health.cooldownMs).toBeGreaterThan(20 * 60 * 60 * 1000);
  expect(health.providerStated).toBe(true);
});
