/**
 * POST /api/personal/support-ticket — R-2176 (GP-10c, G-PERSONAL).
 *
 * A PERSONAL user's Help → Report a problem. The report becomes a ticket on the support desk of
 * the company they are a customer of (their free support plan) — lib/support/personal-report.ts
 * explains which desk and why. Never a `feedback` row (a business table; the personal data
 * gateway refuses it, R-2125).
 *
 * Identity: ONLY the session (auth.getUser). The body carries the words, kind, severity and page
 * — no user, tenant or customer id. The service-role client is made for the session user
 * (createAdminClientFor(user.id)); this route reads the users row and filePersonalSupportTicket the
 * caller's own personal_identity_link row, all pinned to that user id (and raised_by_user).
 *
 * Role gate: the caller's users row (role must be in REPORT_ROLES = personal).
 *
 * Answers: 200 { ticketId } · 401 not signed in · 400 empty / too long · 403 not a personal login
 * · 409 not linked to a support desk yet (honest "NOT sent" message) · 429 hourly cap · 500.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import {
  filePersonalSupportTicket,
  PERSONAL_REPORT_MAX_CHARS,
  type PersonalReport,
  type PersonalReportDb,
} from "@/lib/support/personal-report";
import { FEEDBACK_TYPES, type FeedbackSeverity, type FeedbackType } from "@/lib/feedback/triage";

export const dynamic = "force-dynamic";

const SEVERITIES: readonly FeedbackSeverity[] = ["low", "medium", "high", "critical"];
/** Who may file here: a personal login only. Business roles report into `feedback` (Admin → Feedback). */
const REPORT_ROLES: readonly string[] = ["personal"];

export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "You are not signed in. Sign in again, then send the report." }, { status: 401 });

  const admin = createAdminClientFor(user.id);
  const { data: me } = await admin.from("users").select("role, full_name").eq("id", user.id).maybeSingle();
  if (!me || !REPORT_ROLES.includes(me.role ?? "")) {
    return NextResponse.json(
      { error: "This is for personal accounts. A business account reports through Help → Report a problem as before.", code: "NOT_PERSONAL" },
      { status: 403 },
    );
  }

  const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const text = typeof raw.text === "string" ? raw.text : "";
  if (text.length > PERSONAL_REPORT_MAX_CHARS) {
    return NextResponse.json({ error: `The report is too long (max ${PERSONAL_REPORT_MAX_CHARS} characters). Shorten it and send again.`, code: "TOO_LONG" }, { status: 400 });
  }
  const report: PersonalReport = {
    text,
    type: (FEEDBACK_TYPES as readonly string[]).includes(String(raw.type)) ? (raw.type as FeedbackType) : "bug",
    severity: (SEVERITIES as readonly string[]).includes(String(raw.severity)) ? (raw.severity as FeedbackSeverity) : "medium",
    pagePath: typeof raw.pagePath === "string" ? raw.pagePath.slice(0, 300) : "",
  };

  const result = await filePersonalSupportTicket(admin as unknown as PersonalReportDb, user.id, me.full_name ?? null, report);
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  return NextResponse.json({ ticketId: result.ticketId });
}
