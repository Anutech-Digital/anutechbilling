/**
 * GET /api/health/migrations — is every migration this build knows about on this app's DB?
 *
 * R-1721 (21 Oct 2026). The staging DB step stopped after its backup (gcloud login expired), an
 * old "DB READY" was taken as done, the train ran with --db-done, and new code ran on staging
 * ~1 hour without 4 migrations before anyone noticed. The train trusted a person; now it asks
 * the app. scripts/ops/staging-train.mjs --push calls this once /api/version shows the new
 * build (and scripts/ops/migrations-health-check.mjs does the same for live).
 *
 * The list of checks is fixed at BUILD time (src/server/migrations-health/peeks.generated.ts,
 * from each migration's `-- deploy-peek:` line via gen-deploy-db) — nothing in the request
 * becomes SQL. The answer is only { sha, ok, missing: [keys] }: no data, no SQL text, no error
 * detail.
 *
 * Fails closed: no MIGRATIONS_HEALTH_TOKEN on the server → 503; a missing or wrong
 * `Authorization: Bearer <token>` → 401. Its own token, not CRON_SECRET or AGENT_QUEUE_TOKEN —
 * this one can only read these booleans.
 */
import { NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { readMigrationPeeks } from "@/server/db/migration-peek";
import { MIGRATION_PEEKS } from "@/server/migrations-health/peeks.generated";
import { missingKeys } from "@/server/migrations-health/peek-sql";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0, must-revalidate", "CDN-Cache-Control": "no-store" };

export async function GET(req: Request) {
  const expected = process.env.MIGRATIONS_HEALTH_TOKEN?.trim();
  if (!expected) return NextResponse.json({ error: "not configured" }, { status: 503, headers: NO_STORE });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  /* Same value /api/version shows, so the caller can tell WHICH build answered. */
  const sha = process.env.BUILD_SHA?.trim() || "dev";
  let values: boolean[];
  try {
    values = await readMigrationPeeks();
  } catch {
    /* DB login missing / unreachable — say "could not check", never why (no hosts, users, SQL). */
    return NextResponse.json({ sha, ok: false, missing: [] }, { status: 503, headers: NO_STORE });
  }
  const missing = missingKeys(MIGRATION_PEEKS, values);
  return NextResponse.json({ sha, ok: missing.length === 0, missing }, { headers: NO_STORE });
}
