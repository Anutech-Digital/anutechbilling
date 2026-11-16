/**
 * R-2853 — the billed parts behind invoices (subscription_billings.invoice_id, R-2101) with their
 * subscription's cycle + term, for the "Part 2 of 12 · 1–31 Oct 2026" line under an invoice number
 * (lib/invoices/invoice-period.ts). ONE paged read per screen, never one per invoice:
 *   - /invoices: every billed part of the company (rows with an invoice), paged;
 *   - the invoice page: the parts of that one invoice.
 * The customer page reads its parts in useCustomerInstalmentBillings (same columns). Browser client:
 * RLS keeps every row to the caller's company. Keyed under ["invoices"] so an invoice refresh
 * (issue, part invoice, payment) reads them again.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { InvoicePartRow } from "@/lib/invoices/invoice-period";

/** subscription_billings → its subscription's cycle + term (FK subscription_id, many-to-one). The typed client checks the columns. */
export const INVOICE_PART_COLS = "invoice_id, subscription_id, period_index, period_start, period_end, subscriptions(billing_cycle, term_months)" as const;

type PartSub = { billing_cycle?: string | null; term_months?: number | null };
/** As PostgREST answers: the embedded subscription is one object (many-to-one); the typed client calls it an array. */
export type RawPart = Omit<InvoicePartRow, "billing_cycle" | "term_months"> & { subscriptions?: PartSub | PartSub[] | null };

/** Flatten the embedded subscription (none readable → no "of N"). */
export function toInvoicePartRow(r: RawPart): InvoicePartRow {
  const sub = Array.isArray(r.subscriptions) ? r.subscriptions[0] : r.subscriptions;
  return {
    invoice_id: r.invoice_id, subscription_id: r.subscription_id, period_index: r.period_index,
    period_start: r.period_start, period_end: r.period_end,
    billing_cycle: sub?.billing_cycle ?? null, term_months: sub?.term_months ?? null,
  };
}

/** Every billed part with an invoice (`invoiceId` given → only that invoice's). */
export async function readInvoicePartRows(invoiceId?: string): Promise<InvoicePartRow[]> {
  const supabase = createClient();
  const rows = await fetchAllRows<RawPart>((from, to) => {
    let q = supabase.from("subscription_billings").select(INVOICE_PART_COLS);
    q = invoiceId ? q.eq("invoice_id", invoiceId) : q.not("invoice_id", "is", null);
    return q.order("id", { ascending: true }).range(from, to);
  });
  return rows.map(toInvoicePartRow);
}

/** /invoices ({ all: true }) or one invoice page ({ invoiceId } — no read until it is known). */
export function useInvoicePartRows(scope: { all: true } | { invoiceId: string | null | undefined }) {
  const invoiceId = "all" in scope ? undefined : scope.invoiceId;
  const enabled = "all" in scope || !!invoiceId;
  return useQuery({
    queryKey: ["invoices", "part-periods", invoiceId ?? "all"],
    enabled,
    staleTime: 60_000,
    queryFn: () => readInvoicePartRows(invoiceId ?? undefined),
  });
}
