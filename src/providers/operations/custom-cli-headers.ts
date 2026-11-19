/**
 * Custom provider CLI identity headers.
 *
 * Emits official CLI headers for OpenAI-compatible (Codex CLI) and
 * Anthropic-compatible (Claude Code CLI) endpoints so upstream requests
 * reflect realistic first-party tooling instead of naked node/bun user agents.
 *
 * Both sides read their version from the live resolver getters rather than the
 * frozen `claude-fingerprint` constants: those constants are evaluated once at
 * module load from the pinned fallback and never move, so a custom Anthropic
 * endpoint would have shipped the pinned Claude CLI version forever even after
 * discovery resolved a newer one. The getters are synchronous and TTL-cached,
 * so this costs a cache read per dispatch.
 */
import {
  getClaudeCliVersion,
  getClaudeSdkVersion,
  getCodexVersion,
} from "./client-versions";
import { buildCodexUserAgent } from "./cli-platform";
import type { WireFamily } from "../../protocol/canonical-model";

/** Builds Codex CLI identity headers for OpenAI-compatible wire families. */
export function buildCustomCodexCliHeaders(): Record<string, string> {
  const version = getCodexVersion();
  return {
    "user-agent": buildCodexUserAgent(version),
    originator: "codex_cli_rs",
  };
}

/**
 * The Claude Code User-Agent, on the live CLI version.
 *
 * This is the route-level default for a provider whose operator set no client
 * identity of their own: a bare API key identifies as the Claude Code CLI
 * rather than as nothing. The Codex CLI identity (`codex_cli_rs/…`) would name
 * a different vendor's client on requests that most often reach neither — an
 * upstream that keys on the client string would act on it.
 *
 * The version comes from the live getter for the same reason
 * {@link buildCustomClaudeCliHeaders} does: the pinned `claude-fingerprint`
 * constants are evaluated once at module load and never move, so a default
 * built from them would send a Claude CLI version the client stopped shipping
 * and still answer to.
 */
export function buildClaudeCliUserAgent(): string {
  return `claude-cli/${getClaudeCliVersion()} (external, cli)`;
}

/**
 * The [CC] CLI's non-interactive SDK user-agent — what `claude -p` (and every
 * SDK embedding) actually sends: `claude-cli/<version> (external, sdk-cli)`.
 *
 * The distinction is not cosmetic. Some relays gate a whole group on
 * "only [CC] clients" and match this suffix; `(external, cli)` is refused
 * while `(external, sdk-cli)` is accepted, measured 2026-11-17 against
 * `vvvvvip.tststs.shop` (see `claude-client-identity.ts` for the full matrix).
 */
export function buildClaudeSdkCliUserAgent(): string {
  return `claude-cli/${getClaudeCliVersion()} (external, sdk-cli)`;
}

/**
 * Beta tokens a [CC] CLI request carries. `claude-code-20250219` is the one
 * that marks the request as CLI traffic; upstreams that do not implement a
 * beta ignore unknown tokens rather than rejecting the body.
 */
export const CLAUDE_CLI_BETA = "claude-code-20250219";

/** Builds [CC] CLI identity headers for Anthropic-compatible wire families. */
export function buildCustomClaudeCliHeaders(): Record<string, string> {
  return {
    "User-Agent": buildClaudeSdkCliUserAgent(),
    "x-app": "cli",
    // `anthropic-version` is not decoration here: a relay that gates a group on
    // "only [CC] clients" refuses the request when it is absent, and that single
    // missing header was the whole reason the CLI identity never took effect
    // (measured 2026-11-17: same body + same headers minus this = 403, with it =
    // accepted).
    "anthropic-version": "2023-06-01",
    "anthropic-beta": CLAUDE_CLI_BETA,
    "anthropic-dangerous-direct-browser-access": "true",
    "x-stainless-package-version": getClaudeSdkVersion(),
    "x-stainless-runtime": "node",
    "x-stainless-retry-count": "0",
  };
}

/**
 * Returns the appropriate CLI headers based on target wire family.
 * Messages wire family gets Claude CLI headers; chat / responses get Codex CLI headers.
 */
export function resolveCustomCliHeaders(wireFamily: WireFamily): Record<string, string> {
  if (wireFamily === "messages") {
    return buildCustomClaudeCliHeaders();
  }
  return buildCustomCodexCliHeaders();
}
