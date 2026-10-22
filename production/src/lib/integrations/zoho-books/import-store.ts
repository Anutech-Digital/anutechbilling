/**
 * R-1753 — the database side of "Import from Zoho" (server only).
 *
 * Every read and write here is filtered by the CALLER's tenant id (from their own users row,
 * resolveZohoCaller) and, for records, by the run id as well. The service-role client is
 * used because the run / record tables take writes from the server only; the database also
 * hides them from other tenants by RLS (supabase/tests/zoho_books_import_r1753.test.sql).
 */
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { utcDateISO } from "@/lib/dates/ist";
import { OPENING_INVOICE_KIND } from "@/lib/accounting/sale-documents";
import type { createAdminClientFor } from "@/lib/supabase/server";
import type { ScanRecord, ScanRun, ScanStore } from "./import-scan";
import type {
  CatalogItem, ExistingCustomer, ZohoContactRec, ZohoInvoiceRec, ZohoLineRec,
} from "./import-plan";
import type { TrackedSubscription } from "@/lib/subscriptions/import-dedupe";

/** Subscriptions are read from invoices of the last N months (card: 24, the screen offers 12 / 24 / 36). */
export const DEFAULT_MONTHS = 24;
export const ALLOWED_MONTHS = [12, 24, 36];

/** The first day of the window: today minus N months (YYYY-MM-DD). */
export function sinceFor(today: string, months: number): string {
  const [y, m, d] = today.split("-").map(Number);
  return utcDateISO(new Date(Date.UTC(y, m - 1 - months, d)));
}

type Db = ReturnType<typeof createAdminClientFor>;
/* The run / record tables are newer than the generated types the client is typed with. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loose = (admin: Db) => admin as any;

export const RUN_COLS =
  "id, org_id, since, months, phase, next_page, contacts_read, invoices_read, details_total, details_done, last_error, started_at, updated_at, scanned_at, imported_at, result, undone_at, undo_reason";

export interface RunRow extends ScanRun {
  months: number;
  last_error: string | null;
  started_at: string;
  updated_at: string;
  scanned_at: string | null;
  imported_at: string | null;
  result: Record<string, unknown> | null;
  undone_at: string | null;
  undo_reason: string | null;
}

/** The unfinished run (not imported) and the latest import, for this tenant only. */
export async function readRuns(admin: Db, tenantId: string): Promise<{ open: RunRow | null; lastImport: RunRow | null }> {
  const { data, error } = await loose(admin).from("zoho_books_import_runs").select(RUN_COLS)
    .eq("tenant_id", tenantId).order("started_at", { ascending: false }).limit(20);
  if (error) throw new Error("Could not read the Zoho import status.");
  const rows = (data ?? []) as RunRow[];
  return {
    open: rows.find((r) => !r.imported_at) ?? null,
    lastImport: rows.find((r) => r.imported_at) ?? null,
  };
}

/** A new dry run: the unfinished one (and what it read) is replaced. */
export async function startRun(admin: Db, tenantId: string, userId: string, orgId: string, since: string, months: number): Promise<RunRow> {
  const db = loose(admin);
  const del = await db.from("zoho_books_import_runs").delete().eq("tenant_id", tenantId).is("imported_at", null);
  if (del.error) throw new Error("Could not clear the previous dry run.");
  const { data, error } = await db.from("zoho_books_import_runs")
    .insert({ tenant_id: tenantId, org_id: orgId, since, months, started_by: userId })
    .select(RUN_COLS).single();
  if (error || !data) throw new Error("Could not start the dry run.");
  return data as RunRow;
}

export function supabaseScanStore(admin: Db, tenantId: string, runId: string): ScanStore {
  const db = loose(admin);
  const check = (r: { error: unknown }, what: string) => { if (r.error) throw new Error(`Could not save ${what}.`); };
  return {
    async saveRun(patch) {
      check(await db.from("zoho_books_import_runs").update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", runId).eq("tenant_id", tenantId), "the progress");
    },
    async upsertRecords(kind, rows: ScanRecord[]) {
      check(await db.from("zoho_books_import_records").upsert(
        rows.map((r) => ({ run_id: runId, tenant_id: tenantId, kind, zoho_id: r.zoho_id, data: r.data, needs_detail: r.needs_detail ?? false })),
        { onConflict: "run_id,kind,zoho_id" }), "what was read from Zoho");
    },
    async pendingDetails(limit) {
      const { data, error } = await db.from("zoho_books_import_records").select("zoho_id")
        .eq("run_id", runId).eq("tenant_id", tenantId).eq("kind", "invoice").eq("needs_detail", true).is("lines", null)
        .order("zoho_id", { ascending: true }).limit(limit);
      if (error) throw new Error("Could not read the dry run progress.");
      return ((data ?? []) as Array<{ zoho_id: string }>).map((r) => r.zoho_id);
    },
    async countPendingDetails() {
      const { count, error } = await db.from("zoho_books_import_records").select("zoho_id", { count: "exact", head: true })
        .eq("run_id", runId).eq("tenant_id", tenantId).eq("kind", "invoice").eq("needs_detail", true).is("lines", null);
      if (error) throw new Error("Could not read the dry run progress.");
      return count ?? 0;
    },
    async saveLines(zohoInvoiceId, lines: ZohoLineRec[]) {
      check(await db.from("zoho_books_import_records").update({ lines })
        .eq("run_id", runId).eq("tenant_id", tenantId).eq("kind", "invoice").eq("zoho_id", zohoInvoiceId), "invoice lines");
    },
  };
}

/** Everything the plan needs, for this tenant and run only. */
export async function loadPlanInputs(admin: Db, tenantId: string, runId: string) {
  const db = loose(admin);
  const records = await fetchAllRows<{ kind: string; data: unknown; lines: ZohoLineRec[] | null }>((from, to) =>
    db.from("zoho_books_import_records").select("kind, zoho_id, data, lines")
      .eq("run_id", runId).eq("tenant_id", tenantId)
      .order("kind", { ascending: true }).order("zoho_id", { ascending: true }).range(from, to));
  const contacts: ZohoContactRec[] = [];
  const invoices: ZohoInvoiceRec[] = [];
  for (const r of records) {
    if (r.kind === "contact") contacts.push(r.data as ZohoContactRec);
    else invoices.push({ ...(r.data as Omit<ZohoInvoiceRec, "lines">), lines: r.lines ?? null });
  }
  const [customers, subs, items, numbers] = await Promise.all([
    fetchAllRows<ExistingCustomer>((from, to) =>
      db.from("customers").select("id, name, gstin").eq("tenant_id", tenantId).order("id", { ascending: true }).range(from, to)),
    fetchAllRows<TrackedSubscription>((from, to) =>
      db.from("subscriptions").select("id, domain, customer_id, plan").eq("tenant_id", tenantId).order("id", { ascending: true }).range(from, to)),
    fetchAllRows<CatalogItem>((from, to) =>
      db.from("items").select("id, name, vendor").eq("tenant_id", tenantId).order("id", { ascending: true }).range(from, to)),
    fetchAllRows<{ external_number: string | null }>((from, to) =>
      db.from("invoices").select("id, external_number").eq("tenant_id", tenantId).eq("document_kind", OPENING_INVOICE_KIND)
        .order("id", { ascending: true }).range(from, to)),
  ]);
  return {
    contacts,
    invoices,
    existingCustomers: customers,
    existingSubscriptions: subs,
    items,
    existingInvoiceNumbers: new Set(numbers.map((n) => (n.external_number ?? "").toUpperCase()).filter(Boolean)),
  };
}
