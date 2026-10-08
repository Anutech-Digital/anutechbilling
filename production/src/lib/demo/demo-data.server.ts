/**
 * Add / clear demo data (R-361, 7 Oct 2026). Called only by api/demo-data, after its env
 * guard and role check. Every write goes through the CALLER'S client, so RLS keeps it
 * inside their own workspace; invoices go through two RPCs that check the same things
 * again inside the database (migration 20261007230000_demo_data_invoices).
 *
 * Rules this file keeps:
 *  - Idempotent: if any demo row is already there, nothing is added (a second click is a
 *    no-op that says so, not a second copy).
 *  - All or nothing, as far as PostgREST allows: if one module fails mid-way, everything
 *    this run added is cleared again before the error is returned.
 *  - Clear touches ONLY rows whose tag column starts with "DEMO · " (DEMO_TAG_COLUMN).
 */
import {
  DEMO_CLEAR_ORDER, DEMO_CLEARED_INDIRECTLY, DEMO_INSERT_ORDER, DEMO_PREFIX, DEMO_TAG_COLUMN,
  demoRows, type DemoBundle, type DemoTable,
} from "./demo-data";

export interface DbError { message: string; code?: string }
export interface DbResult { data: unknown; error: DbError | null }

/** The slice of the Supabase client this file uses — narrow on purpose, and fakeable in tests. */
export interface DemoDb {
  from(table: string): {
    insert(rows: object[]): PromiseLike<DbResult>;
    select(cols: string): { like(col: string, pattern: string): { limit(n: number): PromiseLike<DbResult> } };
    delete(): { like(col: string, pattern: string): { select(cols: string): PromiseLike<DbResult> } };
  };
  rpc(fn: string, args?: object): PromiseLike<DbResult>;
}

export interface DemoContext {
  tenantId: string;
  userId: string;
  tenantStateCode: string | null;
  today: string;
  stamp: number;
  newId: () => string;
}

export type DemoCounts = Partial<Record<DemoTable, number>>;

export type AddResult =
  | { ok: true; already: true }
  | { ok: true; already: false; counts: DemoCounts; invoicesSkipped: string | null }
  | { ok: false; error: string };

export type ClearResult =
  | { ok: true; counts: DemoCounts; invoicesSkipped: string | null }
  | { ok: false; error: string; counts: DemoCounts };

const TAG = `${DEMO_PREFIX}%`;

/** Human name per table, for messages. */
export const DEMO_LABEL: Record<DemoTable, string> = {
  items: "catalogue items", vendors: "vendors", customers: "customers", leads: "deals",
  quotes: "quotes", subscriptions: "subscriptions", invoices: "invoices", payments: "payments",
  tasks: "tasks", vendor_bills: "vendor bills", expenses: "expenses", contacts: "contacts",
};

/** Tables to look in for "is demo data already here?" — every table this file writes directly. */
const PRESENCE_TABLES = DEMO_INSERT_ORDER.filter((t) => t !== "invoices" && t !== "payments");

export async function demoDataPresent(db: DemoDb): Promise<boolean> {
  const hits = await Promise.all(
    PRESENCE_TABLES.map((t) => db.from(t).select("id").like(DEMO_TAG_COLUMN[t], TAG).limit(1)),
  );
  return hits.some((r) => Array.isArray(r.data) && r.data.length > 0);
}

