/**
 * One-shot: move every `grok-cli` account out of 9router's SQLite into
 * Cartethyia's `grok` provider (Grok Build CLI, cli-chat-proxy.grok.com).
 *
 * Usage: bun scripts/import-grokcli-from-9router.ts [--apply]
 *
 * Reads /root/grokcli_9router_dump.json (produced with
 *   sqlite3 -json /root/.9router/db/data.sqlite "select id,provider,authType,name,email,isActive,priority,data from providerConnections where provider='grok-cli'")
 * and creates one Cartethyia account per row through the same
 * DrizzleProviderCatalogStore.createAccount path the console uses, so
 * encryption, fingerprinting, credential-kind detection, and the OAuth state
 * row are all handled by the canonical owner rather than reimplemented here.
 *
 * Mapping:
 *   grok-cli → grok   (both are the xAI Grok Build / CLI device-code OAuth
 *                      surface: same client id, same auth.x.ai issuer, same
 *                      cli-chat-proxy.grok.com host)
 *
 * The pasted credential is the console's own single-JSON-object shape:
 *   { accessToken, refreshToken, expiresAt, providerSpecificData: { userId, ... } }
 * `providerSpecificData.userId` is what the grok adapter stamps as
 * `x-grok-user-id` on every request, so carrying it is wire fidelity, not
 * decoration.
 *
 * isActive=1 → status active, isActive=0 → status disabled, so a parked
 * account cannot start serving traffic the moment it lands.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { DrizzleProviderCatalogStore } from "../src/console/providers/catalog/store";
import { ProviderRegistry } from "../src/providers/provider-registry";
import { createPgHandle } from "../src/persistence/db-pg";
import { providerAccounts, tenants } from "../src/persistence/schema";

const DUMP = "/root/grokcli_9router_dump.json";
const PROVIDER_ID = "grok";
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
  readonly nineId: string;
  readonly label: string;
  readonly status: "active" | "disabled";
  readonly secret: string;
  readonly accountEmail: string | undefined;
}

const rows = JSON.parse(readFileSync(DUMP, "utf8")) as NineRow[];
const planned: Planned[] = [];
const skipped: string[] = [];

for (const row of rows) {
  if (row.provider !== "grok-cli") {
    skipped.push(`${row.provider} · ${row.name ?? row.id}`);
    continue;
  }
  const data = record(JSON.parse(row.data));
  if (data === undefined) {
    skipped.push(`grok-cli · ${row.name ?? row.id} (unparseable data)`);
    continue;
  }
  const accessToken = text(data["accessToken"]);
  const refreshToken = text(data["refreshToken"]);
  if (accessToken === undefined || refreshToken === undefined) {
    skipped.push(`grok-cli · ${row.name ?? row.id} (no refreshable oauth pair)`);
    continue;
  }
  const psd = record(data["providerSpecificData"]) ?? {};
  // Everything the adapter or a future refresh needs, in the keys the store's
  // `pastedAuthState()` already reads.
  const providerSpecificData: Record<string, unknown> = {};
  for (const key of ["userId", "email", "authMethod", "hasGrokCodeAccess", "subscriptionTier"]) {
    const value = psd[key] ?? data[key];
    if (value !== undefined && value !== null) providerSpecificData[key] = value;
  }
  const expiresAt = text(data["expiresAt"]);
  planned.push({
    nineId: row.id,
    label: text(row.name) ?? text(row.email) ?? `grok-${planned.length + 1}`,
    status: row.isActive === 1 ? "active" : "disabled",
    secret: JSON.stringify({
      accessToken,
      refreshToken,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      providerSpecificData,
    }),
    accountEmail: text(row.email) ?? text(psd["email"]) ?? text(data["email"]),
  });
}

const active = planned.filter((p) => p.status === "active").length;
console.log(`planned: ${planned.length} (${active} active, ${planned.length - active} disabled)`);
console.log(`skipped: ${skipped.length}`);
for (const note of skipped.slice(0, 20)) console.log(`  skip: ${note}`);
const dupLabels = planned.length - new Set(planned.map((p) => p.label)).size;
console.log(`duplicate labels in plan: ${dupLabels}`);

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
      credentialKind: "oauth",
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
