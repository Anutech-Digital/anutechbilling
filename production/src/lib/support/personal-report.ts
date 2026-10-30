/**
 * R-2176 (GP-10c, G-PERSONAL) — a PERSONAL user's Help → Report a problem, filed as a ticket on
 * the support desk of the company they are a customer of (their free support plan).
 *
 * DECISION (Pardeep delegated, recorded on the card): a personal report goes to the SUPPORT DESK
 * as a ticket, never into the business `feedback` table (which the personal data gateway refuses,
 * R-2125 — before this the report was lost and the server logged gateway_refused).
 *
 * WHICH DESK, AND WHY THIS ONE: there is no Billing → anutech-support (DSP) ticket API yet — DSP
 * creates tickets only for a signed-in desk customer, and the hand-off sign-in is GP-30 (R-2135,
 * todo). The desk that DOES take tickets from Billing today is the seller company's own Support
 * desk (`support_tickets`, /support): support@ mail and WhatsApp land there (run-support-agent.ts),
 * the INSERT trigger stamps the plan tier + SLA clock (no paid support plan = 'free', 24 h), and
 * the owners/managers get an in-app notification.
 *
 * HOW: one SECURITY DEFINER function, personal_file_support_ticket (migration
 * 20261030221233_r2176_personal_file_support_ticket.sql), called with the user's OWN session. It
 * derives everything from auth.uid(): personal check (role or workspace_kind), the desk + customer
 * from personal_identity_link, the hourly cap, the insert. (The first version used the
 * service-role client; under DATA_GATEWAY=1 that is app_service without an RLS bypass, so the
 * users read came back empty and the insert was refused — localhost check of 4957282b0.)
 */
import type { FeedbackSeverity, FeedbackType } from "@/lib/feedback/triage";
import type { TicketCategory, TicketPriority } from "@/lib/ai/support-agent";

/** Reports one login may file per hour — enforced in SQL (R2176_TOO_MANY); here for the message. */
export const PERSONAL_REPORT_HOURLY_CAP = 10;
/** Longest report body accepted (the SQL function refuses longer). */
export const PERSONAL_REPORT_MAX_CHARS = 8000;

export interface PersonalReport {
  type: FeedbackType;
  severity: FeedbackSeverity;
  /** The person's words (first line = title) plus what the app recorded. */
  text: string;
  pagePath: string;
}

export type PersonalReportCode = "EMPTY" | "NOT_SIGNED_IN" | "NOT_PERSONAL" | "NOT_LINKED" | "TOO_MANY" | "BAD_INPUT" | "FAILED";

export type PersonalReportResult =
  | { ok: true; ticketId: string }
  | { ok: false; status: 400 | 401 | 403 | 409 | 429 | 500; code: PersonalReportCode; error: string };

/** The slice of a Supabase client this file uses (the session client in the route; a fake in tests). */
export interface PersonalReportRpc {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
}

const CATEGORY: Record<FeedbackType, TicketCategory> = { bug: "tech", ui_improvement: "tech", feature: "feature" };
const PRIORITY: Record<FeedbackSeverity, TicketPriority> = { low: "low", medium: "normal", high: "high", critical: "urgent" };

/** Subject = the first line (as the inbound desk does), category/priority in the desk's own words. */
export function ticketFieldsFromReport(r: Pick<PersonalReport, "type" | "severity" | "text">): {
  subject: string; category: TicketCategory; priority: TicketPriority;
} {
  const first = r.text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const subject = !first ? "(no subject)" : first.length > 120 ? `${first.slice(0, 119)}…` : first;
  return { subject, category: CATEGORY[r.type] ?? "tech", priority: PRIORITY[r.severity] ?? "normal" };
}

const NOT_SENT_TAIL = "Your report was NOT sent — the text is still in the box.";

export const NOT_LINKED_MESSAGE =
  "Your free support desk is not set up for this account yet, so this report was NOT sent. " +
  "Confirm your email address (the link in your sign-up mail), then try again — or write to support@anutech.in.";

/** The SQL function's error (message starts with R2176_<CODE>) → status + a message for the person. */
export function resultFromRpcError(message: string): Extract<PersonalReportResult, { ok: false }> {
  const code = /R2176_([A-Z_]+)/.exec(message)?.[1];
  switch (code) {
    case "NOT_SIGNED_IN":
      return { ok: false, status: 401, code: "NOT_SIGNED_IN", error: "You are not signed in. Sign in again, then send the report." };
    case "NOT_PERSONAL":
      return { ok: false, status: 403, code: "NOT_PERSONAL", error: "This is for personal accounts. A business account reports through Help → Report a problem as before." };
    case "NOT_LINKED":
      return { ok: false, status: 409, code: "NOT_LINKED", error: NOT_LINKED_MESSAGE };
    case "TOO_MANY":
      return { ok: false, status: 429, code: "TOO_MANY", error: `You have sent ${PERSONAL_REPORT_HOURLY_CAP} reports in the last hour. ${NOT_SENT_TAIL} Try again later.` };
    case "BAD_INPUT":
      return { ok: false, status: 400, code: "BAD_INPUT", error: `The report is empty or too long. ${NOT_SENT_TAIL}` };
    default:
      return { ok: false, status: 500, code: "FAILED", error: `Could not reach the support desk. ${NOT_SENT_TAIL} Try again in a minute.` };
  }
}

/**
 * File one report as a support ticket for the session behind `db` (the caller's OWN client —
 * the SQL function reads auth.uid(); nothing here names a user). Never throws.
 */
export async function filePersonalSupportTicket(db: PersonalReportRpc, report: PersonalReport): Promise<PersonalReportResult> {
  const text = report.text.trim();
  if (!text) return { ok: false, status: 400, code: "EMPTY", error: "The report is empty. Write what happened, then send it." };

  const { subject, category, priority } = ticketFieldsFromReport({ ...report, text });
  const page = report.pagePath ? `\n\nPage: ${report.pagePath.slice(0, 300)}` : "";
  /* The SQL function refuses a body over PERSONAL_REPORT_MAX_CHARS; keep the page line inside it. */
  const body = text.slice(0, PERSONAL_REPORT_MAX_CHARS - page.length) + page;
  try {
    const { data, error } = await db.rpc("personal_file_support_ticket", {
      p_subject: subject,
      p_body: body,
      p_category: category,
      p_priority: priority,
    });
    if (error) {
      const out = resultFromRpcError(error.message ?? "");
      if (out.code === "FAILED") console.error("[personal-report] personal_file_support_ticket failed:", error.message);
      return out;
    }
    if (typeof data !== "string" || !data) {
      console.error("[personal-report] personal_file_support_ticket returned no ticket number:", JSON.stringify(data));
      return resultFromRpcError("");
    }
    return { ok: true, ticketId: data };
  } catch (e) {
    console.error("[personal-report] personal_file_support_ticket threw:", e instanceof Error ? e.message : e);
    return resultFromRpcError("");
  }
}
