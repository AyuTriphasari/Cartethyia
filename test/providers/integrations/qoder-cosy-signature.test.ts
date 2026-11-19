import { expect, test } from "bun:test";
import { callQoder, qoderSignerFor, transformQoderBody } from "../../../src/providers/integrations/qoder/qoder";
import type { QoderAuth } from "../../../src/providers/integrations/qoder/qoder";

/**
 * Pins the COSY signature canonicalization. Upstream verifies the Bearer
 * signature against a sorted-compact JSON serialization; building the payload
 * with plain `JSON.stringify` (insertion order) makes the signature mismatch
 * and the server answers `code 101 / Signature invalid`.
 */
const AUTH: QoderAuth = {
  userId: "u-01a185c9",
  userName: "test",
  userType: "personal_professional_trial",
  securityOauthToken: "dt-testtoken",
  refreshToken: "drt-testrefresh",
  machineId: "m-11111111-2222-3333-4444-555555555555",
};

test("COSY Bearer payload uses sorted-compact JSON (canonical)", () => {
  const url = "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
  const body = "encoded-body-bytes";

  const headers = qoderSignerFor(AUTH)(url, body);

  const authorization = headers.authorization;
  expect(authorization).toBeDefined();
  expect(authorization).toMatch(/^Bearer COSY\./);
  const payloadB64 = authorization!.split(".")[1];
  expect(payloadB64).toBeDefined();
  const payload = JSON.parse(Buffer.from(payloadB64!, "base64").toString("utf8"));

  // Canonical key order (sorted lexicographically), not insertion order.
  expect(Object.keys(payload)).toEqual(["cosyVersion", "ideVersion", "info", "requestId", "version"]);
  expect(payload.version).toBe("v1");
  expect(payload.ideVersion).toBe("");
  expect(typeof payload.info).toBe("string");
  expect(typeof payload.requestId).toBe("string");
});

test("COSY drops the bodyhash/bodylength/sigpath headers the worker core never sends", () => {
  const url = "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result";
  const headers = qoderSignerFor(AUTH)(url, "body");
  // The path signature is still folded into the md5 chain, but the
  // worker-core capture (2026-11-17) carries none of these as headers; the
  // upstream accepts the request without them (verified live: the same
  // request reaches the router instead of answering `101 Signature invalid`).
  expect(headers["cosy-sigpath"]).toBeUndefined();
  expect(headers["cosy-bodyhash"]).toBeUndefined();
  expect(headers["cosy-bodylength"]).toBeUndefined();
  expect(headers["cosy-organization-id"]).toBeUndefined();
  expect(headers["cosy-organization-tags"]).toBeUndefined();
});

test("COSY headers emit X-Qoder-HTTPDNS-IP only when the auth carries one", () => {
  const url = "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result";

  // No IP on the auth → header absent (same shape as a non-HTTPDNS client).
  const plain = qoderSignerFor(AUTH)(url, "body");
  expect(plain["X-Qoder-HTTPDNS-IP"]).toBeUndefined();

  // With the HTTPDNS-route IP stored → header emitted, mirroring the desktop
  // client's `networkMode=httpdns` worker state.
  const withIp = qoderSignerFor({ ...AUTH, httpDnsIp: "103.130.222.58" })(url, "body");
  expect(withIp["X-Qoder-HTTPDNS-IP"]).toBe("103.130.222.58");
});

test("COSY headers mirror the desktop-worker capture (clienttype/business/scene/UA/accept-encoding/trace)", () => {
  const url = "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
  const headers = qoderSignerFor(AUTH)(url, "body");

  // Desktop-worker capture 2026-11-11 (app 0.5.7 / worker 1.1.79-hotfix.19).
  expect(headers["cosy-clienttype"]).toBe("10");
  expect(headers["cosy-business-product"]).toBe("app");
  expect(headers["cosy-scene"]).toBe("app");
  expect(headers["user-agent"]).toBe("undici");
  expect(headers["accept-encoding"]).toBe("br, gzip, deflate");
  expect(headers["accept-language"]).toBe("*");
  expect(headers["sec-fetch-mode"]).toBe("cors");
  expect(headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test("callQoder sends the plain scrambled body the Encode=1 surface decodes", async () => {
  const url = "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
  let captured: { headers: Headers; body: Uint8Array } | undefined;
  const fetcher = async (_url: string, init: RequestInit) => {
    captured = {
      headers: new Headers(init.headers),
      body: init.body as Uint8Array,
    };
    return new Response("", { status: 200 });
  };

  const payload = { model: "cmodel", model_config: { key: "cmodel", source: "system" }, stream: true };
  await callQoder(url, payload, "cmodel", AUTH, new AbortController().signal, fetcher);

  expect(captured).toBeDefined();
  // No zstd layer: measured live (2026-11-17) the `Encode=1` surface decodes
  // the plain scramble and answers `101 Signature invalid` when the body is
  // compressed, because the signature is verified over the scrambled bytes.
  expect(captured!.headers.get("content-encoding")).toBeNull();
  const body = captured!.body;
  expect(body).toBeInstanceOf(Uint8Array);
  expect([...body.slice(0, 4)]).not.toEqual([0x28, 0xb5, 0x2f, 0xfd]);
  const expectedScrambled = transformQoderBody(JSON.stringify(payload));
  expect(Buffer.from(body).equals(Buffer.from(expectedScrambled))).toBe(true);
});
