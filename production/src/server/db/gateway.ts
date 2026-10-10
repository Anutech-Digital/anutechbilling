/**
 * Database access for the PostgREST-compatible gateway (src/server/postgrest) ONLY — the
 * bridge that lets the existing supabase-js call sites run on Prisma, so the VM's PostgREST
 * can go before every call site is rewritten. Import-boundary test: nothing else may use it.
 *
 * Three logins, chosen by WHO is calling — never by anything in the request body:
 *   user    → app_runtime  (DATABASE_URL)          member of `authenticated`; RLS by user
 *   anon    → app_anon     (ANON_DATABASE_URL)     member of `anon`; signed-out visitors
 *   service → app_service  (SERVICE_DATABASE_URL)  member of `service_role` — exactly the power
 *             the service-role key has today (createAdminClient). Shrinks as those call sites
 *             move to withTenant; src/server/postgrest/admin-ratchet.test.ts only lets it fall.
 *
 * The user's identity is set transaction-locally, the same as withTenant. The tenant is left
 * empty: current_tenant_id() then derives it from public.users for that user — the exact
 * semantics PostgREST had with a verified JWT.
 */
import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/client";
import { setContext } from "./context";
import type { Tx } from "./index";

export type Identity = { mode: "anon" } | { mode: "user"; userId: string } | { mode: "service" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV = { user: "DATABASE_URL", anon: "ANON_DATABASE_URL", service: "SERVICE_DATABASE_URL" } as const;

const pools = globalThis as unknown as { __rosGateway?: Partial<Record<Identity["mode"], PrismaClient>> };
function pool(mode: Identity["mode"]): PrismaClient {
  pools.__rosGateway ??= {};
  const existing = pools.__rosGateway[mode];
  if (existing) return existing;
  const url = process.env[ENV[mode]];
  if (!url) throw new Error(`db: ${ENV[mode]} is not set`);
  const max = Number(process.env.DB_POOL_MAX) || undefined;
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max }) });
  pools.__rosGateway[mode] = client;
  return client;
}

export async function withIdentity<T>(id: Identity, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (id.mode === "user" && !UUID.test(id.userId)) throw new Error("db: gateway user id is not a uuid");
  return pool(id.mode).$transaction(async (tx) => {
    if (id.mode === "user") await setContext(tx, id.userId, "");
    return fn(tx);
  }, { timeout: 30_000, maxWait: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function disconnectGateway(): Promise<void> {
  for (const c of Object.values(pools.__rosGateway ?? {})) await c?.$disconnect();
  pools.__rosGateway = {};
}
