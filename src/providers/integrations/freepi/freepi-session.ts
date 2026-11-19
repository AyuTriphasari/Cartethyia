// Free-pi session identity and connection-bound history repair.
//
// Free-pi binds a conversation's native items (tool_call_id / assistant tool
// calls) to the `x-session-id` that opened it. Reusing one session id across
// unrelated conversations, or carrying a stale affinity onto a new account,
// makes the upstream answer "does not belong to this session". The donor's
// rule for connection-bound history (oh-my-pi's Copilot compat) is to rebuild
// prior turns from message content when the connection changes.
//
// So: ONE session per account, exactly like a real CLI terminal holds one for
// its whole life. Keying by conversation or model instead burns the account's
// four-session budget (the upstream allows 4 concurrent CLI sessions per
// signed-in account) and starts answering `409 concurrent_session` after four
// conversations — measured live on ten fresh accounts, where a per-model key
// hit the cap within three probe calls.
//
// On a session-ownership refusal, rotate the session (a fresh nonce, so a new
// id) and rebase the transcript into plain messages before one bounded retry.
import { createHash, randomUUID } from "node:crypto";
import type { CanonicalRequest, CanonicalMessage, ContentPart } from "../../../protocol/canonical-model";
import { resolvePromptCacheKey } from "../../operations/session-resolution";
import type { ProviderDispatchContext } from "../../provider-contracts";

/** Stable, non-reversible identity of one free-pi session owner. */
export interface FreepiSessionOwner {
  readonly credential: string;
  readonly affinity: string | undefined;
  /** Account id is part of the scope: a new account must never inherit a session. */
  readonly accountId: string;
  readonly modelId: string;
  /** Digest of the owner, used as the bounded map key (no live JWT in keys). */
  readonly key: string;
}

/** Builds one session owner from the dispatch inputs. */
export function freepiSessionOwner(input: {
  readonly secret: string;
  readonly context: ProviderDispatchContext;
  readonly request: CanonicalRequest;
  readonly modelId: string;
}): FreepiSessionOwner {
  const affinity = resolvePromptCacheKey(input.request, input.context) ?? input.context.conversation_affinity;
  const accountId = input.context.credential.account_id ?? "";
  // Account-scoped, not conversation-scoped: modelId and affinity stay on the
  // owner for diagnostics but never in the key.
  const key = createHash("sha256")
    .update(JSON.stringify([input.secret, accountId]))
    .digest("hex")
    .slice(0, 32);
  return { credential: input.secret, affinity, accountId, modelId: input.modelId, key };
}

