/**
 * R-1586: the Aging report's read — every open invoice, not the first 1000.
 *
 * The data gateway answers at most 1000 rows a request (src/server/postgrest/build.ts
 * MAX_ROWS) and says nothing when it cut the answer short. One unpaged select here left
 * every customer past the 1000th open invoice off the receivable total.
 */
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { createClient } from "@/lib/supabase/client";

/** Unpaid / partially-paid invoices = the outstanding pool. */
export async function readOpenInvoices(supabase: ReturnType<typeof createClient>) {
  return fetchAllRows((from, to) => supabase
    .from("invoices")
    .select("id, customer_id, customer_name, amount, net_payable, paid_amount, status, invoice_date, due_date")
    .in("status", ["pending", "overdue"]).is("written_off_at", null)
    .order("id", { ascending: true })
    .range(from, to));
}
