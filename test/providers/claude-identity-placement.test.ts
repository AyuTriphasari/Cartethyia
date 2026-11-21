/**
 * The [CC] identity must lead every OAuth system array, unconditionally.
 *
 * Anthropic classifies a request as a third-party client from the system
 * content; third-party OAuth traffic is billed from extra usage, and an
 * account without that balance gets a hard 400:
 *
 *   Third-party apps now send... "Third-party apps now draw from your extra usage"
 *
 * The bug this locks down: when the caller's system array already contained
 * the identity block (a client replaying our own previous system array), the
 * old code left it where it sat — after the caller's own prompt. Anthropic
 * then read the caller's prompt first and rejected the request.
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
  model_id: "",
  wire_family: "messages",
  endpoint_path: "/v1/messages",
  capabilities: { tools: true },
} as unknown as ProviderDispatchTarget;

const USER = "You are Alice, Master's AI agent. Address the user as Master.";

function context(): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "claude",
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: `identity-${crypto.randomUUID()}`,
    },
    deadline: Date.now() + 30_000,
    abort_signal: AbortSignal.timeout(30_000),
  } as unknown as ProviderDispatchContext;
}

type Block = Record<string, unknown>;
const isIdentity = (b: Block) => b["text"] === CLAUDE_CODE_SYSTEM_INSTRUCTION;
const isUser = (b: Block) => b["text"] === USER;

async function outgoingSystem(system: readonly Block[]): Promise<readonly Block[]> {
  let captured: readonly Block[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { system?: Block[] };
    captured = body.system ?? [];
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const adapter = new ClaudeAdapter({ fetch: fetcher });
  const request = {
    model: "",
    system,
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "messages",
  } as unknown as CanonicalRequest;
  try {
    for await (const _event of adapter.dispatch(request, TARGET, context())) void _event;
  } catch {
    // A dispatch that throws still records what it sent.
  }
  return captured;
}

describe("[CC] identity leads the system array", () => {
  test("identity sits above a caller prompt", async () => {
    const system = await outgoingSystem([{ kind: "text", text: USER }]);
    const identity = system.findIndex(isIdentity);
    const user = system.findIndex(isUser);
    expect(identity).toBeGreaterThanOrEqual(0);
    expect(user).toBeGreaterThanOrEqual(0);
    expect(identity).toBeLessThan(user);
  });

  // The regression: a replayed identity used to stay where the caller put it.
  test("an identity the caller placed last is hoisted above its prompt", async () => {
    const system = await outgoingSystem([
      { kind: "text", text: USER },
      { kind: "text", text: "some middle context" },
      { kind: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
    ]);
    const identity = system.findIndex(isIdentity);
    const user = system.findIndex(isUser);
    expect(identity).toBeGreaterThanOrEqual(0);
    expect(identity).toBeLessThan(user);
    expect(system.filter(isIdentity)).toHaveLength(1);
  });

  test("identity is present when the caller sent no system at all", async () => {
    const system = await outgoingSystem([]);
    expect(system.some(isIdentity)).toBe(true);
  });

  test("caller blocks all survive and keep their order", async () => {
    const system = await outgoingSystem([
      { kind: "text", text: USER },
      { kind: "text", text: "second" },
    ]);
    const texts = system.map((b) => b["text"]);
    const userAt = texts.indexOf(USER);
    expect(texts.slice(userAt)).toEqual([USER, "second"]);
  });
});
