#!/usr/bin/env bun
/**
 * Mints a throwaway gateway API key in the 3.9.0 test database and writes it to
 * `.smoke-key` (mode 600) instead of stdout, so the value never lands in a log.
 */
import { Client } from "pg";
import { hashSecret } from "../src/security/crypto";

const secret = `pn-carte-${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const tenant = await client.query<{ id: string }>("select id from tenants order by created_at limit 1");
if (tenant.rowCount === 0) throw new Error("no tenant in the target database");
const tenantId = tenant.rows[0].id;
const inserted = await client.query<{ id: string }>(
  `insert into api_keys (tenant_id, key_hash, key_prefix, label, scopes, model_access_mode)
   values ($1, $2, $3, $4, $5::jsonb, 'all')
   returning id`,
  [tenantId, hashSecret(secret), secret.slice(0, 12), "smoke-390", JSON.stringify(["platform:admin"])],
);
await require("node:fs").writeFileSync(".smoke-key", secret + "\n", { mode: 0o600 });
console.log(`minted key ${inserted.rows[0].id} for tenant ${tenantId} -> .smoke-key`);
await client.end();
