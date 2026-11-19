import { describe, expect, test } from "bun:test";
import { resolveQoderAuth } from "../../../src/providers/integrations/qoder/qoder-auth";

/**
 * A PAT carries no identity: the v1 exchange returns a job token only. The
 * COSY identity payload therefore has to name the account, and the only place
 * that id exists is `userinfo`. Measured live (2026-11-17) on ten PATs: signed
 * with the machine id the chat surface answers `403 {"code":"105","message":
 * "Login expired"}` for every model, signed with the `userinfo` id the same
 * request reaches the router. These tests pin the resolution order so a future
 * "simplification" cannot put the placeholder back.
 */
const PAT = "pt-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
/** Distinct secrets per case: the identity cache is keyed by the PAT. */
const PAT_FALLBACK = "pt-1111111111111111111111111111111111111111111111111111111111111111";
const PAT_NO_ID = "pt-2222222222222222222222222222222222222222222222222222222222222222";
const USER_ID = "01a1dfe2-c34e-74e0-8ede-3a12ab89ed8b";

function routedFetcher(handlers: {
  exchange: () => Response;
  userinfo: () => Response;
}): (url: string) => Promise<Response> {
  return async (url: string) => {
    if (url.includes("/jobToken/exchange")) return handlers.exchange();
    if (url.includes("/userinfo")) return handlers.userinfo();
    throw new Error(`unexpected url ${url}`);
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Qoder PAT identity resolution", () => {
  test("the userinfo id, not the machine id, signs the COSY identity", async () => {
    const auth = await resolveQoderAuth({
      secret: PAT,
      authState: undefined,
      signal: new AbortController().signal,
      fetcher: routedFetcher({
        exchange: () => json({ token: "jt-test", expires_in: 86400000 }),
        userinfo: () => json({ id: USER_ID, name: "toorespawnxo" }),
      }),
    });
    expect(auth.userId).toBe(USER_ID);
    expect(auth.userName).toBe("toorespawnxo");
    expect(auth.securityOauthToken).toBe("jt-test");
    // The device identity stays a machine id — only the account id moved.
    expect(auth.machineId).not.toBe(USER_ID);
    expect(auth.machineId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a failed userinfo lookup falls back to the machine id instead of failing the dispatch", async () => {
    const auth = await resolveQoderAuth({
      secret: PAT_FALLBACK,
      authState: undefined,
      signal: new AbortController().signal,
      fetcher: routedFetcher({
        exchange: () => json({ token: "jt-test" }),
        userinfo: () => new Response("", { status: 500 }),
      }),
    });
    expect(auth.userId).toBe(auth.machineId);
  });

  test("a userinfo body without an id is not mistaken for an identity", async () => {
    const auth = await resolveQoderAuth({
      secret: PAT_NO_ID,
      authState: undefined,
      signal: new AbortController().signal,
      fetcher: routedFetcher({
        exchange: () => json({ token: "jt-test" }),
        userinfo: () => json({ name: "no-id-here" }),
      }),
    });
    expect(auth.userId).toBe(auth.machineId);
  });
});
