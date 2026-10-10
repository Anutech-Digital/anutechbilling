/**
 * The ONLY way the app reaches Postgres through Prisma.
 *
 * Nothing here exports a raw PrismaClient. Every query runs inside a transaction that first
 * says who is asking — set_config('app.user_id' / 'app.tenant_id', …, true) — and the
 * database's own RLS policies then decide what that user may see. Forgetting is not a leak:
 * without those settings every tenant policy compares tenant_id with NULL and returns no rows.
 *
 * Why `set_config(…, true)` and never `SET`: the `true` makes it LOCAL to the transaction.
 * Postgres drops it at COMMIT/ROLLBACK, before the connection goes back to the pool, so the
 * next request on that connection — maybe another tenant's — cannot inherit it. A plain
 * session-level SET would survive and leak. (Pool + PgBouncer transaction mode are both safe
 * for the same reason: a connection is handed out for exactly one transaction.)
 *
 * The connection logs in as `app_runtime` (DATABASE_URL): not a table owner, no BYPASSRLS,
 * member of `authenticated` only — db/ops/10-runtime-roles.sql, re-checked by
 * tests/isolation on every run.
 *
 * Lint (no-restricted-imports) and src/server/db/import-boundary.test.ts keep the generated
 * client from being imported anywhere else.
 */
import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/client";
import { setContext } from "./context";

export { Prisma };
export type Tx = Prisma.TransactionClient;

/** Who is asking. Always built on the server from a verified session — never from a request body. */
export interface TenantSession {
  userId: string;
  tenantId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertTenantSession(s: TenantSession | null | undefined): asserts s is TenantSession {
  if (!s || !UUID.test(s.userId) || !UUID.test(s.tenantId)) {
    throw new Error("db: no signed-in user/tenant for this request");
  }
}

/**
 * Money functions (record_payment is ~600 lines and takes row locks) can run longer than
 * Prisma's 5-second default. A timeout there rolls the whole payment back, so it is raised
 * on purpose — and the database itself caps a statement at 30 s for app_runtime.
 */
const TX_OPTIONS = {
  timeout: 30_000,
  maxWait: 10_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
} as const;

function createClient(url: string | undefined, name: string): PrismaClient {
  if (!url) throw new Error(`db: ${name} is not set`);
  // DB_POOL_MAX: connections per server instance. Keep instances × this under Cloud SQL's
  // max_connections. The isolation suite sets it to 1 to prove a reused connection never
  // carries one tenant's context into the next request.
  const max = Number(process.env.DB_POOL_MAX) || undefined;
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max }) });
}

// One pool per server instance; dev hot-reload must not open a new pool on every edit.
const globalForDb = globalThis as unknown as { __rosRuntimeDb?: PrismaClient };
function runtimeClient(): PrismaClient {
  globalForDb.__rosRuntimeDb ??= createClient(process.env.DATABASE_URL, "DATABASE_URL");
  return globalForDb.__rosRuntimeDb;
}


/**
 * Run `fn` as this user, inside one transaction. Everything that must be atomic goes in one
 * call — two separate withTenant calls are two separate transactions.
 *
 *   const invoices = await withTenant(session, (tx) => tx.invoices.findMany());
 */
export async function withTenant<T>(session: TenantSession, fn: (tx: Tx) => Promise<T>): Promise<T> {
  assertTenantSession(session);
  return runtimeClient().$transaction(async (tx) => {
    await setContext(tx, session.userId, session.tenantId);
    return fn(tx);
  }, TX_OPTIONS);
}

/**
 * Client-extension form for simple, single-query code paths: every model operation is wrapped
 * in its own small batch transaction with the context set first (one round trip).
 *
 *   const db = dbFor(session);
 *   const leads = await db.leads.findMany({ take: 20 });
 *
 * Use withTenant when two queries must see the same snapshot or must commit together.
 */
export function dbFor(session: TenantSession) {
  assertTenantSession(session);
  const base = runtimeClient();
  return base.$extends({
    name: "tenant-context",
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await base.$transaction([
            base.$executeRaw`select set_config('app.user_id', ${session.userId}, true),
                                    set_config('app.tenant_id', ${session.tenantId}, true)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

/** For tests and graceful shutdown only. */
export async function disconnectDb(): Promise<void> {
  await globalForDb.__rosRuntimeDb?.$disconnect();
  globalForDb.__rosRuntimeDb = undefined;
}
