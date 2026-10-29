/**
 * R-2055 — the open payment request (R-2044) of a subscription billed in parts, for the SALE
 * quote's page: "Record next instalment" is one way only — open that request when the billing
 * run has raised it, else nothing until the part's bill date.
 *
 * A request is a quote with subscription_billing_id → subscription_billings(subscription_id).
 * Open = sent / viewed / accepted, no invoice, not paid in full (commitment-due.ts rules).
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

export interface NextPartRequest { id: string; number: string }

interface RequestRow {
  id: string;
  status: string;
  invoice_id: string | null;
  payment_status: string | null;
  subscription_billing_id: string | null;
}

/** The earliest open request among `rows`, ordered by the part's period. Pure — tested. */
export function pickNextPartRequest(
  rows: readonly RequestRow[],
  periodOf: ReadonlyMap<string, number>,
): NextPartRequest | null {
  const open = rows
    .filter((r) => r.subscription_billing_id && periodOf.has(r.subscription_billing_id))
    .filter((r) => ["sent", "viewed", "accepted"].includes(r.status))
    .filter((r) => !r.invoice_id && r.payment_status !== "received" && r.payment_status !== "invoiced")
    .sort((a, b) => (periodOf.get(a.subscription_billing_id!) ?? 0) - (periodOf.get(b.subscription_billing_id!) ?? 0));
  const r = open[0];
  return r ? { id: r.id, number: r.id } : null;
}

export function useNextPartRequest(subscriptionId: string | null | undefined) {
  return useQuery({
    queryKey: ["quote-next-part-request", subscriptionId],
    enabled: Boolean(subscriptionId),
    queryFn: async (): Promise<NextPartRequest | null> => {
      const supabase = createClient();
      const { data: bills, error } = await supabase
        .from("subscription_billings")
        .select("id, period_index")
        .eq("subscription_id", subscriptionId!);
      if (error) throw error;
      const periodOf = new Map((bills ?? []).map((b) => [b.id as string, b.period_index as number]));
      if (periodOf.size === 0) return null;
      /* subscription_billing_id is an R-2044 column, not in the generated types yet. */
      const loose = supabase as unknown as { from: (t: string) => { select: (c: string) => { in: (c: string, v: string[]) => Promise<{ data: RequestRow[] | null; error: unknown }> } } };
      const { data: reqs, error: e2 } = await loose
        .from("quotes")
        .select("id, status, invoice_id, payment_status, subscription_billing_id")
        .in("subscription_billing_id", [...periodOf.keys()]);
      if (e2) throw e2;
      return pickNextPartRequest(reqs ?? [], periodOf);
    },
  });
}
