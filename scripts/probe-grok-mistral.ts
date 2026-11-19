/**
 * Mint a throwaway inbound key, probe the grok + mistral model matrix, delete
 * the key. Prints status/latency/content only — never a credential.
 *
 *   /root/.bun14/bin/bun scripts/probe-grok-mistral.ts
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createPgHandle } from "../src/persistence/db-pg";
import { apiKeys, tenants } from "../src/persistence/schema";
import { hashSecret } from "../src/security/crypto";

const BASE = "http://127.0.0.1:12800";
const MODELS = [
  "grok/grok-4.7",
  "grok/grok-4.6",
  "mistral/mistral-medium-latest",
  "mistral/codestral-latest",
  "mistral/mistral-large-latest",
];

const handle = createPgHandle();
const [tenant] = await handle.db.select({ id: tenants.id }).from(tenants).limit(1);
if (tenant === undefined) throw new Error("no tenant");

const secret = `pn-carte-probe-${randomBytes(16).toString("hex")}`;
const [row] = await handle.db
  .insert(apiKeys)
  .values({
    tenantId: tenant.id,
    keyHash: hashSecret(secret),
    label: "probe-grok-mistral",
    scopes: ["routing:invoke"],
  })
  .returning();
if (row === undefined) throw new Error("key insert failed");

try {
  for (const model of MODELS) {
    const started = Date.now();
    try {
      const response = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "reply with the single word PONG" }],
          max_tokens: 64,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const body = (await response.json()) as Record<string, unknown>;
      const choices = body["choices"] as Array<Record<string, unknown>> | undefined;
      const message = (choices?.[0]?.["message"] ?? {}) as Record<string, unknown>;
      const content = message["content"] ?? null;
      const reasoning = message["reasoning_content"] ?? null;
      const error = body["error"] ? JSON.stringify(body["error"]).slice(0, 170) : "";
      console.log(
        `${model.padEnd(32)} ${response.status} ${String(Date.now() - started).padStart(6)}ms ` +
          `content=${JSON.stringify(content)?.slice(0, 50) ?? "null"} reasoning=${reasoning ? "yes" : "no"} ${error}`,
      );
    } catch (error) {
      console.log(`${model.padEnd(32)} THROW ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await handle.db.delete(apiKeys).where(eq(apiKeys.id, row.id));
  await handle.close?.();
  console.log("probe key deleted");
}
