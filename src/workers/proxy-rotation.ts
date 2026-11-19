// Rotating upstream proxy sweep.
//
// `network_pools` is the gateway's entire egress policy: a dispatch leaves
// through one of those rows, chosen per request. A vendor that sells a single
// rotating address therefore has to be projected into that table continuously
// — the address the vendor currently hands out is the only one that can be
// dialled, and the one it replaced is already dead.
//
// Rotation here is replace-not-accumulate: the family this task owns is emptied
// and refilled in one transaction, so a retired address can never linger in the
// table and be picked for a request. Rows belonging to any other family are
// untouched — this task owns its tag, not the table.
//
// Registered as a ScheduledTaskRegistry task so the registry owns interval and
// re-entrancy; this function owns only the domain work.
import { and, eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { networkPools, tenants } from "../persistence/schema";
import { encryptCredential } from "../security/crypto";
import { log } from "../observability/logger";

/** Vendor answer shape. `proxyhttp` is `host:port[:user:pass]`. */
interface RotationAnswer {
  readonly status?: number;
  readonly message?: string;
  readonly proxyhttp?: string;
  readonly proxysocks5?: string;
  /** Vendor's carrier label, e.g. `fpt`; purely informational. */
  readonly "Nha Mang"?: string;
  /** Vendor's location label, e.g. `HaiDuong1`; purely informational. */
  readonly "Vi Tri"?: string;
}

/** One parsed dial target out of the vendor's answer. */
export interface RotatedProxy {
  /** Dials as an HTTP CONNECT proxy, e.g. `http://1.2.3.4:8080`. */
  readonly endpoint: string;
  /** `user:pass` when the vendor embeds one, otherwise undefined. */
  readonly credential?: string;
  /** Vendor-supplied carrier/location, kept as the pool's family label detail. */
  readonly note?: string;
}

export interface ProxyRotationSweepDeps {
  readonly db: CartethyiaDatabase;
  /** Vendor endpoint that answers with the current address. */
  readonly url: string;
  /** Family tag this task owns; rows with this tag are the ones it replaces. */
  readonly family: string;
  /** Bound on the vendor call, so a hung vendor cannot stack intervals. */
  readonly timeoutMs?: number;
  /** Called after a successful replace so routing stops serving the old row. */
  readonly snapshotInvalidator?: { invalidate(): unknown };
  readonly onRotated?: (proxy: RotatedProxy, replaced: number) => void;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Parses the vendor's `proxyhttp` field.
 *
 * The documented shape is `host:port::` — a trailing empty user and password —
 * but a paid plan can embed credentials in the same field. Both read as the
 * same dial target; only the presence of a non-empty user/password pair
 * produces a credential.
 */
export function parseRotatedProxy(answer: RotationAnswer): RotatedProxy | undefined {
  const raw = answer.proxyhttp?.trim();
  if (!raw) return undefined;
  const [host, port, user, pass] = raw.split(":");
  if (!host || !port) return undefined;
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65_535) return undefined;
  const credential = user && pass ? `${user}:${pass}` : undefined;
  const note = [answer["Nha Mang"], answer["Vi Tri"]]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("/");
  return {
    endpoint: `http://${host}:${parsedPort}`,
    ...(credential ? { credential } : {}),
    ...(note ? { note } : {}),
  };
}

/** Vendor status that means "the address has not expired yet; nothing to do". */
const STATUS_NOT_DUE = 101;

/**
 * Fetches the current address, replaces this task's family with it, and drops
 * the one it superseded.
 *
 * A vendor that answers "not due yet" or hands back the address already stored
 * is not a failure: the row in the table is still correct, so nothing is
 * deleted. Only a genuinely new address triggers the replace, which keeps the
 * route snapshot from being invalidated every interval for no change.
 */
export async function proxyRotationSweep(deps: ProxyRotationSweepDeps): Promise<number> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let answer: RotationAnswer;
  try {
    const response = await fetch(deps.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`vendor answered HTTP ${response.status}`);
    answer = (await response.json()) as RotationAnswer;
  } catch (error) {
    deps.onError?.(error);
    log.warn(
      `[proxy-rotation] vendor unreachable; keeping the current ${deps.family} pool`,
      error instanceof Error ? error.message : error,
    );
    return 0;
  }

  if (answer.status === STATUS_NOT_DUE) {
    log.debug(`[proxy-rotation] vendor has not rotated yet: ${answer.message ?? ""}`);
    return 0;
  }
  const proxy = parseRotatedProxy(answer);
  if (!proxy) {
    deps.onError?.(new Error("vendor answer carried no usable proxyhttp"));
    log.warn(`[proxy-rotation] vendor answer carried no usable address: ${answer.message ?? ""}`);
    return 0;
  }

  // The tenant that owns the pool is the one that will route through it. A
  // deployment with no active tenant has no routing to influence, so the
  // address is fetched but not projected.
  const tenantRows = await deps.db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, "active"))
    .limit(1);
  const tenantId = tenantRows[0]?.id;
  if (!tenantId) {
    log.warn("[proxy-rotation] no active tenant; the rotated address is not projected");
    return 0;
  }

  const existing = await deps.db
    .select({ id: networkPools.id, endpointConfig: networkPools.endpointConfig })
    .from(networkPools)
    .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.family, deps.family)));

  const alreadyCurrent =
    existing.length === 1 &&
    ((existing[0]?.endpointConfig ?? {}) as { endpoint?: string }).endpoint === proxy.endpoint;
  if (alreadyCurrent) {
    log.debug(`[proxy-rotation] ${proxy.endpoint} is already the live ${deps.family} pool`);
    return 0;
  }

  // Delete-then-insert in one transaction: a reader between the two statements
  // would otherwise see an empty family and route direct for one request.
  await deps.db.transaction(async (tx) => {
    await tx
      .delete(networkPools)
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.family, deps.family)));
    await tx.insert(networkPools).values({
      tenantId,
      kind: "http",
      family: deps.family,
      endpointConfig: {
        endpoint: proxy.endpoint,
        label: proxy.note ? `${deps.family} ${proxy.note}` : deps.family,
        ...(proxy.note ? { note: proxy.note } : {}),
      },
      ...(proxy.credential ? { credentialCiphertext: encryptCredential(proxy.credential) } : {}),
      maxInflight: 10,
      weight: 100,
      status: "active",
      consecutiveFailures: 0,
    });
  });

  await deps.snapshotInvalidator?.invalidate();
  deps.onRotated?.(proxy, existing.length);
  log.info(
    `[proxy-rotation] replaced ${existing.length} ${deps.family} pool(s) with ${proxy.endpoint}`,
  );
  return 1;
}
