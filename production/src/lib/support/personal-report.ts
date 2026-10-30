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
 * the INSERT trigger stamps the plan tier + SLA clock (stamp_support_ticket_sla: no paid support
 * plan = 'free', 24 h), and the owners/managers get an in-app notification (notify_ticket_created).
 * The person's company + customer come from personal_identity_link (R-2118, written at verified
 * signup). Same row shape as an inbound mail ticket, with what this door knows better: the
 * customer (verified link, not guessed from an address), the login (raised_by_user) and the
 * channel ('app' — already allowed by support_tickets_channel_check).
 *
 * Everything here runs on a service-role client made for the session user (the route), and every
 * read/write is pinned to that user's id — the request names no user, tenant or customer. The
 * route has already read the caller's users row and refused any role but 'personal'.
 */
import { newTicketId } from "@/lib/inbound/routing";
import type { FeedbackSeverity, FeedbackType } from "@/lib/feedback/triage";
import type { TicketCategory, TicketPriority } from "@/lib/ai/support-agent";

/** Reports one login may file per hour — a free account must not be able to flood the desk. */
export const PERSONAL_REPORT_HOURLY_CAP = 10;
/** Longest report body accepted (the Help box allows 4000 + the attached recorded steps). */
export const PERSONAL_REPORT_MAX_CHARS = 8000;

export interface PersonalReport {
  type: FeedbackType;
  severity: FeedbackSeverity;
  /** The person's words (first line = title) plus what the app recorded. */
  text: string;
  pagePath: string;
}

export type PersonalReportResult =
  | { ok: true; ticketId: string }
  | { ok: false; status: 400 | 409 | 429 | 500; code: "EMPTY" | "NOT_LINKED" | "TOO_MANY" | "FAILED"; error: string };

/** The slice of a Supabase client this file uses (lets tests pass a fake). */
export interface PersonalReportDb {
  from(table: string): unknown;
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

interface LinkRow {
  seller_tenant_id: string | null;
  anutech_customer_id: string | null;
  email: string | null;
}

type Single<T> = { data: T | null; error: { message: string } | null };
type Q = {
  select: (cols: string, opts?: unknown) => Q;
  eq: (col: string, v: unknown) => Q;
  gte: (col: string, v: unknown) => PromiseLike<{ count: number | null; error: { message: string } | null }>;
  maybeSingle: <T>() => PromiseLike<Single<T>>;
  insert: (row: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }>;
};

/**
 * File one report as a support ticket for `userId` (the SESSION user — the route's job).
 * Never throws for an expected refusal; every refusal says the report was not sent.
 */
export async function filePersonalSupportTicket(
  db: PersonalReportDb,
  userId: string,
  /** The caller's full name from their users row (read by the route), or null. */
  fullName: string | null,
  report: PersonalReport,
  now: Date = new Date(),
): Promise<PersonalReportResult> {
  const text = report.text.trim();
  if (!text) return { ok: false, status: 400, code: "EMPTY", error: "The report is empty. Write what happened, then send it." };

  const from = (t: string) => db.from(t) as Q;

  const { data: link } = await from("personal_identity_link")
    .select("seller_tenant_id, anutech_customer_id, email")
    .eq("auth_user_id", userId)
    .maybeSingle<LinkRow>();
  const sellerTenant = link?.seller_tenant_id ?? null;
  const email = link?.email?.trim() || null;
  if (!sellerTenant || !email) return { ok: false, status: 409, code: "NOT_LINKED", error: NOT_LINKED_MESSAGE };

  const since = new Date(now.getTime() - 3_600_000).toISOString();
  const { count, error: countErr } = await from("support_tickets")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", sellerTenant)
    .eq("raised_by_user", userId)
    .eq("channel", "app")
    .gte("created_at", since);
  if (!countErr && (count ?? 0) >= PERSONAL_REPORT_HOURLY_CAP) {
    return { ok: false, status: 429, code: "TOO_MANY", error: `You have sent ${PERSONAL_REPORT_HOURLY_CAP} reports in the last hour. ${NOT_SENT_TAIL} Try again later.` };
  }

  const { subject, category, priority } = ticketFieldsFromReport({ ...report, text });
  const ticketId = newTicketId();
  const body = report.pagePath ? `${text}\n\nPage: ${report.pagePath}` : text;
  /* tier + sla_due_at are left to stamp_support_ticket_sla (one source for the SLA clock). */
  const { error } = await from("support_tickets").insert({
    id: ticketId,
    tenant_id: sellerTenant,
    customer_id: link?.anutech_customer_id ?? null,
    customer_name: fullName?.trim() || email,
    raised_by_email: email,
    raised_by_user: userId,
    channel: "app",
    category,
    priority,
    subject,
    body,
    status: "open",
  });
  if (error) {
    console.error("[personal-report] support ticket insert failed:", error.message);
    return { ok: false, status: 500, code: "FAILED", error: `Could not reach the support desk. ${NOT_SENT_TAIL} Try again in a minute.` };
  }
  return { ok: true, ticketId };
}
