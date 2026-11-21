/**
 * A non-[CC] caller must never stamp its own User-Agent onto Anthropic traffic.
 *
 * Anthropic classifies the client from the request, and third-party OAuth
 * traffic is billed from extra usage — a hard 400 when that balance is empty.
 * Forwarding an inbound `opencode/...`, `cline/...` or `curl/...` User-Agent
 * therefore reclassified an otherwise-perfect [CC] request as third-party.
 * A genuine `claude-cli/...` value is still honoured for version fidelity.
 */
import { describe, expect, test } from "bun:test";
import { buildClaudeHeaders } from "../../src/providers/integrations/claude/claude-credentials";

const SECRET = new TextEncoder().encode("tok");

function userAgentFor(inbound: string | undefined): string | undefined {
  const headers = buildClaudeHeaders(SECRET, undefined, {
    credential_kind: "oauth",
    ...(inbound === undefined ? {} : { request_headers: { "user-agent": inbound } }),
  });
  return headers["User-Agent"];
}

describe("[CC] outbound User-Agent", () => {
  test("a foreign client name is replaced by the [CC] identity", () => {
    const ua = userAgentFor("opencode/latest/2.3.2/cli");
    expect(ua?.startsWith("claude-cli/")).toBe(true);
    expect(ua).not.toContain("opencode");
  });

  test("other third-party clients are replaced too", () => {
    for (const ua of ["cline/3.1.0", "curl/8.5.0", "Go-http-client/2.0"]) {
      const out = userAgentFor(ua);
      expect(out?.startsWith("claude-cli/")).toBe(true);
    }
  });

  test("a real claude-cli version is preserved", () => {
    const ua = userAgentFor("claude-cli/9.9.9 (external, cli)");
    expect(ua).toBe("claude-cli/9.9.9 (external, cli)");
  });

  test("no inbound UA still yields the canonical identity", () => {
    expect(userAgentFor(undefined)?.startsWith("claude-cli/")).toBe(true);
  });
});
