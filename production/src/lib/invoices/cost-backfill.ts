/**
 * R-487 — "Fill missing costs" on /invoices (owner only, preview first).
 *
 * Why: generate_invoice() never copied the quote's lines onto the invoice, so every
 * quote invoice had line_items NULL and Margin MTD said "Cost missing on N lines".
 * Migration 20261009180000 makes NEW invoices copy the quote lines with their cost. Old
 * invoices are not touched by the migration; the owner previews what would be filled
 * (invoice_cost_fill_preview) and confirms (invoice_cost_fill_apply). Only the internal
 * line cost is written — amount, taxable value and tax never move.
 *
 * The RPCs are not in database.generated.ts yet (that file is locked by another worker);
 * the narrow signatures below stand in for it — drop them after
 * `node scripts/check-db-types.mjs --write`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type CostFillSource = "quote" | "catalog" | "missing";

export interface CostFillRow {
  invoice_id: string;
  invoice_date: string;
  customer_name: string | null;
  line_index: number;
  line_name: string | null;
  qty: number | null;
  rate: number;
  /** ₹ cost per unit the line will carry, or null when no source knows it. */
  cost_new: number | null;
  source: CostFillSource;
  /** "books_locked" when the invoice date is inside a locked period — skipped on apply. */
  blocked: string | null;
}

export interface CostFillResult {
  invoices_updated: number;
  lines_costed: number;
  skipped_locked: number;
}

export interface CostFillSummary {
  /** Lines that will get a cost (quote or catalogue), outside a books lock. */
  fillable: number;
  fromQuote: number;
  fromCatalog: number;
  /** Lines nobody knows the cost of — they stay missing. */
  stillMissing: number;
  /** Fillable lines skipped because the books are locked for their date. */
  locked: number;
  /** Invoices that the apply call should receive. */
  invoiceIds: string[];
}

export function summarizeCostFill(rows: readonly CostFillRow[]): CostFillSummary {
  const ids = new Set<string>();
  const s: CostFillSummary = { fillable: 0, fromQuote: 0, fromCatalog: 0, stillMissing: 0, locked: 0, invoiceIds: [] };
  for (const r of rows) {
    if (r.cost_new == null || r.source === "missing") { s.stillMissing += 1; continue; }
    if (r.blocked) { s.locked += 1; continue; }
    s.fillable += 1;
    if (r.source === "catalog") s.fromCatalog += 1; else s.fromQuote += 1;
    ids.add(r.invoice_id);
  }
  s.invoiceIds = Array.from(ids);
  return s;
}

type Rpc = <T>(
  fn: "invoice_cost_fill_preview" | "invoice_cost_fill_apply",
  params?: { p_invoice_ids: string[] },
) => PromiseLike<{ data: T | null; error: { message: string } | null }>;

function rpcOf(supabase: SupabaseClient): Rpc {
  return supabase.rpc.bind(supabase) as unknown as Rpc;
}

export async function fetchCostFillPreview(supabase: SupabaseClient): Promise<CostFillRow[]> {
  const { data, error } = await rpcOf(supabase)<CostFillRow[]>("invoice_cost_fill_preview");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ ...r, qty: r.qty == null ? null : Number(r.qty), rate: Number(r.rate) }));
}

export async function applyCostFill(supabase: SupabaseClient, invoiceIds: string[]): Promise<CostFillResult> {
  const { data, error } = await rpcOf(supabase)<CostFillResult>("invoice_cost_fill_apply", { p_invoice_ids: invoiceIds });
  if (error) throw new Error(error.message);
  return data ?? { invoices_updated: 0, lines_costed: 0, skipped_locked: 0 };
}
