/**
 * Database access for the login system ONLY (src/server/auth). Import-boundary test: nothing
 * else may use it.
 *
 * Logs in as `app_auth` (AUTH_DATABASE_URL), which can read and write GoTrue's own tables —
 * auth.users and auth.mfa_factors — and nothing in the app's schema (db/ops/20-auth-login.sql).
 * So a bug in the login code cannot read invoices, and a bug anywhere else cannot read
 * password hashes.
 */
import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/client";
import type { Tx } from "./index";

const holder = globalThis as unknown as { __rosAuthDb?: PrismaClient };

function client(): PrismaClient {
  const url = process.env.AUTH_DATABASE_URL;
  if (!url) throw new Error("db: AUTH_DATABASE_URL is not set");
  holder.__rosAuthDb ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: Number(process.env.DB_POOL_MAX) || undefined }) });
  return holder.__rosAuthDb;
}

export async function withAuthStore<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return client().$transaction(fn, { timeout: 15_000, maxWait: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function disconnectAuthStore(): Promise<void> {
  await holder.__rosAuthDb?.$disconnect();
  holder.__rosAuthDb = undefined;
}
