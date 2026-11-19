/**
 * One-shot: move every `opencode-zen` API key out of 9router's SQLite into
 * Cartethyia's `opencode-zen` provider (opencode.ai, Zen credits).
 *
 * Usage: bun scripts/import-opencode-zen-from-9router.ts [--apply]
 *
 * Reads /root/opencode_zen_9router_dump.json (produced with
 *   sqlite3 -json /root/.9router/db/data.sqlite "select id,provider,authType,name,email,isActive,priority,data from providerConnections where provider='opencode-zen'")
 * and creates one Cartethyia account per row through the same
 * DrizzleProviderCatalogStore.createAccount path the console uses, so
 * encryption, fingerprinting, credential-kind detection, and the sort index are
 * all handled by the canonical owner rather than reimplemented here.
 *
 * A 9router opencode-zen row is an `apikey` credential (`data.apiKey`, no
 * refresh token), so it lands as credentialKind=api_key.
 *
 * Dedupe is on the key itself: two 9router rows share one key, and
 * `provider_accounts` rejects a duplicate credential fingerprint anyway. The
 * first row wins.
 *
 * isActive=1 → status active, isActive=0 → status disabled.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { DrizzleProviderCatalogStore } from "../src/console/providers/catalog/store";
import { ProviderRegistry } from "../src/providers/provider-registry";
import { createPgHandle } from "../src/persistence/db-pg";
import { providerAccounts, tenants } from "../src/persistence/schema";

const DUMP = "/root/opencode_zen_9router_dump.json";
const PROVIDER_ID = "opencode-zen";
const apply = process.argv.includes("--apply");

interface NineRow {
  readonly id: string;
  readonly provider: string;
  readonly authType: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly isActive: number;
  readonly priority: number | null;
  readonly data: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface Planned {
  readonly label: string;
  readonly status: "active" | "disabled";
  readonly secret: string;
  readonly accountEmail: string | undefined;
}

const rows = JSON.parse(readFileSync(DUMP, "utf8")) as NineRow[];
const planned: Planned[] = [];
const skipped: string[] = [];
const seen = new Set<string>();

for (const row of rows) {
  if (row.provider !== "opencode-zen") continue;
  const data = record(JSON.parse(row.data));
  const apiKey = text(data?.["apiKey"]) ?? text(data?.["accessToken"]);
  if (apiKey === undefined) {
    skipped.push(`opencode-zen · ${row.name ?? row.id} (no credential in the row)`);
    continue;
  }
  if (seen.has(apiKey)) {
    skipped.push(`opencode-zen · ${row.name ?? row.id} (duplicate key in dump)`);
    continue;
  }
  seen.add(apiKey);
  planned.push({
    label: text(row.name) ?? `opencode-zen-${planned.length + 1}`,
    status: row.isActive === 1 ? "active" : "disabled",
    secret: apiKey,
    accountEmail: text(row.email),
  });
}

const active = planned.filter((p) => p.status === "active").length;
console.log(`planned: ${planned.length} (${active} active, ${planned.length - active} disabled)`);
console.log(`skipped: ${skipped.length}`);
for (const note of skipped.slice(0, 20)) console.log(`  skip: ${note}`);

if (!apply) {
  console.log("\ndry run — pass --apply to write");
  process.exit(0);
}

const handle = createPgHandle();
const tenantId = process.env.TENANT_ID;
const [tenant] = tenantId === undefined
  ? await handle.db.select({ id: tenants.id }).from(tenants).limit(1)
  : [{ id: tenantId }];
if (tenant === undefined) throw new Error("no tenant row: run setup first");

const store = new DrizzleProviderCatalogStore(handle.db, {
  telemetryBuffer: { enqueue() {} } as never,
  bundledModelCatalog: { modelsByProvider: new Map() },
  providerRegistry: new ProviderRegistry(),
  outboundFetchFor: async () => ({ fetch }) as never,
  snapshotInvalidator: { invalidate() {} },
});

let created = 0;
const failures: string[] = [];
for (const item of planned) {
  try {
    const account = await store.createAccount(tenant.id, PROVIDER_ID, {
      label: item.label,
      credentialKind: "api_key",
      secret: item.secret,
    });
    if (item.accountEmail !== undefined) {
      await handle.db
        .update(providerAccounts)
        .set({ accountEmail: item.accountEmail })
        .where(eq(providerAccounts.id, account.id));
    }
    if (item.status === "disabled") {
      await handle.db
        .update(providerAccounts)
        .set({ status: "disabled" })
        .where(eq(providerAccounts.id, account.id));
    }
    created += 1;
  } catch (error) {
    failures.push(`${item.label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\ncreated ${created}/${planned.length}`);
if (failures.length > 0) {
  console.log(`failed ${failures.length}:`);
  for (const line of failures.slice(0, 40)) console.log(`  ${line}`);
}
await handle.close?.();
process.exit(failures.length > 0 ? 1 : 0);
