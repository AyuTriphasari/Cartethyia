import { describe, expect, test } from "bun:test";
import { buildAntigravityEnvelope } from "../../src/providers/integrations/antigravity/antigravity";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

/**
 * Antigravity answers `400 Requests ending with a model turn are not supported.`
 * for a transcript whose last turn is the model's own. A client replaying
 * history for a "continue" produces exactly that, and the same body ending on a
 * user turn succeeds — so the gateway has to close the transcript itself.
 */
function envelopeFor(messages: CanonicalRequest["messages"]): Record<string, unknown> {
  const request = {
    messages,
    generation_controls: {},
    reasoning: {},
  } as unknown as CanonicalRequest;
  const envelope = buildAntigravityEnvelope(
    request,
    undefined,
    "gemini-4-argon",
    "gemini-4-argon",
    {},
    "seed",
  );
  return envelope["request"] as Record<string, unknown>;
}

function roles(inner: Record<string, unknown>): string[] {
  return (inner["contents"] as Record<string, unknown>[]).map((turn) => String(turn["role"]));
}

function lastText(inner: Record<string, unknown>): string {
  const contents = inner["contents"] as Record<string, unknown>[];
  const parts = contents[contents.length - 1]!["parts"] as Record<string, unknown>[];
  return String(parts[0]!["text"]);
}

describe("antigravity: transcript must not end on a model turn", () => {
  test("a user-ending transcript is left untouched", () => {
    const inner = envelopeFor([{ role: "user", content: [{ kind: "text", text: "hi" }] }]);
    expect(roles(inner)).toEqual(["user"]);
  });

  test("an assistant-ending transcript gains a closing user turn", () => {
    const inner = envelopeFor([
      { role: "user", content: [{ kind: "text", text: "say ok" }] },
      { role: "assistant", content: [{ kind: "text", text: "ok" }] },
    ]);
    expect(roles(inner)).toEqual(["user", "model", "user"]);
    expect(lastText(inner)).toBe("Continue from your last message.");
  });

  test("multi-turn history ending on the model is closed once, not twice", () => {
    const inner = envelopeFor([
      { role: "user", content: [{ kind: "text", text: "a" }] },
      { role: "assistant", content: [{ kind: "text", text: "b" }] },
      { role: "user", content: [{ kind: "text", text: "c" }] },
      { role: "assistant", content: [{ kind: "text", text: "d" }] },
    ]);
    expect(roles(inner)).toEqual(["user", "model", "user", "model", "user"]);
  });
});
