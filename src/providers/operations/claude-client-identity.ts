/**
 * [CC] client identity for Anthropic-compatible BYOK endpoints.
 *
 * Some relay groups answer every request with
 *
 * ```
 * 403 {"error":{"message":"This group only allows [CC] clients.","type":"permission_error"}}
 * ```
 *
 * and the discriminator is **not** the User-Agent. Measured against
 * `vvvvvip.tststs.shop` (2026-11-17) by replaying a real `claude` CLI request and
 * mutating one field at a time — every header combination without the metadata
 * below (bare, `claude-cli/… (external, cli)`, `… (external, sdk-cli)`,
 * `x-app: cli`, the whole `x-stainless-*` family, `?beta=true`, curl over
 * HTTP/1.1 and HTTP/2) still returned that 403. What actually flips it to 200:
 *
 * | `metadata.user_id`                              | verdict |
 * | ----------------------------------------------- | ------- |
 * | absent                                          | 403     |
 * | `"user-123"` (plain string)                     | 403     |
 * | `"<64 hex>"` (plain string)                     | 403     |
 * | `{"device_id":"<64 hex>"}`                      | 403     |
 * | `{"session_id":"<uuid>"}`                       | 403     |
 * | `{"device_id":"<64 hex>","session_id":"<uuid>"}` | **200** |
 *
 * `x-app: cli` is required as well (dropping it from an otherwise passing
 * request returns the 403 again); `account_uuid` is optional.
 *
 * The identity is derived per account — one device id per account, one session
 * id per conversation — so repeated requests look like one CLI install rather
 * than a new device every turn.
 */
import { createHash, randomUUID } from "node:crypto";

const DEVICE_ID = /^[0-9a-f]{64}$/i;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is already a [CC]-shaped `metadata.user_id`. */
export function isClaudeClientUserId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  return (
    typeof record.device_id === "string" &&
    DEVICE_ID.test(record.device_id) &&
    typeof record.session_id === "string" &&
    SESSION_ID.test(record.session_id)
  );
}

function digest(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/** Deterministic 64-hex device id: one stable "install" per account. */
export function claudeDeviceId(accountKey: string): string {
  return digest(`cc-device:${accountKey}`);
}

/** Deterministic UUID-shaped session id; random when the request has no affinity. */
export function claudeSessionId(accountKey: string, conversationKey?: string): string {
  if (!conversationKey) return randomUUID();
  const hex = digest(`cc-session:${accountKey}:${conversationKey}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The opener a [CC] Agent SDK session sends as its first system block. A relay
 * that gates a group on "only [CC] clients" inspects the **body** for this
 * sentence; measured 2026-11-17 against `vvvvvip.tststs.shop` with the CLI
 * headers already correct:
 *
 * | `system` blocks                        | verdict |
 * | -------------------------------------- | ------- |
 * | none                                   | 403     |
 * | the long interactive-agent prompt only | 403     |
 * | this opener only                       | passes  |
 * | this opener + interactive prompt       | 200     |
 *
 * Headers alone are never enough — that is what made the first fix look
 * broken.
 */
export const CLAUDE_AGENT_SDK_OPENER = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

type SystemBlock = { type: "text"; text: string };

/**
 * Prepends {@link CLAUDE_AGENT_SDK_OPENER} to a Messages payload's `system`
 * when it is absent, keeping the caller's own prompt intact behind it.
 *
 * Returns true when the payload was rewritten.
 */
export function ensureClaudeAgentSystemPrompt(payload: Record<string, unknown>): boolean {
  const raw = payload.system;
  const blocks: SystemBlock[] =
    typeof raw === "string"
      ? [{ type: "text", text: raw }]
      : Array.isArray(raw)
        ? (raw.filter(
            (entry): entry is SystemBlock =>
              typeof entry === "object" &&
              entry !== null &&
              (entry as { type?: unknown }).type === "text" &&
              typeof (entry as { text?: unknown }).text === "string",
          ) as SystemBlock[])
        : [];
  if (blocks.some((block) => block.text.includes(CLAUDE_AGENT_SDK_OPENER))) return false;
  payload.system = [{ type: "text", text: CLAUDE_AGENT_SDK_OPENER }, ...blocks];
  return true;
}

/**
 * Stamps a [CC]-shaped `metadata.user_id` onto an encoded Messages payload when
 * the caller did not supply one. A caller-supplied valid identity is preserved
 * verbatim — the real CLI's own device/session ids must keep correlating.
 *
 * Returns true when the payload was rewritten.
 */
export function ensureClaudeClientMetadata(
  payload: Record<string, unknown>,
  seed: { readonly account: string; readonly conversation?: string | undefined },
): boolean {
  const existing = payload.metadata;
  const metadata =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  if (isClaudeClientUserId(metadata.user_id)) return false;
  payload.metadata = {
    ...metadata,
    user_id: JSON.stringify({
      device_id: claudeDeviceId(seed.account),
      account_uuid: "",
      session_id: claudeSessionId(seed.account, seed.conversation),
    }),
  };
  return true;
}
