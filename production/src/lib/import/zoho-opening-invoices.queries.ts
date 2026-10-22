/**
 * R-1739 — data for "Import open invoices from Zoho": what the preview needs (customers and
 * the Zoho numbers already imported), the import itself (import_opening_invoices — one
 * atomic batch) and the list of past imports with "Remove import"
 * (remove_opening_invoice_import — refused once a payment touches the batch).
 * Reads go through RLS on the browser client: only the signed-in company's rows.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { toastError } from "@/lib/errors/toast-error";
import { OPENING_INVOICE_KIND } from "@/lib/accounting/sale-documents";
import type { CustomerLite } from "./zoho-opening-invoices";
import type { toImportRpcRows } from "./zoho-opening-invoices";

export interface ImportContext {
  customers: CustomerLite[];
  /** Zoho numbers already in the company, upper-cased. */
  existingNumbers: Set<string>;
}

/** Customers + numbers already imported. Paged (R-264): never a silent 1000-row stop. */
export async function fetchImportContext(): Promise<ImportContext> {
  const supabase = createClient();
  const [customers, numbers] = await Promise.all([
    fetchAllRows<CustomerLite>((from, to) =>
      supabase.from("customers").select("id, name, gstin").order("id", { ascending: true }).range(from, to) as never),
    fetchAllRows<{ external_number: string | null }>((from, to) =>
      supabase.from("invoices").select("external_number, id")
        .eq("document_kind", OPENING_INVOICE_KIND)
        .order("id", { ascending: true })
        .range(from, to) as never),
  ]);
  return {
    customers,
    existingNumbers: new Set(numbers.map((n) => (n.external_number ?? "").toUpperCase()).filter(Boolean)),
  };
}

export interface InvoiceImportBatch {
  id: string;
  file_name: string | null;
  row_count: number;
  skipped_count: number;
  total_balance: number;
  created_at: string;
  removed_at: string | null;
  remove_reason: string | null;
  removed_rows: number | null;
}

export function useInvoiceImportBatches(enabled = true) {
  return useQuery({
    queryKey: ["invoice-import-batches"],
    enabled,
    queryFn: async (): Promise<InvoiceImportBatch[]> => {
      const supabase = createClient();
      return fetchAllRows<InvoiceImportBatch>((from, to) =>
        supabase.from("invoice_import_batches")
          .select("id, file_name, row_count, skipped_count, total_balance, created_at, removed_at, remove_reason, removed_rows")
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to) as never);
    },
  });
}

export interface ImportResult {
  batch_id: string;
  imported: number;
  skipped: string[];
  total_balance: number;
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [["invoices"], ["invoice-import-batches"], ["balance-sheet"], ["outstanding-receivables"], ["aging"], ["collections"]]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

export function useImportOpeningInvoices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { rows: ReturnType<typeof toImportRpcRows>; fileName: string | null }): Promise<ImportResult> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("import_opening_invoices", {
        p_rows: args.rows as never,
        p_file_name: args.fileName ?? undefined,
      });
      if (error) throw error;
      const r = (data ?? {}) as Partial<ImportResult>;
      return {
        batch_id: String(r.batch_id ?? ""),
        imported: Number(r.imported ?? 0),
        skipped: Array.isArray(r.skipped) ? r.skipped.map(String) : [],
        total_balance: Number(r.total_balance ?? 0),
      };
    },
    onSuccess: () => invalidateAll(qc),
    onError: (err) => toastError(err),
  });
}

export function useRemoveOpeningInvoiceImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { batchId: string; reason: string }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("remove_opening_invoice_import", {
        p_batch_id: args.batchId,
        p_reason: args.reason,
      });
      if (error) throw error;
      return data as { removed: number };
    },
    onSuccess: () => invalidateAll(qc),
    onError: (err) => toastError(err),
  });
}
