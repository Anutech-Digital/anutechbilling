/**
 * Two display rules shared by the invoice PDF and the quote PDF (Pawan, 3 Oct 2026). Display
 * only: nothing here changes a stored number, date or line. The on-screen tax-invoice preview is
 * in the Billing & Subscriptions section (AGENTS.md §13) and does not use them yet.
 *
 * 1. A line says which website it is for. A hosting order line read "Starter hosting (billed
 *    yearly)" with no domain, so a customer with several plans could not tell them apart. The
 *    domain is already on the line (`domain`); this prints it as the line's small detail text.
 *
 * 2. A fully paid invoice reads as paid. Paid at checkout, the invoice still said "Due date
 *    2 Nov 2026" and "Payment terms: Due by …" beside "Net payable ₹0". When nothing is left to
 *    pay it now shows when it was paid instead. Unpaid and part-paid invoices are unchanged —
 *    the due date stays "a fact about this invoice" (R-038) for anything still owed.
 */
import type { InvoiceAdvanceAdjustment, QuoteLineItem } from "@/lib/supabase/database.types";

/** "For acme.in" for a line that carries a domain the name and detail do not already show. */
export function lineDomainNote(li: Pick<QuoteLineItem, "name" | "description" | "domain" | "bulk">): string | null {
  const domain = (li.domain ?? "").trim().toLowerCase();
  if (!domain || li.bulk) return null; // a bulk line lists its own domains
  const shown = `${li.name ?? ""} ${li.description ?? ""}`.toLowerCase();
  if (shown.includes(domain)) return null;
  return `For ${domain}`;
}

export interface PaidInFull {
  /** ISO date of the payment that settled it, or null when the invoice does not say. */
  paidOn: string | null;
}

/**
 * Settled = nothing left to pay AND (marked paid, or the advances adjusted cover the total).
 * Returns null for anything still owed, so callers keep showing the due date.
 */
export function invoicePaidInFull(
  inv: {
    status?: string | null;
    paid_date?: string | null;
    net_payable?: number | null;
    adjusted_advances?: InvoiceAdvanceAdjustment[] | null;
  },
  total: number,
): PaidInFull | null {
  const advances = inv.adjusted_advances ?? [];
  const advancesTotal = advances.reduce((acc, a) => acc + (Number(a.amount) || 0), 0);
  const netPayable = inv.net_payable ?? Math.max(0, total - advancesTotal);
  if (netPayable > 0) return null;
  const covered = total > 0 && advancesTotal >= total;
  if (inv.status !== "paid" && !covered) return null;
  const latestAdvance = advances
    .map((a) => a.received_at)
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .sort()
    .at(-1);
  return { paidOn: inv.paid_date ?? latestAdvance ?? null };
}
