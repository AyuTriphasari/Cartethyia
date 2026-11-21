/**
 * A saturated *model* must not park the whole *account*.
 *
 * Tencent's buddy family (CodeBuddy `cb`/`cbcn`, WorkBuddy `workbuddy`/
 * `workbuddycn`) answers
 *
 *   {"code":14003,"msg":"too many requests",
 *    "displayMsg":{"en":"Model busy. Please switch models or retry later"},
 *    "displayTips":{"en":"This model is currently saturated. It is not a network
 *    issue. Please switch to another model or wait a moment and retry."},
 *    "actions":["SWITCH_MODEL","SUBMIT_FEEDBACK","RETRY"]}
 *
 * The extracted `message` is only "too many requests", so the generic
 * `rate-limit` arm claimed it and cooled the account for the 15-minute fallback
 * — which the consecutive-failure ladder then doubled toward the one-hour
 * ceiling on every repeat. One busy model parked a healthy account for an hour
 * while the provider had itself offered "switch models" as the way to keep
 * working. Live evidence: 209 `kimi-k3.1-pro` events in one morning, all
 * `rate_limit_transient`, all on accounts that kept serving other models.
 *
 * The fix is three properties, each asserted below:
 *
 * 1. **Category** — `model_capacity`, the one category the writer scopes to
 *    `modelCooldowns[modelId]` and never to `status`/`cooldownUntil`.
 * 2. **Window** — the dedicated 5-minute fallback, not the 15-minute rate-limit
 *    one.
 * 3. **No escalation** — the streak must not multiply it, because saturation
 *    clears with upstream load rather than with our backoff.
 */
import { describe, expect, test } from "bun:test";
import { classifyAccountError, recordAccountFailure } from "../../src/providers/operations/account-health-service";
import { gatewayErrorFromStreamError } from "../../src/protocol/stream-error-frames";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";

/**
 * A drizzle-shaped double over one in-memory account row, chainable and
 * awaitable at each link the production write uses. Same shape as
 * `account-cooldown.test.ts`: the behavior under test is which values reach
 * `.set()`, and a real database would only obscure it.
 */
function dbDouble(account: Record<string, unknown>): {
  db: CartethyiaDatabase;
  updates: Record<string, unknown>[];
} {
  const updates: Record<string, unknown>[] = [];
  const client = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [account] }) }) }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        updates.push(payload);
        return { where: async () => undefined };
      },
    }),
    insert: () => ({ values: async () => undefined }),
  };
  const db = {
    ...client,
    transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  } as unknown as CartethyiaDatabase;
  return { db, updates };
}

/** The exact frame the buddy family sends, captured from the live gateway. */
function modelBusyFrame(): unknown {
  return {
    code: 14003,
    msg: "too many requests",
    requestId: "46683a97-9fa1-4c1e-9d76-5ac243a5aa70",
    displayMsg: {
      en: "Model busy. Please switch models or retry later",
      zh: "模型繁忙，请换模型或稍后重试",
    },
    displayTips: {
      en: "This model is currently saturated. It is not a network issue. Please switch to another model or wait a moment and retry.",
      zh: "这个模型当前请求量饱和，与你的网络无关。",
    },
    actions: ["SWITCH_MODEL", "SUBMIT_FEEDBACK", "RETRY"],
  };
}

function classify(providerId: string, modelId: string, scope: "provider" | "account" = "provider") {
  const error = gatewayErrorFromStreamError(modelBusyFrame(), providerId);
  if (error === undefined) throw new Error("Expected the frame to classify");
  return {
    error,
    classification: classifyAccountError(error, {
      origin: "upstream",
      scope,
      providerCode: "14003",
      providerId,
      modelId,
    }),
  };
}

