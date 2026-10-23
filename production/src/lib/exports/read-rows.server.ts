/**
 * R-1007 — the rows of a server export, read through the CALLER's own Supabase client.
 *
 * The client carries the signed-in session, so RLS decides exactly as it does on screen: the
 * caller's company only, and (R-1004) only the leads / customers that role may see in full.
 * `.eq("tenant_id", tenantId)` is added on top as a belt — it can only narrow.
 * Every list is paged past PostgREST's 1000-row cap (fetchAllRows; order ends on id).
 */
import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import {
  CUSTOMERS_CSV_HEADERS, customersCsvRows, LEADS_CSV_HEADERS, leadsCsvRows, INVOICES_CSV_HEADERS, invoicesCsvRows,
} from "@/lib/export/crm-csv";
import type { Customer, Invoice } from "@/lib/supabase/database.types";
import type { Cell, ExportKind } from "./server-export";

type Client = ReturnType<typeof createClient>;

const CUSTOMER_EXPORT_COLUMNS =
  "id, name, display_name, customer_number, customer_type, domain, gstin, state, state_code, country, contact_name, contact_email, contact_phone, payment_terms_days, tan, tds_default_section, tds_default_rate_pct, since, notes";
const LEAD_EXPORT_COLUMNS =
  "id, company, contact_name, contact_email, contact_phone, plan, seats, value, stage, source, lost_reason, created_at";
const INVOICE_EXPORT_COLUMNS =
  "id, customer_name, status, invoice_date, due_date, taxable_value, tax_amount, amount, paid_amount, gst_irn";

export interface ExportTable { headers: readonly string[]; rows: Cell[][] }

/** `ids` narrows to the rows the user ticked (invoices' bulk bar); absent = every row they can see. */
export async function readExportRows(supabase: Client, tenantId: string, kind: ExportKind, ids?: readonly string[]): Promise<ExportTable> {
  if (kind === "customers") {
    const rows = await fetchAllRows((from, to) => supabase
      .from("customers").select(CUSTOMER_EXPORT_COLUMNS).eq("tenant_id", tenantId)
      .order("name", { ascending: true }).order("id", { ascending: true }).range(from, to));
    return { headers: CUSTOMERS_CSV_HEADERS, rows: customersCsvRows(rows as unknown as Customer[]) };
  }
  if (kind === "leads") {
    const rows = await fetchAllRows((from, to) => supabase
      .from("leads").select(LEAD_EXPORT_COLUMNS).eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to));
    return { headers: LEADS_CSV_HEADERS, rows: leadsCsvRows(rows as unknown as Parameters<typeof leadsCsvRows>[0]) };
  }
  const rows = ids && ids.length > 0
    ? await fetchAllRowsIn(ids, (chunk, from, to) => supabase
      .from("invoices").select(INVOICE_EXPORT_COLUMNS).eq("tenant_id", tenantId).in("id", chunk)
      .order("invoice_date", { ascending: false }).order("id", { ascending: false }).range(from, to))
    : await fetchAllRows((from, to) => supabase
      .from("invoices").select(INVOICE_EXPORT_COLUMNS).eq("tenant_id", tenantId)
      .order("invoice_date", { ascending: false }).order("id", { ascending: false }).range(from, to));
  return { headers: INVOICES_CSV_HEADERS, rows: invoicesCsvRows(rows as unknown as Invoice[]) };
}
