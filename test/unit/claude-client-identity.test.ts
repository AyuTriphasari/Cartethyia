import { describe, expect, test } from "bun:test";
import {
  claudeDeviceId,
  claudeSessionId,
  ensureClaudeClientMetadata,
  isClaudeClientUserId,
} from "../../src/providers/operations/claude-client-identity";

const DEVICE = "a".repeat(64);
const SESSION = "11111111-2222-3333-4444-555555555555";

describe("isClaudeClientUserId", () => {
  test("accepts the [CC]-shaped JSON identity", () => {
    expect(isClaudeClientUserId(JSON.stringify({ device_id: DEVICE, session_id: SESSION }))).toBe(true);
    expect(
      isClaudeClientUserId(JSON.stringify({ device_id: DEVICE, account_uuid: "", session_id: SESSION })),
    ).toBe(true);
  });

  test("rejects everything the [CC]-only gate rejected live", () => {
    // Measured 403 cases: plain string, bare hex, device-only, session-only.
    expect(isClaudeClientUserId(undefined)).toBe(false);
    expect(isClaudeClientUserId("user-123")).toBe(false);
    expect(isClaudeClientUserId(DEVICE)).toBe(false);
    expect(isClaudeClientUserId(JSON.stringify({ device_id: DEVICE }))).toBe(false);
    expect(isClaudeClientUserId(JSON.stringify({ session_id: SESSION }))).toBe(false);
    expect(isClaudeClientUserId(JSON.stringify([DEVICE, SESSION]))).toBe(false);
    expect(isClaudeClientUserId("not json")).toBe(false);
  });
});

describe("ensureClaudeClientMetadata", () => {
  test("stamps metadata when the caller sent none", () => {
    const payload: Record<string, unknown> = { model: "m" };
    expect(ensureClaudeClientMetadata(payload, { account: "acct-1", conversation: "conv-1" })).toBe(true);
    expect(isClaudeClientUserId((payload.metadata as Record<string, unknown>).user_id)).toBe(true);
  });

  test("keeps a caller-supplied valid identity verbatim", () => {
    const supplied = JSON.stringify({ device_id: DEVICE, session_id: SESSION });
    const payload: Record<string, unknown> = { metadata: { user_id: supplied } };
    expect(ensureClaudeClientMetadata(payload, { account: "acct-1" })).toBe(false);
    expect((payload.metadata as Record<string, unknown>).user_id).toBe(supplied);
  });

  test("replaces a non-conforming user_id but preserves sibling metadata keys", () => {
    const payload: Record<string, unknown> = { metadata: { user_id: "user-123", trace: "abc" } };
    expect(ensureClaudeClientMetadata(payload, { account: "acct-1" })).toBe(true);
    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata.trace).toBe("abc");
    expect(isClaudeClientUserId(metadata.user_id)).toBe(true);
  });

  test("device id is stable per account and differs across accounts", () => {
    expect(claudeDeviceId("acct-1")).toBe(claudeDeviceId("acct-1"));
    expect(claudeDeviceId("acct-1")).not.toBe(claudeDeviceId("acct-2"));
    expect(claudeDeviceId("acct-1")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("session id follows the conversation, not the request", () => {
    expect(claudeSessionId("acct-1", "conv-1")).toBe(claudeSessionId("acct-1", "conv-1"));
    expect(claudeSessionId("acct-1", "conv-1")).not.toBe(claudeSessionId("acct-1", "conv-2"));
    expect(claudeSessionId("acct-1", "conv-1")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
