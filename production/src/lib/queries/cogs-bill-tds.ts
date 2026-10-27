/**
 * R-1891: TDS deducted on COGS (goods) bills — s.194Q, taken when the bill was paid from a bank
 * line (bank_vendor_payment_lines, kind bill / new_bill, migration 20261024230000). It is NOT on
 * an expense row, so every reader of "TDS we deducted" (TDS payable, 26Q working, the months with
 * a TDS deposit) adds these rows. Paged past the gateway's 1000-row cap.
 */
import { fetchAllRows, type PageQuery } from "@/lib/ops/fetch-all";
import type { createClient } from "@/lib/supabase/client";

export interface CogsBillTdsRow {
  id: string;
  /** Date the TDS was deducted (the bank date). */
  tds_on: string | null;
  tds_amount: number;
  tds_section: string | null;
  /** The amount the TDS was worked on (194Q: the part above ₹50 lakh, without GST). */
  tds_base: number;
  vendor_id: string | null;
  vendor_bill_id: string | null;
}

/* The table is not in the generated types yet (R-1866). */
export async function fetchCogsBillTds(
  supabase: ReturnType<typeof createClient>,
  range: { from?: string; to?: string } = {},
): Promise<CogsBillTdsRow[]> {
  return fetchAllRows<CogsBillTdsRow>((from, to) => {
    let q = supabase
      .from("bank_vendor_payment_lines" as never)
      .select("id, tds_on, tds_amount, tds_section, tds_base, vendor_id, vendor_bill_id")
      .in("kind", ["bill", "new_bill"])
      .gt("tds_amount", 0);
    if (range.from) q = q.gte("tds_on", range.from);
    if (range.to) q = q.lte("tds_on", range.to);
    return q.order("id", { ascending: true }).range(from, to) as unknown as PageQuery<CogsBillTdsRow>;
  });
}
