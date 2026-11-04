/**
 * R-2337 (G-TEAMCHAT): nightly clean-up of team chat files that belong to no message.
 *
 * A file removed from the composer, or a file of a deleted message, is deleted by the browser
 * (R-2332). When that delete fails the object stays in storage. SQL cannot delete storage bytes
 * (storage.protect_delete), so this job does it with the service role through the Storage API:
 * bucket "documents", folder {tenant}/chat/{channel}/ only — files older than 24 h with no
 * chat_attachments row and no open chat_upload_tickets row. At most 500 per run. Logic and the
 * rules: src/lib/team-chat/orphan-sweep.ts.
 *
 * ?dry=1 — practice run: counts what it would delete, deletes nothing.
 * Auth: Authorization: Bearer <CRON_SECRET> (same as the other crons).
 * Local: npm run cron:local chat-files-cleanup -- --dry
 */
import "@/lib/sentry";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { reportCron } from "@/lib/ops/cron-report";
import { cronDbFailure } from "@/app/api/cron/_lib/db-failure";
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";
import { sweepChatOrphans, type SweepClient, type SweepResult } from "@/lib/team-chat/orphan-sweep";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const JOB = "chat-files-cleanup" as const;
const TENANT_PAGE = 1000;

type CleanupResult = SweepResult & { ran_at: string };

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or deleted. */
const gated = gatedCron("chat-files-cleanup", handle);
export async function GET(req: Request) { return gated(req); }
export async function POST(req: Request) { return gated(req); }

async function handle(req: Request): Promise<NextResponse<CleanupResult | { error: string }>> {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dry = new URL(req.url).searchParams.get("dry") === "1";

  const supabase = createAdminClient();

  const tenantIds: string[] = [];
  for (let from = 0; ; from += TENANT_PAGE) {
    const { data, error } = await supabase
      .from("tenants").select("id").order("id", { ascending: true }).range(from, from + TENANT_PAGE - 1);
    if (error) return cronDbFailure("chat-files-cleanup", error, error.message);
    const page = data ?? [];
    tenantIds.push(...page.map((t) => t.id));
    if (page.length < TENANT_PAGE) break;
  }

  const result = await sweepChatOrphans(supabase as unknown as SweepClient, tenantIds, {
    now: Date.now(),
    dry,
    allowTenant: (id) => cronTenantAllowed(id),
  });
  console.info(
    `[cron/${JOB}] ${dry ? "practice run" : "run"}: tenants ${result.tenants}, scanned ${result.scanned}, ` +
      `orphans ${result.orphans}, deleted ${result.deleted}${result.capped ? " (cap reached — rest next run)" : ""}`,
  );

  return NextResponse.json(reportCron("chat-files-cleanup", { ran_at: new Date().toISOString(), ...result }));
}
