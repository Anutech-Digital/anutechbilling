/**
 * R-2564 (7 Nov 2026) — the one folder whole-src scan tests skip: Prisma's generated client.
 *
 * `prisma generate` writes it from prisma/schema.prisma (gitignored, ~36 MB of the ~50 MB under
 * src/ — tenants.ts alone is 11 MB). It is not our code, so no guard is about it, yet every
 * whole-src walker read and regex-scanned all of it: under push load (4 workers) app-url,
 * no-seed-tenant and friends took 15–20 s each for a job of < 1 s. R-2552 did this first for
 * no-public-admin-env; this is the same skip, shared so the path is written once.
 *
 * prisma-generated.test.ts pins that this is EXACTLY the schema's generator `output`, so if the
 * output ever moves the skip goes red instead of silently skipping nothing (or something else).
 * Test-only helper: imported by *.test.ts files, never by app code.
 */
import path from "node:path";

/** production/ — this file lives at production/src/lib/testing/. */
export const PRODUCTION_ROOT = path.resolve(__dirname, "..", "..", "..");

/** Absolute path of the generated Prisma client folder (skip it in a src/ walk). */
export const PRISMA_GENERATED = path.join(PRODUCTION_ROOT, "src", "server", "db", "generated");

/** True for the generated client folder itself (compare a walked DIRECTORY path). */
export function isPrismaGenerated(dir: string): boolean {
  return path.resolve(dir) === PRISMA_GENERATED;
}
