/**
 * R-335 — GST s.34(2) time limit on a CREDIT note we issue (7 Oct 2026).
 *
 * A credit note for a supply must be declared in a return no later than 30 November
 * following the end of the financial year of that supply — or the date the annual
 * return (GSTR-9) is filed, if that is earlier. After that the output tax cannot be
 * reduced by the note.
 *
 * Same date rule as the purchase-side ITC limit (s.16(4)), so it reuses `itcDeadline`.
 * We only WARN (never block) — whether the note can still reduce tax is for the CA to
 * confirm (a commercial credit note without GST is still possible). No tax amount is
 * changed here. A debit note (s.34(4)) has no such limit, so this is credit-only.
 *
 * All dates are IST calendar dates "YYYY-MM-DD" (lib/dates/ist).
 */
import { itcDeadline } from "@/lib/compliance/entry-rules";
import { formatIstDate } from "@/lib/dates/ist";

/** Last date a credit note against an invoice of `invoiceDate` can be declared: 30 Nov after its FY. */
export function creditNoteDeadline(invoiceDate: string): string {
  return itcDeadline(invoiceDate.slice(0, 10));
}

/** True when a credit note dated `noteDate` (IST) falls after the s.34 limit for its invoice. */
export function isCreditNoteLate(invoiceDate: string | null | undefined, noteDate: string | null | undefined): boolean {
  if (!invoiceDate || !noteDate) return false;
  return noteDate.slice(0, 10) > creditNoteDeadline(invoiceDate);
}

/** The warning text to show when issuing a credit note today — or null when still in time. */
export function creditNoteDeadlineWarning(invoiceDate: string | null | undefined, todayIST: string): string | null {
  if (!invoiceDate || !isCreditNoteLate(invoiceDate, todayIST)) return null;
  const last = creditNoteDeadline(invoiceDate);
  return `This invoice is dated ${formatIstDate(invoiceDate)}. Under GST s.34, a credit note for it had to be declared by ` +
    `${formatIstDate(last)} (or the annual return date, if earlier). A late note may not reduce your output GST ` +
    `or the customer's ITC — confirm with your CA before issuing.`;
}

/** How many credit notes were issued after their invoice's s.34 limit. */
export function countLateCreditNotes(notes: { invoiceDate: string | null | undefined; noteDate: string | null | undefined }[]): number {
  return notes.filter((n) => isCreditNoteLate(n.invoiceDate, n.noteDate)).length;
}
