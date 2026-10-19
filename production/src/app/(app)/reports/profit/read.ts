/**
 * R-1586: the Profit-by-product report's read — EVERY revenue quote ever, not the first 1000.
 *
 * The data gateway answers at most 1000 rows a request (src/server/postgrest/build.ts
 * MAX_ROWS) and says nothing when it cut the answer short. This report has no date filter,
 * so it went wrong for good once the business passed 1000 paid quotes.
 */
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { createClient } from "@/lib/supabase/client";

/** Revenue-generating quotes only (money actually in the flow) — their lines. */
export async function readRevenueQuoteLines(supabase: ReturnType<typeof createClient>) {
  return fetchAllRows((from, to) => supabase
    .from("quotes")
    .select("line_items, payment_status")
    .in("payment_status", ["received", "partial", "invoiced"])
    .order("id", { ascending: true })
    .range(from, to));
}
