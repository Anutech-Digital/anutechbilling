/**
 * Inbound-email status helpers — pure, UI-agnostic so they're unit-testable
 * without pulling the Supabase client (see deletable.ts for the same pattern).
 *
 * The webhook writes one of these `status` values to inbound_emails:
 *   received | lead_created | appended_to_lead | duplicate |
 *   skipped_non_enquiry | error
 */

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
    default:                    return { label: status || "—",     kind: "muted" };
  }
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
