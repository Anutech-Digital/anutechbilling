/**
 * R-2101 — the tax invoices raised for the parts of a SALE quote billed in parts, for the quote
 * page's INVOICED step.
 *
 * A part's invoice (raise_subscription_billing; one per quote period since R-2092) is linked
 * through subscription_billings.invoice_id — never through invoices.quote_id, which build-props,
 * record payment and dunning read as "this invoice IS the quote" and would print the whole term's
 * amounts on a ₹95,993 part. So the quote page found no invoice and said "No invoice yet" beside a
 * paid, invoiced Q1 (localhost, 29 Oct).
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

interface PartRow { invoice_id: string | null; period_start: string | null }

/** Distinct invoice ids in period order, void ones left out. Pure — tested. */
export function partInvoiceIds(rows: readonly PartRow[], voidIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const r of [...rows].sort((a, b) => (a.period_start ?? "").localeCompare(b.period_start ?? ""))) {
    if (!r.invoice_id || voidIds.has(r.invoice_id) || out.includes(r.invoice_id)) continue;
    out.push(r.invoice_id);
  }
  return out;
}

export function useQuotePartInvoices(subscriptionIds: readonly string[]) {
  const ids = [...subscriptionIds].sort();
  return useQuery({
    queryKey: ["quote-part-invoices", ids],
    enabled: ids.length > 0,
    /* R-2104: the quote page waits for the FIRST read only; a new subscription id after a payment
       keeps the last answer on screen while it refetches (no skeleton flash, no open sheet lost). */
    placeholderData: (prev: string[] | undefined) => prev,
    queryFn: async (): Promise<string[]> => {
      const supabase = createClient();
      const { data: rows, error } = await supabase
        .from("subscription_billings")
        .select("invoice_id, period_start")
        .in("subscription_id", ids)
        .not("invoice_id", "is", null);
      if (error) throw error;
      const invIds = Array.from(new Set((rows ?? []).map((r) => r.invoice_id).filter((x): x is string => !!x)));
      if (invIds.length === 0) return [];
      const { data: invs, error: e2 } = await supabase.from("invoices").select("id, status").in("id", invIds);
      if (e2) throw e2;
      const voidIds = new Set((invs ?? []).filter((i) => i.status === "void").map((i) => i.id));
      return partInvoiceIds(rows ?? [], voidIds);
    },
  });
}