/** Deterministic UUIDv4-shaped session id for one owner (stable across restarts). */
export function freepiSessionIdFor(owner: FreepiSessionOwner): string {
  // The account is the scope, so the id must not depend on the conversation —
  // otherwise a restart (or a different first chat) derives a different id and
  // leaks another of the four slots. Only a rotated owner (`fresh-…`, minted
  // after an ownership refusal) carries a nonce into the derivation, which is
  // what makes the retry land on a genuinely new session.
  const rotated = owner.affinity?.startsWith("fresh-") === true;
  const digest = createHash("sha256")
    .update(JSON.stringify(["freepi-session", owner.credential, owner.accountId,
      rotated ? owner.affinity : ""]))
    .digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

/** Returns a new owner whose affinity (and thus session key) cannot collide. */
export function withFreshFreepiAffinity(owner: FreepiSessionOwner): FreepiSessionOwner {
  const affinity = `fresh-${randomUUID()}`;
  // The nonce is what makes the rotated key different from the account key.
  const key = createHash("sha256")
    .update(JSON.stringify([owner.credential, owner.accountId, affinity]))
    .digest("hex")
    .slice(0, 32);
  return { ...owner, affinity, key };
}

/** Bounded, per-owner sessions. */
export interface FreepiSessionEntry {
  readonly sessionId: string;
  readonly owner: FreepiSessionOwner;
  /** True until the session's ad registration has been attempted once. */
  fresh: boolean;
}

const FREEPI_SESSION_CACHE_MAX = 256;

export class FreepiSessionRegistry {
  readonly #sessions = new Map<string, FreepiSessionEntry>();

  /** Existing session for this owner, or a freshly minted one. */
  get(owner: FreepiSessionOwner): FreepiSessionEntry {
    const existing = this.#sessions.get(owner.key);
    if (existing !== undefined) {
      // Touch for LRU: the map is small, but a long-lived process must not
      // pin a stale affinity forever.
      this.#sessions.delete(owner.key);
      const touched: FreepiSessionEntry = { ...existing, fresh: false };
      this.#sessions.set(owner.key, touched);
      return touched;
    }
    // Derived from the owner, not random: the upstream counts CLI sessions per
    // account and allows four, so a random id per process leaks one slot per
    // restart — four deploys and the account answers `409 concurrent_session`
    // while serving nothing. A real CLI keeps one id for the life of its
    // terminal, which is what this reproduces across our restarts.
    const entry: FreepiSessionEntry = {
      sessionId: freepiSessionIdFor(owner),
      owner,
      fresh: true,
    };
    this.#sessions.set(owner.key, entry);
    if (this.#sessions.size > FREEPI_SESSION_CACHE_MAX) {
      const oldest = this.#sessions.keys().next();
      if (!oldest.done) this.#sessions.delete(oldest.value);
    }
    return entry;
  }

  /** Drops one owner's session; the next call mints a fresh one. */
  rotate(owner: FreepiSessionOwner): FreepiSessionEntry {
    this.#sessions.delete(owner.key);
    return this.get(owner);
  }

  /** Test seam. */
  get size(): number {
    return this.#sessions.size;
  }
}

/** Upstream refusal shapes that say a native item/session belongs elsewhere. */
const SESSION_OWNERSHIP_REFUSAL = /(?:does not|doesn't|not) belong to|belongs to (?:another|a different)|session (?:mismatch|expired|invalid)|invalid session|unknown session|stale session|tool_call_id.*(?:unknown|invalid|mismatch)|not (?:found|valid) for (?:this )?session/i;

/** True when an upstream error is a session/connection ownership refusal. */
export function isFreepiSessionOwnershipError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = (error as Error & { details?: Readonly<Record<string, unknown>> }).details;
  if (details?.["freepi_session_mismatch"] === true) return true;
  const raw = typeof details?.["raw"] === "string" ? details["raw"] : "";
  const message = `${error.message} ${raw}`;
  return SESSION_OWNERSHIP_REFUSAL.test(message);
}

/**
 * Rebases a connection-bound transcript into plain messages: a fresh session
 * has never seen the old `tool_call_id`s, so replaying them verbatim is exactly
 * what the upstream refuses. Prior tool calls and their results become text in
 * the same conversation order (the donor's cold-session rebuild rule).
 */
export function rebaseFreepiRequest(request: CanonicalRequest): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  for (const message of request.messages) {
    const parts: ContentPart[] = [];
    let native = false;
    for (const part of message.content) {
      if (part.kind === "toolCall") {
        native = true;
        const args = typeof part.arguments === "string" ? part.arguments : JSON.stringify(part.arguments ?? {});
        parts.push({ kind: "text", text: `[Earlier tool call ${part.name}: ${args}]` });
        continue;
      }
      if (part.kind === "toolResult") {
        native = true;
        const text = typeof part.content === "string"
          ? part.content
          : part.content.map((child) => (child.kind === "text" ? child.text : "")).join("\n");
        parts.push({ kind: "text", text: `[Earlier tool result: ${text}]` });
        continue;
      }
      parts.push(part);
    }
    // Keep the role, but collapse a native tool message onto a user/assistant
    // text turn so no orphan `tool_call_id` reaches the fresh session.
    const role = native && message.role === "tool" ? "user" : message.role;
    messages.push({ ...message, role, content: parts });
  }
  return {
    ...request,
    messages,
    generation_controls: {
      ...request.generation_controls,
      // The old cache affinity is bound to the old session: drop it so the
      // fresh session starts with a clean prefix.
      "extension:prompt_cache_key": undefined,
      "extension:responses.prompt_cache_key": undefined,
      "extension:metadata_user_id": undefined,
    },
  };
}
