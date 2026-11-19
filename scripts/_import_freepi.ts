/**
 * Import free-pi JWTs (from /root/github_acc/freepi_tokens.json) as accounts of
 * the `freepi` provider in cartethyia.
 *
 * Uses the console's own store path so encryption, fingerprint, kind detection
 * and the sort index are all handled exactly like the UI's "add account" flow.
 * A free-pi credential is a long-lived JWT with no refresh token, so it lands as
 * credentialKind=oauth with a static token (the store logs `static_token`).
 *
 *   bun run scripts/_import_freepi.ts            # dry run
 *   bun run scripts/_import_freepi.ts --apply
 */
import { readFileSync } from "node:fs";
import { DrizzleProviderCatalogStore } from "../src/console/providers/catalog/store";
import { ProviderRegistry } from "../src/providers/provider-registry";
import { createPgHandle } from "../src/persistence/db-pg";

const TOKENS_FILE = "/root/github_acc/freepi_tokens.json";
const TENANT_ID = "5cdd18c4-33f1-40e2-a226-3446c783818b";
const PROVIDER_ID = "freepi";
const apply = process.argv.includes("--apply");

const raw = JSON.parse(readFileSync(TOKENS_FILE, "utf8")) as Record<
  string,
  { token?: string; error?: string }
>;
const entries = Object.entries(raw).filter(([, v]) => typeof v.token === "string" && v.token.length > 0);

console.log(`tokens: ${entries.length} of ${Object.keys(raw).length} accounts`);
if (entries.length === 0) process.exit(1);

const handle = createPgHandle();
const store = new DrizzleProviderCatalogStore(handle.db, {
  telemetryBuffer: { enqueue() {} } as never,
  bundledModelCatalog: { modelsByProvider: new Map() },
  providerRegistry: new ProviderRegistry(),
  outboundFetchFor: () => fetch,
  snapshotInvalidator: { invalidate() {} },
});

let created = 0;
let failed = 0;
for (const [email, value] of entries) {
  const label = `gh:${email.split("@")[0]}`;
  if (!apply) {
    console.log(`  would create ${label}`);
    continue;
  }
  try {
    const account = await store.createAccount(TENANT_ID, PROVIDER_ID, {
      label,
      credentialKind: "oauth",
      credentialMode: "jwt",
      secret: value.token as string,
    });
    created += 1;
    console.log(`  created ${label} -> ${account.id}`);
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  FAILED ${label}: ${message}`);
  }
}
console.log(apply ? `created=${created} failed=${failed}` : "dry run — pass --apply");
await handle.close?.();
process.exit(0);
