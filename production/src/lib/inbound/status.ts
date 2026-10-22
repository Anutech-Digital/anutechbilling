/**
 * Inbound-email status helpers — pure, UI-agnostic so they're unit-testable
 * without pulling the Supabase client (see deletable.ts for the same pattern).
 *
 * The webhook writes one of these `status` values to inbound_emails:
 *   received | lead_created | appended_to_lead | duplicate |
 *   skipped_non_enquiry | error | ignored | reply_sent
 *
 * ⚠️ The last two were MISSING from that list until 30 Aug 2026, and missing from the
 * switch below with them. Counted against the live table that day:
 *
 *     appended_to_lead 8 · skipped_non_enquiry 8 · reply_sent 6 · lead_created 6 · ignored 4
 *
 * — and `received`, `duplicate` and `error`, the three this file did document, had zero
 * rows between them. So the vocabulary here described statuses nothing writes while
 * omitting ten rows' worth of statuses that everything writes.
 *
 * The visible cost was the `default:` arm, which renders `status` verbatim. Four bounce
 * notices sat in the live Inbox wearing a badge that said **"ignored"** — a database
 * word, lowercase, shown to a salesperson. That is the exact thing this page's own
 * header says it removed when it renamed the folders away from `untriaged` /
 * `appended` / `skipped`; it had simply survived one layer down.
 */

import { isBounce } from "./bounce";

export type InboundBadgeKind = "success" | "info" | "muted" | "warning" | "danger";

export interface InboundStatusMeta {
  label: string;
  kind:  InboundBadgeKind;
}

/** Map a raw inbound status to a human label + badge tone. */
export function inboundStatusMeta(status: string): InboundStatusMeta {
  switch (status) {
    case "lead_created":        return { label: "Lead Created",    kind: "success" };
    case "appended_to_lead":    return { label: "Follow-up Reply",  kind: "info" };
    case "received":            return { label: "New Enquiry",     kind: "warning" };
    case "skipped_non_enquiry": return { label: "System / Non-Sales", kind: "muted" };
    case "duplicate":           return { label: "Duplicate",       kind: "muted" };
    case "error":               return { label: "Error",           kind: "danger" };
    /* Machine mail the router set aside — a no-reply security alert, a notifications
       address. Nothing to do, which is what "muted" says. A BOUNCE also carries this
       status and is not nothing to do; `enquiryBadge` below is what tells them apart. */
    case "ignored":             return { label: "Automated Mail",  kind: "muted" };
    case "reply_sent":          return { label: "Reply Sent",      kind: "info" };
    default:                    return { label: status || "—",     kind: "muted" };
  }
}

/**
 * The badge the UI shows. **Call this, not `inboundStatusMeta`.**
 *
 * A status alone cannot see a bounce. `routing.ts` writes `ignored` for every machine
 * sender, so a Google security alert and "your quote never reached the customer" arrive
 * wearing the same word — and they are opposite news. Deciding needs the sender and the
 * subject, which is more than a status string carries.
 *
 * `inboundStatusMeta` stays a pure status→label map because that is a real and testable
 * thing on its own. This is the composition, and it is the one with a call site.
 */
export function enquiryBadge(row: {
  status:     string;
  from_email: string | null;
  subject:    string | null;
}): InboundStatusMeta {
  /* Hinglish, deliberately, while the labels around it are English. Pardeep asked for
     this wording, and this is the one badge on the screen that is not a filing category
     but a piece of bad news somebody has to act on today. */
  if (isBounce(row)) return { label: "Email not delivered", kind: "danger" };
  return inboundStatusMeta(row.status);
}

/**
 * Can this email be converted into a lead by hand?
 * Only when it hasn't already produced/attached to a lead — i.e. it was
 * received-but-untriaged or Gemini judged it a non-enquiry (operator disagrees).
 */
export function canConvertToLead(row: { status: string; lead_id: string | null }): boolean {
  if (row.lead_id) return false;
  return row.status === "received" || row.status === "skipped_non_enquiry" || row.status === "error";
}
