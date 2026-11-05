/**
 * R-2499 — the scan and the app facts the plan needs, for ONE company, through the server's admin
 * client. The admin client bypasses RLS, so EVERY read and write below is filtered by `tenantId`
 * (CLAUDE.md §17c); the tenant comes from the signed-in user's own row (resolveZohoCaller), never
 * from the request.
 */
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { readBooksStart, type BooksStartDb } from "@/lib/accounting/books-start";
import type { ZohoSaleFacts } from "./normalise";
import type { ScanStore, ScanRun, ListedRow } from "./scan";
import type { MonthTotals, PlanContext } from "./plan";
import { splitTaxHeads } from "@/lib/gst/tax-split";

type Res<T = unknown> = PromiseLike<{ data: T | null; error: { message?: string; code?: string } | null }>;
/** The slice of the Supabase query builder used here (the new tables are not in the generated types yet). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;
export interface SalesImportDb { from(table: string): Q }


function must<T>(r: { data: T | null; error: { message?: string } | null }, what: string): T {
  if (r.error) throw new Error(`Could not read ${what}.`);
  return (r.data ?? ([] as unknown)) as T;
}

export function supabaseScanStore(db: SalesImportDb, tenantId: string): ScanStore {
  const scan = () => db.from("zoho_sale_import_scan");
  return {
    async readRun(fy) {
      const r = await (db.from("zoho_sale_import_runs").select("next_page, list_done").eq("tenant_id", tenantId).eq("fy", fy).limit(1) as Res<Array<{ next_page: number; list_done: boolean }>>);
      const row = must(r, "the Zoho read")[0];
      return row ? { nextPage: row.next_page, listDone: row.list_done } : null;
    },
    async saveRun(fy, run: ScanRun) {
      const r = await (db.from("zoho_sale_import_runs").upsert(
        { tenant_id: tenantId, fy, next_page: run.nextPage, list_done: run.listDone, updated_at: new Date().toISOString() },
        { onConflict: "tenant_id,fy" }) as Res);
      if (r.error) throw new Error("Could not save the Zoho read.");
    },
    async addListed(fy, rows: ListedRow[]) {
      if (!rows.length) return;
      const ids = rows.map((x) => x.zohoId);
      const known = must(await (scan().select("zoho_invoice_id, zoho_status, fy").eq("tenant_id", tenantId).in("zoho_invoice_id", ids) as Res<Array<{ zoho_invoice_id: string; zoho_status: string; fy: string }>>), "the Zoho read");
      const prev = new Map(known.map((k) => [k.zoho_invoice_id, k]));
      const upserts = rows.map((x) => {
        const p = prev.get(x.zohoId);
        /* Status changed in Zoho since it was read (draft → sent, sent → void): read the detail again. */
        const stale = !p || p.zoho_status !== x.status || p.fy !== fy;
        return {
          tenant_id: tenantId, fy, zoho_invoice_id: x.zohoId, number: x.number.slice(0, 60), invoice_date: x.date || null,
          zoho_status: x.status, listed_at: new Date().toISOString(),
          ...(stale ? { payload: null, detailed_at: null } : {}),
        };
      });
      /* Two shapes (with / without the payload reset) → two upserts, so a kept payload is never nulled. */
      for (const group of [upserts.filter((u) => "payload" in u), upserts.filter((u) => !("payload" in u))]) {
        if (!group.length) continue;
        const r = await (scan().upsert(group, { onConflict: "tenant_id,zoho_invoice_id" }) as Res);
        if (r.error) throw new Error("Could not save the Zoho read.");
      }
    },
    async pendingDetails(fy, limit) {
      const r = await (scan().select("zoho_invoice_id").eq("tenant_id", tenantId).eq("fy", fy).is("payload", null)
        .order("invoice_date", { ascending: true }).order("zoho_invoice_id", { ascending: true }).limit(limit) as Res<Array<{ zoho_invoice_id: string }>>);
      return must(r, "the Zoho read").map((x) => x.zoho_invoice_id);
    },
    async saveDetail(fy, zohoId, facts: ZohoSaleFacts) {
      const r = await (scan().update({ payload: facts, detailed_at: new Date().toISOString(), zoho_status: facts.status, number: facts.number.slice(0, 60), invoice_date: facts.date || null })
        .eq("tenant_id", tenantId).eq("fy", fy).eq("zoho_invoice_id", zohoId) as Res);
      if (r.error) throw new Error("Could not save the Zoho read.");
    },
    async counts(fy) {
      const head = (detailed: boolean) => {
        let q = scan().select("zoho_invoice_id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("fy", fy);
        q = detailed ? q.not("payload", "is", null) : q;
        return q as PromiseLike<{ count: number | null; error: unknown }>;
      };
      const [a, b] = await Promise.all([head(false), head(true)]);
      if (a.error || b.error) throw new Error("Could not count the Zoho read.");
      return { listed: a.count ?? 0, detailed: b.count ?? 0 };
    },
    async reset(fy) {
      const a = await (db.from("zoho_sale_import_runs").delete().eq("tenant_id", tenantId).eq("fy", fy) as Res);
      const b = await (scan().delete().eq("tenant_id", tenantId).eq("fy", fy) as Res);
      if (a.error || b.error) throw new Error("Could not clear the Zoho read.");
    },
  };
}

/** Every scanned invoice of the FY with its facts (detailed ones only). */
export async function readScannedFacts(db: SalesImportDb, tenantId: string, fy: string): Promise<ZohoSaleFacts[]> {
  const rows = await fetchAllRows<{ payload: ZohoSaleFacts }>((from, to) => db.from("zoho_sale_import_scan")
    .select("payload").eq("tenant_id", tenantId).eq("fy", fy).not("payload", "is", null)
    .order("invoice_date", { ascending: true }).order("zoho_invoice_id", { ascending: true }).range(from, to));
  return rows.map((r) => r.payload);
}

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

export interface SaleBatch {
  id: string; createdAt: string; importedCount: number; skippedCount: number; alreadyCount: number;
  taxableTotal: number; taxTotal: number; removedAt: string | null;
}

/** This company's import batches for the FY, newest first. */
export async function readSaleBatches(db: SalesImportDb, tenantId: string, fy: string): Promise<SaleBatch[]> {
  const r = await (db.from("zoho_sale_import_batches")
    .select("id, created_at, imported_count, skipped_count, already_count, taxable_total, tax_total, removed_at")
    .eq("tenant_id", tenantId).eq("fy", fy).order("created_at", { ascending: false }).limit(50) as Res<Array<Record<string, unknown>>>);
  return must(r, "the imports").map((b) => ({
    id: String(b.id), createdAt: String(b.created_at), importedCount: Number(b.imported_count), skippedCount: Number(b.skipped_count),
    alreadyCount: Number(b.already_count), taxableTotal: Number(b.taxable_total), taxTotal: Number(b.tax_total),
    removedAt: (b.removed_at as string | null) ?? null,
  }));
}
