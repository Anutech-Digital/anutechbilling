/**
 * POST /api/admin/feedback/platform/dispatch — R-366: send another workspace's report to the
 * AI queue (platform owner only). Body: `{ id }` for one report, `{ all: true }` for every
 * open one. Answers `{ queued: string[], skipped: string[] }`.
 *
 * Gate, client and write rule are in lib/feedback/platform-dispatch.ts and match the
 * platform list route next door: isPlatformAdmin on the AUTHENTICATED email, checked before
 * the service role is created. The tenant of each row is read from the row, never the body.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/platform";
import {
  platformDispatchBody,
  canQueue,
  queuePatch,
  PLATFORM_DISPATCH_FORBIDDEN,
  PLATFORM_DISPATCH_MAX,
  type DispatchCandidate,
} from "@/lib/feedback/platform-dispatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isPlatformAdmin(auth.user.email)) {
    return NextResponse.json(PLATFORM_DISPATCH_FORBIDDEN, { status: 403 });
  }

  const parsed = platformDispatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Body must be {"id": "<report id>"} or {"all": true}.' }, { status: 400 });
  }

  const admin = createAdminClientFor(auth.user.id);
  const read = admin.from("feedback").select("id, tenant_id, status, dispatched_at");
  const { data: found, error: readErr } =
    "id" in parsed.data
      ? await read.eq("id", parsed.data.id).limit(1)
      : await read.eq("status", "open").is("dispatched_at", null).limit(PLATFORM_DISPATCH_MAX);
  if (readErr) return NextResponse.json({ error: "Could not read the report." }, { status: 500 });

  const rows = (found ?? []) as DispatchCandidate[];
  if ("id" in parsed.data && rows.length === 0) {
    return NextResponse.json({ error: "Report not found." }, { status: 404 });
  }

  const now = new Date().toISOString();
  const queued: string[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    if (!canQueue(row)) { skipped.push(row.id); continue; }
    /* One row per write, pinned to the row's OWN tenant and to the R-357 condition, so a row
       the auto-send or another tab took a moment ago is left alone and reported as skipped. */
    const { data: sent, error } = await admin
      .from("feedback")
      .update(queuePatch(auth.user.id, now))
      .eq("id", row.id)
      .eq("tenant_id", row.tenant_id)
      .eq("status", "open")
      .is("dispatched_at", null)
      .select("id");
    if (error) return NextResponse.json({ error: "Could not queue the report.", queued, skipped }, { status: 500 });
    if (sent && sent.length > 0) queued.push(row.id);
    else skipped.push(row.id);
  }

  return NextResponse.json({ queued, skipped });
}
