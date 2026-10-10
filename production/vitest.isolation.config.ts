import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// Tenant-isolation proof against a real Postgres built by `npm run db:local`.
// DATABASE_URL = app_runtime (what the app uses), ADMIN_DATABASE_URL = local superuser (seeding).
// Same aliases as the unit config; its `test` block is replaced, not merged (it excludes us).
export default defineConfig({
  ...base,
  test: {
    include: ["tests/isolation/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    // next-auth imports "next/server" without an extension; let Vite resolve it.
    server: { deps: { inline: ["next-auth", "@auth/core"] } },
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://app_runtime:localdev@localhost:54329/ros",
      JOBS_DATABASE_URL: process.env.JOBS_DATABASE_URL ?? "postgresql://app_jobs:localdev@localhost:54329/ros",
      ANON_DATABASE_URL: process.env.ANON_DATABASE_URL ?? "postgresql://app_anon:localdev@localhost:54329/ros",
      SERVICE_DATABASE_URL: process.env.SERVICE_DATABASE_URL ?? "postgresql://app_service:localdev@localhost:54329/ros",
      AUTH_DATABASE_URL: process.env.AUTH_DATABASE_URL ?? "postgresql://app_auth:localdev@localhost:54329/ros",
      SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET ?? "local-dev-jwt-secret-at-least-32-characters-long",
      AUTH_SECRET: process.env.AUTH_SECRET ?? "local-dev-auth-secret-at-least-32-characters-long",
      POSTGREST_URL: process.env.POSTGREST_URL ?? "http://localhost:54330",
      POSTGREST_JWT_SECRET: process.env.POSTGREST_JWT_SECRET ?? "local-dev-jwt-secret-at-least-32-characters-long",
      ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL ?? "postgresql://postgres:localdev@localhost:54329/ros",
      DB_POOL_MAX: "1",
    },
  },
});
