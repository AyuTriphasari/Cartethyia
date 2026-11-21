/**
 * The caller's system prompt stays ONE text block, with the [CC] identity
 * prefixed into that block's text.
 *
 * Anthropic classifies the request from its system content, and third-party
 * OAuth traffic is billed from extra usage — a hard 400 when that balance is
 * empty. A separate identity block next to a third-party prompt is not the
 * shape the reference client sends, so the identity is merged into the prompt
 * text itself. Billing stays its own leading block because the CCH patch
 * anchors on `system[0]`.
 */
import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../../src/providers/integrations/claude/claude";
import { CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../../src/providers/integrations/claude/claude-cch";
import { CLAUDE_BILLING_HEADER_PREFIX } from "../../src/protocol/codecs";
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

const USER = "You are an AI agent running in OpenCode, a coding agent harness.";

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
const text = (b: Block) => (typeof b["text"] === "string" ? (b["text"] as string) : "");

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

describe("[CC] system shape", () => {
  test("billing plus exactly one prompt block", async () => {
    const system = await outgoingSystem([{ kind: "text", text: USER }]);
    // Billing block + the single merged prompt block. No separate identity.
    expect(system).toHaveLength(2);
    expect(text(system[0] as Block).startsWith(CLAUDE_BILLING_HEADER_PREFIX)).toBe(true);
    expect(text(system[1] as Block).startsWith(CLAUDE_CODE_SYSTEM_INSTRUCTION)).toBe(true);
    expect(text(system[1] as Block)).toContain(USER);
  });

  test("identity is the first thing in the prompt text", async () => {
    const system = await outgoingSystem([{ kind: "text", text: USER }]);
    const prompt = text(system[1] as Block);
    expect(prompt.indexOf(CLAUDE_CODE_SYSTEM_INSTRUCTION)).toBe(0);
    expect(prompt.indexOf(USER)).toBeGreaterThan(0);
  });

  test("several caller blocks collapse into one text block", async () => {
    const system = await outgoingSystem([
      { kind: "text", text: USER },
      { kind: "text", text: "second" },
    ]);
    expect(system).toHaveLength(2);
    const prompt = text(system[1] as Block);
    expect(prompt).toContain(USER);
    expect(prompt).toContain("second");
  });

  test("identity is present when the caller sent no system at all", async () => {
    const system = await outgoingSystem([]);
    expect(system).toHaveLength(2);
    expect(text(system[1] as Block)).toBe(CLAUDE_CODE_SYSTEM_INSTRUCTION);
  });

  test("a caller-supplied identity is not duplicated", async () => {
    const system = await outgoingSystem([
      { kind: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
      { kind: "text", text: USER },
    ]);
    const prompt = text(system[1] as Block);
    const occurrences = prompt.split(CLAUDE_CODE_SYSTEM_INSTRUCTION).length - 1;
    expect(occurrences).toBe(1);
  });
});
