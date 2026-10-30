/**
 * POST /api/personal/support-ticket — R-2176 (GP-10c, G-PERSONAL).
 *
 * A PERSONAL user's Help → Report a problem. The report becomes a ticket on the support desk of
 * the company they are a customer of (their free support plan) — lib/support/personal-report.ts
 * explains which desk and why. Never a `feedback` row (a business table; the personal data
 * gateway refuses it, R-2125).
 *
 * Identity + role gate: the caller's OWN session. The route checks a session exists, then calls
 * personal_file_support_ticket (SECURITY DEFINER, authenticated only) with that same session; the
 * function takes the user from auth.uid(), refuses a non-personal login (role or workspace_kind),
 * resolves the desk + customer from personal_identity_link, applies the hourly cap and inserts.
 * No service role, and the body names no user, tenant or customer.
 *
 * Answers: 200 { ticketId } · 401 not signed in · 400 empty / too long · 403 not a personal login
 * · 409 not linked to a support desk yet (honest "NOT sent" message) · 429 hourly cap · 500.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  filePersonalSupportTicket,
  PERSONAL_REPORT_MAX_CHARS,
  type PersonalReport,
  type PersonalReportRpc,
} from "@/lib/support/personal-report";
import { FEEDBACK_TYPES, type FeedbackSeverity, type FeedbackType } from "@/lib/feedback/triage";

export const dynamic = "force-dynamic";

const SEVERITIES: readonly FeedbackSeverity[] = ["low", "medium", "high", "critical"];

export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "You are not signed in. Sign in again, then send the report.", code: "NOT_SIGNED_IN" }, { status: 401 });

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

  const result = await filePersonalSupportTicket(supabase as unknown as PersonalReportRpc, report);
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  return NextResponse.json({ ticketId: result.ticketId });
}