/** Adds the tenant/owner columns each table needs. Pure — exported for the tests. */
export function rowsForInsert(bundle: DemoBundle, ctx: Pick<DemoContext, "tenantId" | "userId">): Record<keyof DemoBundle, object[]> {
  const t = { tenant_id: ctx.tenantId };
  return {
    items:         bundle.items.map((r) => ({ ...r, ...t })),
    vendors:       bundle.vendors.map((r) => ({ ...r, ...t })),
    customers:     bundle.customers.map((r) => ({ ...r, ...t })),
    leads:         bundle.leads.map((r) => ({ ...r, ...t, owner_id: ctx.userId })),
    quotes:        bundle.quotes.map((r) => ({ ...r, ...t, owner_id: ctx.userId })),
    subscriptions: bundle.subscriptions.map((r) => ({ ...r, ...t })),
    payments:      bundle.payments.map((r) => ({ ...r, ...t, recorded_by: ctx.userId })),
    invoices:      bundle.invoices.map((r) => ({ ...r })),   // the RPC sets tenant_id itself
    tasks:         bundle.tasks.map((r) => ({ ...r, ...t, owner_id: ctx.userId })),
    vendor_bills:  bundle.vendor_bills.map((r) => ({ ...r, ...t })),
    expenses:      bundle.expenses.map((r) => ({ ...r, ...t })),
  };
}

export async function addDemoData(db: DemoDb, ctx: DemoContext): Promise<AddResult> {
  if (await demoDataPresent(db)) return { ok: true, already: true };

  // Is the database willing to take demo invoices? An empty list checks the switch and the
  // role without writing anything.
  const probe = await db.rpc("demo_data_add_invoices", { p_rows: [] });
  const invoicesSkipped = probe.error ? invoiceSkipReason(probe.error) : null;

  const bundle = demoRows({ today: ctx.today, stamp: ctx.stamp, tenantStateCode: ctx.tenantStateCode, newId: ctx.newId });
  const rows = rowsForInsert(bundle, ctx);
  const counts: DemoCounts = {};

  for (const table of DEMO_INSERT_ORDER) {
    if (table === "invoices") {
      if (invoicesSkipped) continue;
      const { error } = await db.rpc("demo_data_add_invoices", { p_rows: rows.invoices });
      if (error) return rollBack(db, `Could not add demo invoices: ${error.message}`);
      counts.invoices = rows.invoices.length;
      continue;
    }
    const { error } = await db.from(table).insert(rows[table]);
    if (error) return rollBack(db, `Could not add demo ${DEMO_LABEL[table]}: ${error.message}`);
    counts[table] = rows[table].length;
  }
  return { ok: true, already: false, counts, invoicesSkipped };
}

async function rollBack(db: DemoDb, error: string): Promise<AddResult> {
  const undone = await clearDemoData(db);
  return { ok: false, error: undone.ok ? `${error} Nothing was kept.` : `${error} Clearing what was added also failed: ${undone.error}` };
}

function invoiceSkipReason(e: DbError): string {
  if (e.code === "PGRST202" || e.code === "42883") return "Invoices need migration 20261007230000_demo_data_invoices on this database.";
  if (/switched off/i.test(e.message)) return "Invoices are off for this database (public.demo_data_switch).";
  return `Invoices skipped: ${e.message}`;
}

export async function clearDemoData(db: DemoDb): Promise<ClearResult> {
  const counts: DemoCounts = {};
  let invoicesSkipped: string | null = null;

  for (const table of DEMO_CLEAR_ORDER) {
    const how = DEMO_CLEARED_INDIRECTLY[table];
    if (how === "cascade") continue;               // payments go with their demo quote
    if (how === "rpc") {
      const { data, error } = await db.rpc("demo_data_clear_invoices");
      if (error) invoicesSkipped = invoiceSkipReason(error);
      else counts.invoices = typeof data === "number" ? data : 0;
      continue;
    }
    const { data, error } = await db.from(table).delete().like(DEMO_TAG_COLUMN[table], TAG).select("id");
    if (error) return { ok: false, error: `Could not clear demo ${DEMO_LABEL[table]}: ${error.message}`, counts };
    counts[table] = Array.isArray(data) ? data.length : 0;
  }
  return { ok: true, counts, invoicesSkipped };
}

/** "6 customers, 10 deals, …" — for the toast. */
export function describeCounts(counts: DemoCounts): string {
  return (Object.keys(counts) as DemoTable[])
    .filter((t) => (counts[t] ?? 0) > 0)
    .map((t) => `${counts[t]} ${DEMO_LABEL[t]}`)
    .join(", ");
}
