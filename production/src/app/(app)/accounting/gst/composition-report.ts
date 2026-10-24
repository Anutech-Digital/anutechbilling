/**
 * R-1530: loader for the composition scheme report (CMP-08 / GSTR-4). The maths is in
 * lib/compliance/composition-return.ts; this reads the year's composition Bills of Supply
 * and the credit / debit notes dated in the year, with the bill each note is against.
 *
 * Every list read pages past the gateway's 1000-row cap (fetchAllRows / fetchAllRowsIn,
 * ordered by id). A failed read throws — the card shows LoadError, never ₹0 (§17c).
 */
import { useQuery } from "@tanstack/react-query";

import type { CompositionDoc, CompositionNote } from "@/lib/compliance/composition-return";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { createClient } from "@/lib/supabase/client";

export interface CompositionRows {
  docs: CompositionDoc[];
  notes: CompositionNote[];
}

export async function loadCompositionRows(
  supabase: ReturnType<typeof createClient>,
  fy: { from: string; to: string },
): Promise<CompositionRows> {
  const [docs, credits, debits] = await Promise.all([
    fetchAllRows((from, to) => supabase.from("invoices")
      .select("id, invoice_date, amount, taxable_value, status, document_kind, supplier_gst_status")
      .eq("document_kind", "bill_of_supply")
      .eq("supplier_gst_status", "composition")
      .in("status", ["pending", "paid", "overdue"])
      .gte("invoice_date", fy.from).lte("invoice_date", fy.to)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("credit_notes")
      .select("id, invoice_id, credit_date, amount, taxable_value")
      .gte("credit_date", fy.from).lte("credit_date", fy.to)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("debit_notes")
      .select("id, invoice_id, debit_date, amount, taxable_value")
      .gte("debit_date", fy.from).lte("debit_date", fy.to)
      .order("id", { ascending: true }).range(from, to)),
  ]);

  // The bill each note is against — a note on last year's bill still counts in this year.
  const billIds = [...credits, ...debits].map((n) => n.invoice_id);
  const bills = await fetchAllRowsIn(billIds, (run, from, to) => supabase.from("invoices")
    .select("id, document_kind, supplier_gst_status").in("id", run)
    .order("id", { ascending: true }).range(from, to));
  const billById = new Map(bills.map((b) => [b.id, b]));
  const value = (n: { taxable_value: number | null; amount: number | null }) =>
    Number(n.taxable_value ?? n.amount ?? 0);

  return {
    docs,
    notes: [
      ...credits.map((n): CompositionNote => ({ kind: "credit", date: n.credit_date, value: value(n), invoice: billById.get(n.invoice_id) ?? null })),
      ...debits.map((n): CompositionNote => ({ kind: "debit", date: n.debit_date, value: value(n), invoice: billById.get(n.invoice_id) ?? null })),
    ],
  };
}

export function useCompositionRows(fy: { from: string; to: string }, enabled: boolean) {
  return useQuery({
    queryKey: ["gst_composition_rows", fy.from, fy.to],
    enabled,
    queryFn: () => loadCompositionRows(createClient(), fy),
  });
}
