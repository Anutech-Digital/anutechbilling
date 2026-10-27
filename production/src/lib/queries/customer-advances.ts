"use client";

/**
 * R-2023: a customer's advance credit, row by row, with the receipt voucher it came from — for
 * the customer page's "Advance available ₹X" card and the advance's own page (/quotes/<holder>).
 *
 * Same rows the Record payment sheet's "Use advance" spends (customer_credits, status open —
 * redeem_customer_credits); RLS scopes the read to this company. Read-only.
 */
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queries/keys";
import { createClient } from "@/lib/supabase/client";

export interface CustomerCreditRow {
  id: string;
  amount: number;
  status: string;
  source: string | null;
  source_payment_id: string | null;
  source_quote_id: string | null;
  created_at: string | null;
  /** The receipt voucher (and its date) of the payment that created this credit. */
  receipt_voucher_no: string | null;
  received_at: string | null;
}

export function useCustomerCreditRows(customerId: string | null | undefined) {
  return useQuery({
    queryKey: [...queryKeys.customerCredits(), "rows", customerId ?? "none"],
    enabled: Boolean(customerId),
    queryFn: async (): Promise<CustomerCreditRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customer_credits")
        .select("id, amount, status, source, source_payment_id, source_quote_id, created_at")
        .eq("customer_id", customerId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []) as Omit<CustomerCreditRow, "receipt_voucher_no" | "received_at">[];
      const payIds = [...new Set(rows.map((r) => r.source_payment_id).filter((x): x is string => !!x))];
      const byPay = new Map<string, { receipt_voucher_no: string | null; received_at: string | null }>();
      if (payIds.length) {
        const { data: pays, error: pErr } = await supabase
          .from("payments").select("id, receipt_voucher_no, received_at").in("id", payIds);
        if (pErr) throw pErr;
        for (const p of pays ?? []) byPay.set(p.id, { receipt_voucher_no: p.receipt_voucher_no ?? null, received_at: p.received_at ?? null });
      }
      return rows.map((r) => ({
        ...r,
        amount: r.amount ?? 0,
        receipt_voucher_no: r.source_payment_id ? byPay.get(r.source_payment_id)?.receipt_voucher_no ?? null : null,
        received_at: r.source_payment_id ? byPay.get(r.source_payment_id)?.received_at ?? null : null,
      }));
    },
    staleTime: 30_000,
  });
}

/** One line per receipt the open advance came from: RV, date, quote, ₹ still open. */
export interface OpenAdvanceLine {
  key: string;
  receiptVoucherNo: string | null;
  receivedAt: string | null;
  sourceQuoteId: string | null;
  open: number;
}

export function openAdvanceLines(rows: readonly CustomerCreditRow[]): OpenAdvanceLine[] {
  const map = new Map<string, OpenAdvanceLine>();
  for (const r of rows) {
    if (r.status !== "open" || (r.amount ?? 0) <= 0) continue;
    const key = r.source_payment_id ?? r.id;
    const cur = map.get(key);
    if (cur) cur.open += r.amount;
    else map.set(key, {
      key, receiptVoucherNo: r.receipt_voucher_no, receivedAt: r.received_at,
      sourceQuoteId: r.source_quote_id, open: r.amount,
    });
  }
  return [...map.values()];
}
