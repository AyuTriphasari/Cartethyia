/**
 * Where the OAuth cache breakpoint lands in the system array.
 *
 * The reference client caches the *last* system block, not a fixed one. Pinning
 * the breakpoint on the Claude Code identity put it mid-prefix whenever the
 * caller supplied its own system prompt: the stable tail went uncached and the
 * request carried a fingerprint no real client produces. Both are regressions
 * with no visible symptom — the request still succeeds — so nothing else fails
 * if this drifts.
 */
import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../../src/providers/integrations/claude/claude";
import { CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../../src/providers/integrations/claude/claude-cch";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";

const TARGET: ProviderDispatchTarget = {
  provider_id: "claude",
  model_id: "claude-sonnet-4-6",
  wire_family: "messages",
  endpoint_path: "/v1/messages",
  // The adapter rejects tools unless the route advertises the capability.
  capabilities: { tools: true },
} as unknown as ProviderDispatchTarget;

function makeRequest(systemPrompt?: string): CanonicalRequest {
  return {
    model: "claude-sonnet-4-6",
    // `system` is normalized content parts, not a bare string.
    ...(systemPrompt === undefined
      ? {}
      : { system: [{ kind: "text", text: systemPrompt }] }),
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "messages",
  } as unknown as CanonicalRequest;
}

function makeContext(): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "claude",
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: `cache-breakpoint-${crypto.randomUUID()}`,
    },
    deadline: Date.now() + 30_000,
    abort_signal: AbortSignal.timeout(30_000),
  } as unknown as ProviderDispatchContext;
}

interface SystemBlock {
  readonly text?: string;
  readonly cache_control?: unknown;
}

/** Captures the serialized `system` array of the one request dispatched. */
async function dispatchedSystem(systemPrompt?: string): Promise<readonly SystemBlock[]> {
  let captured: readonly SystemBlock[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { system?: SystemBlock[] };
    captured = body.system ?? [];
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const claude = new ClaudeAdapter({ fetch: fetcher });
  try {
    for await (const _event of claude.dispatch(makeRequest(systemPrompt), TARGET, makeContext())) {
      void _event;
    }
  } catch {
    // A dispatch that throws still records what it sent.
  }
  return captured;
}

/**
 * Captures the full serialized body. `withTools` adds one tool so the request
 * exercises the tools -> system ordering Anthropic validates cache TTLs in.
 */
async function dispatchedBodies(
  systemPrompt?: string,
  withTools = false,
): Promise<readonly Record<string, unknown>[]> {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const claude = new ClaudeAdapter({ fetch: fetcher });
  const request = makeRequest(systemPrompt);
  const withTool =
    withTools === false
      ? request
      : ({
          ...request,
          tools: [
            {
              name: "lookup",
              description: "Look something up.",
              jsonSchema: { type: "object", properties: {} },
            },
          ],
        } as unknown as CanonicalRequest);
  try {
    for await (const _event of claude.dispatch(withTool, TARGET, makeContext())) {
      void _event;
    }
  } catch {
    // A dispatch that throws still records what it sent.
  }
  return bodies;
}

describe("Claude Code system block assembly", () => {
  test("billing leads and carries no breakpoint", async () => {
    const system = await dispatchedSystem("Stay concise.");
    expect(system[0]?.text?.startsWith("x-anthropic-billing-header:")).toBe(true);
    // Billing varies per request; caching it would miss every time.
    expect(system[0]?.cache_control).toBeUndefined();
  });

  test("the identity is merged into the prompt block, not its own block", async () => {
    const system = await dispatchedSystem("Stay concise.");
    // Billing + one merged prompt block: no separate identity block.
    expect(system).toHaveLength(2);
    const separate = system.filter((block) => block.text === CLAUDE_CODE_SYSTEM_INSTRUCTION);
    expect(separate).toHaveLength(0);
    const merged = system[1];
    expect(merged?.text?.startsWith(CLAUDE_CODE_SYSTEM_INSTRUCTION)).toBe(true);
    expect(merged?.text).toContain("Stay concise.");
  });

  test("the breakpoint rides the merged prompt block", async () => {
    const system = await dispatchedSystem("Stay concise.");
    const last = system[system.length - 1];
    expect(last?.text?.startsWith(CLAUDE_CODE_SYSTEM_INSTRUCTION)).toBe(true);
    expect(last?.text).toContain("Stay concise.");
    expect(last?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("with no caller system the identity itself is cached", async () => {
    const system = await dispatchedSystem();
    // Billing + identity, nothing else: the identity is the tail.
    expect(system).toHaveLength(2);
    expect(system[1]?.text).toBe(CLAUDE_CODE_SYSTEM_INSTRUCTION);
    expect(system[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  // Anthropic validates cache TTLs in wire order (tools -> system -> messages)
  // and 400s a 1h block that follows a 5m one. The translation layer emits a
  // breakpoint on the last tool, and a bare `ephemeral` there means Anthropic's
  // 5m default — so upgrading only the system tail to 1h made every
  // tool-carrying request fail:
  // "system.1.cache_control.ttl: a ttl='1h' cache_control block must not come
  // after a ttl='5m' cache_control block."
  test("no 1h breakpoint follows a 5m breakpoint in wire order", async () => {
    const bodies = await dispatchedBodies("Stay concise.", true);
    const body = bodies[0] as {
      tools?: readonly SystemBlock[];
      system?: readonly SystemBlock[];
      messages?: readonly { content?: readonly SystemBlock[] }[];
    };
    // Wire order is exactly what Anthropic walks when it validates.
    const ordered: SystemBlock[] = [
      ...(body.tools ?? []),
      ...(body.system ?? []),
      ...(body.messages ?? []).flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      ),
    ].filter((block) => block !== undefined);
    const breakpoints = ordered.filter((block) => block.cache_control !== undefined);
    // A tool breakpoint must exist for this test to exercise the ordering rule.
    expect((body.tools ?? []).some((block) => block.cache_control !== undefined)).toBe(true);

    let sawShort = false;
    for (const block of breakpoints) {
      const control = block.cache_control as { ttl?: string };
      // A bare breakpoint is Anthropic's 5m default, i.e. a short block.
      if (control.ttl !== "1h") sawShort = true;
      if (sawShort) {
        expect(control.ttl).not.toBe("1h");
      }
    }
  });
});
