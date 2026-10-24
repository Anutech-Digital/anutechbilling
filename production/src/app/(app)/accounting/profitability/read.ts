/**
 * R-1586: the Profitability report's reads — every revenue quote in the range and every
 * customer's PO summary, not the first 1000 of each.
 *
 * The data gateway answers at most 1000 rows a request (src/server/postgrest/build.ts
 * MAX_ROWS) and says nothing when it cut the answer short.
 */
import { fetchAllRows, fetchAllRowsIn, type PageQuery } from "@/lib/ops/fetch-all";
import type { createClient } from "@/lib/supabase/client";

type DateRange = { from: string; to: string };

/** Quotes that have actually generated revenue (paid or invoiced), created in the range. */
export async function readRevenueQuotes(supabase: ReturnType<typeof createClient>, range: DateRange) {
  return fetchAllRows((from, to) => supabase
    .from("quotes")
    .select("id, customer_id, customer_name, amount, tax_rate, line_items, seats, created_date, payment_status")
    .gte("created_date", range.from)
    .lte("created_date", range.to)
    .in("payment_status", ["received", "partial", "invoiced"])
    .order("id", { ascending: true })
    .range(from, to));
}

export type PoSummaryRow = { customer_id: string | null; allocated_total: number; allocation_count: number };

/** Real cost from PO allocations, for these customers (one row per purchase order). */
export async function readPoSummaries(supabase: ReturnType<typeof createClient>, customerIds: readonly string[]) {
  return fetchAllRowsIn(customerIds, (run, from, to) => supabase
    .from("purchase_order_summary" as never)
    .select("customer_id, allocated_total, allocation_count")
    .in("customer_id", run)
    .order("purchase_order_id", { ascending: true })
    .range(from, to) as unknown as PageQuery<PoSummaryRow>);
}
