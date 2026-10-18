/**
 * R-1586: the 26Q (non-salary TDS) export's reads — every TDS-deducted expense in the range
 * and every vendor behind them, not the first 1000.
 *
 * The data gateway answers at most 1000 rows a request (src/server/postgrest/build.ts
 * MAX_ROWS) and says nothing when it cut the answer short. A 26Q missing deductees is a
 * short TDS return.
 */
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import type { createClient } from "@/lib/supabase/client";

export async function read26Q(supabase: ReturnType<typeof createClient>, range: { from: string; to: string }) {
  const exps = await fetchAllRows((from, to) => supabase
    .from("expenses")
    .select("id, expense_date, vendor_name, vendor_id, amount, gst_paid, tds_section, tds_amount")
    .gte("expense_date", range.from).lte("expense_date", range.to)
    .gt("tds_amount", 0)
    .order("id", { ascending: true })
    .range(from, to));
  const vends = await fetchAllRowsIn(exps.map((e) => e.vendor_id), (run, from, to) => supabase
    .from("vendors").select("id, gstin, pan").in("id", run)
    .order("id", { ascending: true })
    .range(from, to));
  return { exps, vends };
}