describe("14003 model saturation — blast radius", () => {
  for (const providerId of ["cb", "workbuddy", "cbcn", "workbuddycn"]) {
    test(`${providerId}: classified as model_capacity, not a rate limit`, () => {
      const { classification } = classify(providerId, "kimi-k3.1-pro");
      expect(classification.category).toBe("model_capacity");
      expect(classification.status).toBe("cooldown");
    });
  }

  test("the window is the five-minute model-busy fallback", () => {
    const { classification } = classify("workbuddy", "kimi-k3.1-pro");
    expect(classification.cooldownMs).toBe(300_000);
  });

  test("the window is not multiplied by the consecutive-failure ladder", () => {
    // Saturation is upstream load, not a broken credential: a long streak must
    // not walk this toward the one-hour escalation ceiling.
    const { classification } = classify("workbuddy", "kimi-k3.1-pro");
    expect(classification.noEscalation).toBe(true);
  });

  test("an ordinary 429 is untouched by this rule", () => {
    // The narrow match matters: a bare "too many requests" with no model
    // remedy is a genuine rate limit, so it keeps the rate-limit arm and never
    // the model-scoped saturation window.
    //
    // Since upstream 2.8.5 a rate limit that states *no usable window* is a
    // skip rather than a fallback park: nothing about the account is cooled and
    // the audit row is the only record. That is why `cooldownMs` is 0 here —
    // the assertion that matters is the category and the absence of escalation.
    const classification = classifyAccountError(
      { message: "429 too many requests", status: 429 },
      { origin: "upstream", scope: "provider", statusCode: 429, providerId: "workbuddy", modelId: "kimi-k3.1-pro" },
    );
    expect(classification.category).toBe("rate_limit_transient");
    // Not the saturation verdict: the account-wide rate-limit fallback, and the
    // ladder is free to multiply it (unlike a saturated model's 5-minute
    // window, which clears with upstream load).
    expect(classification.cooldownMs).toBe(900_000);
    expect(classification.mutatesAccount).toBe(true);
    expect(classification.noEscalation).toBe(false);
  });

  test("the provider code alone does not trigger it", () => {
    // `14003` with no saturation wording and no SWITCH_MODEL action is a plain
    // throttle; keying on the code would cool every 14003 account-wide.
    const error = gatewayErrorFromStreamError({ code: 14003, msg: "too many requests" }, "workbuddy");
    if (error === undefined) throw new Error("Expected the frame to classify");
    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "provider",
      providerCode: "14003",
      providerId: "workbuddy",
      modelId: "kimi-k3.1-pro",
    });
    expect(classification.category).toBe("rate_limit_transient");
  });
});

describe("14003 model saturation — the write", () => {
  test("parks only the model pair and leaves the account status alone", async () => {
    const account: Record<string, unknown> = {
      id: "acc-1",
      status: "active",
      consecutiveFailures: 4,
      staticToken: false,
      cooldownUntil: null,
      modelCooldowns: {},
      modelBlockHits: {},
      lastError: null,
      lastErrorCategory: null,
      lastErrorAt: null,
    };
    const { db, updates } = dbDouble(account);
    const error = gatewayErrorFromStreamError(modelBusyFrame(), "workbuddy");
    if (error === undefined) throw new Error("Expected the frame to classify");

    const classification = await recordAccountFailure(db as never, "acc-1", error, {
      origin: "upstream",
      scope: "provider",
      providerCode: "14003",
      providerId: "workbuddy",
      modelId: "kimi-k3.1-pro",
    });

    expect(classification?.category).toBe("model_capacity");
    expect(updates).toHaveLength(1);
    const payload = updates[0]!;
    // Account-wide fields untouched: the sibling models must stay routable.
    expect("status" in payload).toBe(false);
    expect("cooldownUntil" in payload).toBe(false);
    const windows = payload["modelCooldowns"] as Record<string, string>;
    const minutes = (Date.parse(windows["kimi-k3.1-pro"]!) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(4);
    // Even with a streak of 4 the ladder is off, so it cannot have doubled.
    expect(minutes).toBeLessThan(6);
  });
});
