/**
 * Database access for background jobs ONLY (src/app/api/cron/**). Lint blocks this import
 * anywhere else.
 *
 * Jobs connect as `app_jobs` (JOBS_DATABASE_URL), a different login from the web app, and
 * in production run in a separate Cloud Run service — so the web service never holds a
 * credential that can list other tenants. The one cross-tenant power is listTenantsForJobs();
 * every read or write is done per tenant through withJobsTenant(), under normal RLS.
 */
import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/client";
import { setContext } from "./context";
import type { Tx } from "./index";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const globalForJobs = globalThis as unknown as { __rosJobsDb?: PrismaClient };
function jobsClient(): PrismaClient {
  const url = process.env.JOBS_DATABASE_URL;
  if (!url) throw new Error("db: JOBS_DATABASE_URL is not set");
  globalForJobs.__rosJobsDb ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  return globalForJobs.__rosJobsDb;
}

/** Every tenant id. The only query a job may run without naming a tenant first. */
export async function listTenantsForJobs(): Promise<string[]> {
  const rows = await jobsClient().$queryRaw<{ id: string }[]>`select id from public.jobs_list_tenants()`;
  return rows.map((r) => r.id);
}

/** Do one tenant's share of a job, in one transaction, seeing only that tenant. */
export async function withJobsTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error("db: withJobsTenant needs a tenant id");
  return jobsClient().$transaction(async (tx) => {
    await setContext(tx, null, tenantId);
    return fn(tx);
  }, { timeout: 120_000, maxWait: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function disconnectJobsDb(): Promise<void> {
  await globalForJobs.__rosJobsDb?.$disconnect();
  globalForJobs.__rosJobsDb = undefined;
}
