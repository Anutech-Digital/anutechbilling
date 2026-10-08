/**
 * GET /api/quality/platform — the Quality Score's "All workspaces" data (R-263).
 *
 * "Signup → first invoice" only means something across many workspaces, and RLS keeps the
 * browser to one. So, exactly like /api/admin/feedback/platform: server-side, service role,
 * and only after the AUTHENTICATED email passes the founder allowlist (lib/platform.ts) —
 * the client flag only decides whether the toggle is drawn.
 *
 * Returns slim rows only (ids, timestamps, status, severity, titles) — the numbers are
 * worked out by lib/quality/score.ts in the browser, the same code "This workspace" uses.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/platform";
import { QUALITY_FEEDBACK_COLUMNS, mergeQualityInput, type QualityFeedbackRow } from "@/lib/quality/score";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROW_LIMIT = 20_000;

export async function GET() {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  /* Checked BEFORE the admin client exists, so the service role is never created for a
     caller who may not use it. */
  if (!isPlatformAdmin(auth.user.email)) {
    return NextResponse.json(
      { error: "Only the platform owner can see every workspace's numbers.", nextStep: "Your own workspace's numbers are on this page already." },
      { status: 403 },
    );
  }

  const admin = createAdminClient();
  const [tenantQ, invoiceQ, feedbackQ, checkedQ] = await Promise.all([
    admin.from("tenants").select("id, created_at").limit(ROW_LIMIT),
    admin.from("invoices").select("tenant_id, created_at").order("created_at", { ascending: true }).limit(ROW_LIMIT),
    admin.from("feedback").select(QUALITY_FEEDBACK_COLUMNS).order("created_at", { ascending: false }).limit(ROW_LIMIT),
    admin.from("feedback").select("id, checked_at").not("checked_at", "is", null).limit(ROW_LIMIT),
  ]);
  const failed = tenantQ.error ?? invoiceQ.error ?? feedbackQ.error;
  if (failed) {
    console.error("[quality/platform] read failed:", failed.message);
    return NextResponse.json({ error: "Could not read the numbers just now. Please reload in a minute." }, { status: 500 });
  }

  return NextResponse.json(mergeQualityInput(
    tenantQ.data ?? [],
    invoiceQ.data ?? [],
    (feedbackQ.data ?? []) as unknown as Omit<QualityFeedbackRow, "checked_at">[],
    checkedQ.error ? null : (checkedQ.data ?? []) as { id: string; checked_at: string | null }[],
  ));
}
