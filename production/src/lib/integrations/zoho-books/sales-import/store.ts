/**
 * R-2499 — what the FY sales import needs from the app for ONE company (customers, catalogue,
 * invoices already carrying a Zoho number / id, books start, lock) and the per-month recount of
 * what came in. The admin client bypasses RLS, so every read is filtered by `tenantId`
 * (CLAUDE.md §17c). The generic scan / batch store is ../fy-import/store.ts.
 */
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { readBooksStart, type BooksStartDb } from "@/lib/accounting/books-start";
import { splitTaxHeads } from "@/lib/gst/tax-split";
import { must, type FyImportDb } from "../fy-import/store";
import type { MonthTotals, PlanContext } from "./plan";

type Res<T = unknown> = PromiseLike<{ data: T | null; error: { message?: string; code?: string } | null }>;
type SalesImportDb = FyImportDb;

/** What the plan needs from the app for this company. */
export async function readPlanContext(db: SalesImportDb, tenantId: string, range: { dateStart: string; dateEnd: string }): Promise<PlanContext & { sellerStateCode: string | null }> {
  const [bs, tenant, customers, items, invoices] = await Promise.all([
    readBooksStart(db as unknown as BooksStartDb, tenantId),
    db.from("tenants").select("books_locked_until, state_code").eq("id", tenantId).limit(1) as Res<Array<{ books_locked_until: string | null; state_code: string | null }>>,
    fetchAllRows<{ id: string; name: string; gstin: string | null }>((from, to) => db.from("customers")
      .select("id, name, gstin").eq("tenant_id", tenantId).order("id", { ascending: true }).range(from, to)),
    fetchAllRows<{ id: string; name: string }>((from, to) => db.from("items")
      .select("id, name").eq("tenant_id", tenantId).order("id", { ascending: true }).range(from, to)),
    fetchAllRows<{ id: string; external_number: string | null; document_kind: string; zoho_invoice_id: string | null }>((from, to) => db.from("invoices")
      .select("id, external_number, document_kind, zoho_invoice_id").eq("tenant_id", tenantId)
      .or("external_number.not.is.null,zoho_invoice_id.not.is.null")
      .order("id", { ascending: true }).range(from, to)),
  ]);
  const t = must(tenant, "the company")[0];
  return {
    fyStart: range.dateStart,
    fyEnd: range.dateEnd,
    booksStart: bs.start,
    lockedUntil: t?.books_locked_until ?? null,
    sellerStateCode: t?.state_code ? String(t.state_code).padStart(2, "0") : null,
    customers,
    items,
    invoices: invoices.map((i) => ({ id: i.id, externalNumber: i.external_number, documentKind: i.document_kind, zohoInvoiceId: i.zoho_invoice_id })),
  };
}

/** The tenant's own GST state code (for a scan's no-tax head). */
export async function readSellerState(db: SalesImportDb, tenantId: string): Promise<string | null> {
  const r = await (db.from("tenants").select("state_code").eq("id", tenantId).limit(1) as Res<Array<{ state_code: string | null }>>);
  const s = must(r, "the company")[0]?.state_code;
  return s ? String(s).padStart(2, "0") : null;
}


/**
 * What the app already holds from Zoho for the FY, per month — read back from the invoices
 * themselves (the server-side recount: the screen compares it with Zoho's months).
 */
export async function readImportedByMonth(db: SalesImportDb, tenantId: string, range: { dateStart: string; dateEnd: string }): Promise<MonthTotals[]> {
  const rows = await fetchAllRows<{ invoice_date: string; taxable_value: number | null; tax_amount: number | null; amount: number; inter_state: boolean | null }>((from, to) => db.from("invoices")
    .select("invoice_date, taxable_value, tax_amount, amount, inter_state").eq("tenant_id", tenantId)
    .not("zoho_invoice_id", "is", null).gte("invoice_date", range.dateStart).lte("invoice_date", range.dateEnd)
    .order("id", { ascending: true }).range(from, to));
  const m = new Map<string, MonthTotals>();
  for (const r of rows) {
    const month = r.invoice_date.slice(0, 7);
    const t = m.get(month) ?? { month, count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, amount: 0 };
    const h = splitTaxHeads(Number(r.tax_amount ?? 0), r.inter_state === true);
    t.count += 1; t.taxable += Number(r.taxable_value ?? 0); t.igst += h.igst; t.cgst += h.cgst; t.sgst += h.sgst; t.amount += Number(r.amount);
    m.set(month, t);
  }
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
}
