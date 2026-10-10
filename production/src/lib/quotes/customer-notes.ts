/**
 * R-813 — what the CUSTOMER may read of a quote's notes.
 *
 * Staging, 10 Oct 2026: add-seats quote Q-5F40-27-0012 showed the customer "Add-seats
 * pro-rata for subscription c28000ac-… (backdated by Pardeep Sharma on 2026-10-10) …
 * (factor 99.7260%)" — on the accept page, the PDF and so the email attachment. A
 * subscription UUID, a staff member's action and our pro-rata arithmetic are staff facts.
 *
 * quotes has no internal-notes column, so `notes` holds both, in two parts:
 *
 *   <customer line>
 *
 *   Staff only (not shown to the customer):
 *   <audit text>
 *
 * Staff screens show the whole field (the audit stays where staff look for it). Every
 * customer surface — accept page, QuotePDF (email / WhatsApp / download), the staff
 * "preview as customer" dialog — renders customerQuoteNotes() instead, which cuts at the
 * marker. Quotes stored BEFORE this change hold only the audit text; they are not
 * rewritten — the old add-seats pattern is recognised on display and replaced by the
 * same plain line a new quote would carry.
 */
import { formatIstDate } from "@/lib/dates/ist";

/** Everything after this line in quotes.notes is staff-only. */
export const STAFF_NOTE_MARKER = "Staff only (not shown to the customer):";

/** The audit text every add-seats quote was written with before R-813 (since May 2026). */
const LEGACY_ADD_SEATS = /^\s*Add-seats pro-rata for subscription\b/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "Additional seats from 25 Sep 2026 to 31 Mar 2027 (pro-rata)." */
export function addSeatsCustomerNote(from: string | null | undefined, to: string | null | undefined): string {
  const f = from && ISO_DAY.test(from.slice(0, 10)) ? formatIstDate(from.slice(0, 10)) : null;
  const t = to && ISO_DAY.test(to.slice(0, 10)) ? formatIstDate(to.slice(0, 10)) : null;
  if (f && t) return `Additional seats from ${f} to ${t} (pro-rata).`;
  if (f)      return `Additional seats from ${f} (pro-rata).`;
  return "Additional seats, charged pro-rata for the rest of the term.";
}

/** The stored field for a new quote: the customer line, then the staff-only audit. */
export function composeQuoteNotes(customerLine: string, staffAudit: string): string {
  return `${customerLine.trim()}\n\n${STAFF_NOTE_MARKER}\n${staffAudit.trim()}`;
}

/** The staff-only part of a stored note ("" when there is none), for staff screens. */
export function staffQuoteNotes(notes: string | null | undefined): string {
  if (!notes) return "";
  const at = notes.indexOf(STAFF_NOTE_MARKER);
  if (at >= 0) return notes.slice(at + STAFF_NOTE_MARKER.length).trim();
  return LEGACY_ADD_SEATS.test(notes) ? notes.trim() : "";
}

/**
 * The notes a customer may see, or null for none.
 *
 * `lineItems` lets an OLD add-seats note name its end date: the audit text never carried
 * it, but the line does — "(pro-rata from 2026-09-25 to 2027-03-31)".
 */
export function customerQuoteNotes(
  notes: string | null | undefined,
  lineItems?: ReadonlyArray<{ name?: string | null }> | null,
): string | null {
  if (!notes) return null;
  const at = notes.indexOf(STAFF_NOTE_MARKER);
  const visible = (at >= 0 ? notes.slice(0, at) : notes).trim();
  if (!visible) return null;
  if (!LEGACY_ADD_SEATS.test(visible)) return visible;

  /* An old add-seats note is ALL audit text — none of it was written for the customer. */
  const from = /Effective date (\d{4}-\d{2}-\d{2})/.exec(visible)?.[1]
    ?? /pro-rata from (\d{4}-\d{2}-\d{2})/.exec((lineItems ?? []).map((l) => l.name ?? "").join(" "))?.[1]
    ?? null;
  let to: string | null = null;
  for (const l of lineItems ?? []) {
    const m = /\bto (\d{4}-\d{2}-\d{2})\)/.exec(l.name ?? "");
    if (m && (!to || m[1] > to)) to = m[1];
  }
  return addSeatsCustomerNote(from, to);
}
