/**
 * Prisma CLI config (migrate, introspect, generate). The running app does NOT read this —
 * it connects through src/server/db with DATABASE_URL (role app_runtime, RLS applies).
 *
 * MIGRATE_DATABASE_URL is the table OWNER (production: resellersos_migration). Only the
 * deploy pipeline and a developer's local DB use it. Never give it to Cloud Run.
 */
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // No shadow DB is used: migrations are written by hand (SQL) and applied with
    // `prisma migrate deploy`. `migrate dev` is not part of this workflow.
  },
  datasource: {
    url: process.env.MIGRATE_DATABASE_URL ?? "",
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
