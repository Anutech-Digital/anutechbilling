/**
 * R-361: add / clear against an in-memory database that behaves like PostgREST + RLS for the
 * calls this file makes. Proves: idempotent second click, tags on every inserted row,
 * cleanup removes everything it made and nothing else, roll-back on a mid-way failure,
 * and the invoice RPC's absence is reported, not fatal.
 */
import { describe, it, expect } from "vitest";
import { addDemoData, clearDemoData, describeCounts, rowsForInsert, type DemoDb, type DbResult } from "./demo-data.server";
import { DEMO_INSERT_ORDER, DEMO_TAG_COLUMN, demoRows, type DemoTable } from "./demo-data";

type Row = Record<string, unknown>;

/** `like 'DEMO · %'` — only a trailing % is ever used here. */
const likeMatch = (v: unknown, pattern: string) =>
  pattern.endsWith("%") ? String(v ?? "").startsWith(pattern.slice(0, -1)) : String(v ?? "") === pattern;

interface FakeOpts {
  /** Invoice RPCs: "ok" (migration applied + switch on), "missing", "off". */
  invoiceRpc?: "ok" | "missing" | "off";
  /** Make the insert into this table fail. */
  failInsert?: string;
}

function fakeDb(seed: Record<string, Row[]> = {}, o: FakeOpts = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  const t = (name: string) => (tables[name] ??= []);
  const calls: string[] = [];
  const ok = (data: unknown): DbResult => ({ data, error: null });
  const rpcError = (): DbResult =>
    o.invoiceRpc === "missing"
      ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.demo_data_add_invoices" } }
      : { data: null, error: { code: "42501", message: "Demo invoices are switched off for this database (public.demo_data_switch)." } };

  const db: DemoDb = {
    from(table: string) {
      return {
        insert(rows: object[]) {
          calls.push(`insert ${table}`);
          if (o.failInsert === table) return Promise.resolve({ data: null, error: { message: "boom" } });
          t(table).push(...(rows as Row[]).map((r) => ({ ...r })));
          // trg_leads_autolink_contact: one contact per lead, named after its company
          if (table === "leads") for (const r of rows as Row[]) t("contacts").push({ id: `C-${String(r.id)}`, company: r.company });
          return Promise.resolve(ok(null));
        },
        select(_cols: string) {
          return {
            like(col: string, pattern: string) {
              return { limit: (n: number) => Promise.resolve(ok(t(table).filter((r) => likeMatch(r[col], pattern)).slice(0, n))) };
            },
          };
        },
        delete() {
          return {
            like(col: string, pattern: string) {
              return {
                select(_c: string) {
                  calls.push(`delete ${table} where ${col} like ${pattern}`);
                  const gone = t(table).filter((r) => likeMatch(r[col], pattern));
                  tables[table] = t(table).filter((r) => !likeMatch(r[col], pattern));
                  // payments.quote_id ON DELETE CASCADE
                  if (table === "quotes") {
                    const ids = new Set(gone.map((r) => r.id));
                    tables.payments = t("payments").filter((p) => !ids.has(p.quote_id));
                  }
                  return Promise.resolve(ok(gone.map((r) => ({ id: r.id }))));
                },
              };
            },
          };
        },
      };
    },
    rpc(fn: string, args?: object) {
      calls.push(`rpc ${fn}`);
      if (o.invoiceRpc && o.invoiceRpc !== "ok") return Promise.resolve(rpcError());
      if (fn === "demo_data_add_invoices") {
        const rows = ((args as { p_rows?: Row[] } | undefined)?.p_rows ?? []);
        t("invoices").push(...rows.map((r) => ({ ...r, tenant_id: "t1" })));
        return Promise.resolve(ok(rows.length));
      }
      if (fn === "demo_data_clear_invoices") {
        const keep = t("invoices").filter((r) => !(String(r.id).startsWith("DEMO-INV-") && String(r.customer_name).startsWith("DEMO · ")));
        const n = t("invoices").length - keep.length;
        tables.invoices = keep;
        return Promise.resolve(ok(n));
      }
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${fn}` } });
    },
  };
  return { db, tables, calls };
}

let idn = 0;
const ctx = () => ({
  tenantId: "t1", userId: "u1", tenantStateCode: "07", today: "2026-10-07", stamp: 1_700_000_000_000,
  newId: () => `00000000-0000-4000-8000-${String(++idn).padStart(12, "0")}`,
});

/** Real (non-demo) rows the clear must never touch — including look-alikes. */
const REAL = {
  customers: [{ id: "c-real", name: "Acme Corp Pvt Ltd" }, { id: "c-real2", name: "Demo Furniture Co" }, { id: "c-real3", name: "DEMO-less Traders" }],
  leads: [{ id: "L1", company: "TechBrand Pvt Ltd" }],
  quotes: [{ id: "Q-ACME-2026-27-0001", customer_name: "Acme Corp Pvt Ltd" }],
  payments: [{ id: "p-real", quote_id: "Q-ACME-2026-27-0001", notes: null }],
  invoices: [{ id: "INV-ACME-2026-27-0001", customer_name: "Acme Corp Pvt Ltd" }],
  tasks: [{ id: "t-real", title: "Call Acme" }],
  items: [{ id: "GW-STR", name: "Google Workspace Starter" }],
  contacts: [{ id: "C-REAL", company: "Acme Corp Pvt Ltd" }],
  expenses: [{ id: "EXP-1", vendor_name: "AWS" }],
};
/** The real rows as they are now — each must still be there, unchanged. */
const snapshotReal = (tables: Record<string, Row[]>) =>
  Object.fromEntries(
    (Object.keys(REAL) as (keyof typeof REAL)[]).map((k) => [
      k, (tables[k] ?? []).filter((r) => (REAL[k] as Row[]).some((x) => x.id === r.id)),
    ]),
  );

describe("addDemoData", () => {
  it("writes every module, every row tagged, invoices through the RPC", async () => {
    const { db, tables } = fakeDb({}, { invoiceRpc: "ok" });
    const r = await addDemoData(db, ctx());
    expect(r.ok && !r.already).toBe(true);
    for (const t of DEMO_INSERT_ORDER) {
      expect(tables[t]?.length ?? 0, t).toBeGreaterThan(0);
      for (const row of tables[t]) expect(String(row[DEMO_TAG_COLUMN[t]]), t).toMatch(/^DEMO · /);
    }
    if (r.ok && !r.already) {
      expect(r.invoicesSkipped).toBeNull();
      expect(r.counts.invoices).toBe(tables.invoices.length);
      expect(describeCounts(r.counts)).toMatch(/customers.*deals.*quotes/);
    }
  });

  it("puts every row in the caller's workspace and names them owner where the table has one", async () => {
    const { db, tables } = fakeDb({}, { invoiceRpc: "ok" });
    await addDemoData(db, ctx());
    for (const t of DEMO_INSERT_ORDER) for (const row of tables[t]) expect(row.tenant_id, t).toBe("t1");
    for (const t of ["leads", "quotes", "tasks"]) for (const row of tables[t]) expect(row.owner_id, t).toBe("u1");
    for (const p of tables.payments) expect(p.recorded_by).toBe("u1");
  });

  it("is idempotent — a second click adds nothing", async () => {
    const { db, tables, calls } = fakeDb({}, { invoiceRpc: "ok" });
    await addDemoData(db, ctx());
    const before = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
    const insertsBefore = calls.filter((c) => c.startsWith("insert")).length;
    const r2 = await addDemoData(db, ctx());
    expect(r2).toEqual({ ok: true, already: true });
    expect(Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]))).toEqual(before);
    expect(calls.filter((c) => c.startsWith("insert")).length).toBe(insertsBefore);
  });

  it("counts leftovers in any module as 'already here' (e.g. only tasks survived)", async () => {
    const { db, calls } = fakeDb({ tasks: [{ id: "x", title: "DEMO · leftover" }] }, { invoiceRpc: "ok" });
    expect(await addDemoData(db, ctx())).toEqual({ ok: true, already: true });
    expect(calls.some((c) => c.startsWith("insert"))).toBe(false);
  });

  it("without the invoice migration / switch: every other module still filled, and it says why", async () => {
    for (const mode of ["missing", "off"] as const) {
      const { db, tables } = fakeDb({}, { invoiceRpc: mode });
      const r = await addDemoData(db, ctx());
      expect(r.ok && !r.already).toBe(true);
      expect(tables.invoices ?? []).toHaveLength(0);
      expect(tables.customers.length).toBeGreaterThan(0);
      if (r.ok && !r.already) expect(r.invoicesSkipped).toMatch(mode === "missing" ? /migration 20261007230000/ : /switched off|off for this database/);
    }
  });

  it("a failure half-way clears what it added and leaves real rows alone", async () => {
    const { db, tables } = fakeDb(REAL, { invoiceRpc: "ok", failInsert: "tasks" });
    const r = await addDemoData(db, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/tasks: boom.*Nothing was kept/);
    for (const t of [...DEMO_INSERT_ORDER, "contacts"]) {
      expect((tables[t] ?? []).filter((row) => String(row[DEMO_TAG_COLUMN[t as DemoTable]] ?? "").startsWith("DEMO · ")), t).toHaveLength(0);
    }
    expect(snapshotReal(tables)).toEqual(REAL);
  });
});

describe("clearDemoData", () => {
  it("removes every row it made — all tables, incl. the trigger's contacts and cascaded payments", async () => {
    const { db, tables } = fakeDb(REAL, { invoiceRpc: "ok" });
    await addDemoData(db, ctx());
    expect(tables.contacts.length).toBeGreaterThan(REAL.contacts.length);
    const r = await clearDemoData(db);
    expect(r.ok).toBe(true);
    for (const t of [...DEMO_INSERT_ORDER, "contacts"] as DemoTable[]) {
      expect((tables[t] ?? []).filter((row) => String(row[DEMO_TAG_COLUMN[t]] ?? "").startsWith("DEMO · ")), t).toHaveLength(0);
    }
    expect((tables.payments ?? []).filter((p) => String(p.quote_id).startsWith("DEMO-"))).toHaveLength(0);
  });

  it("never touches a real row — not even one named 'Demo …' or 'DEMO-less …'", async () => {
    const { db, tables } = fakeDb(REAL, { invoiceRpc: "ok" });
    await addDemoData(db, ctx());
    await clearDemoData(db);
    expect(snapshotReal(tables)).toEqual(REAL);
  });

  it("every DELETE it issues is filtered on the DEMO · tag column — never a bare delete", async () => {
    const { db, calls } = fakeDb({}, { invoiceRpc: "ok" });
    await clearDemoData(db);
    const deletes = calls.filter((c) => c.startsWith("delete"));
    expect(deletes.length).toBeGreaterThan(5);
    for (const d of deletes) {
      const [, table] = d.split(" ");
      expect(d).toBe(`delete ${table} where ${DEMO_TAG_COLUMN[table as DemoTable]} like DEMO · %`);
    }
    expect(calls).toContain("rpc demo_data_clear_invoices");
    expect(calls.some((c) => c.startsWith("delete invoices") || c.startsWith("delete payments"))).toBe(false);
  });

  it("clears in an order the foreign keys allow (children before customers)", async () => {
    const { db, calls } = fakeDb({}, { invoiceRpc: "ok" });
    await clearDemoData(db);
    const idx = (s: string) => calls.findIndex((c) => c.startsWith(s));
    for (const child of ["rpc demo_data_clear_invoices", "delete quotes", "delete subscriptions", "delete tasks"]) {
      expect(idx(child), child).toBeLessThan(idx("delete customers"));
    }
  });

  it("with the RPC missing it still clears the rest and says invoices were skipped", async () => {
    const { db } = fakeDb({ customers: [{ id: "c", name: "DEMO · X" }] }, { invoiceRpc: "missing" });
    const r = await clearDemoData(db);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.counts.customers).toBe(1); expect(r.invoicesSkipped).toMatch(/migration/); }
  });

  it("add → clear → add works again (fresh ids each run)", async () => {
    const { db, tables } = fakeDb({}, { invoiceRpc: "ok" });
    await addDemoData(db, ctx());
    await clearDemoData(db);
    const r = await addDemoData(db, { ...ctx(), stamp: 1_700_000_999_999 });
    expect(r.ok && !r.already).toBe(true);
    expect(tables.customers).toHaveLength(6);
  });
});

describe("rowsForInsert", () => {
  it("never sends tenant_id for invoices (the RPC takes it from the session)", () => {
    let n = 0;
    const b = demoRows({ today: "2026-10-07", stamp: 1, tenantStateCode: "07", newId: () => `id-${++n}` });
    const rows = rowsForInsert(b, { tenantId: "t1", userId: "u1" });
    for (const r of rows.invoices) expect(r).not.toHaveProperty("tenant_id");
    for (const r of rows.customers) expect(r).toHaveProperty("tenant_id", "t1");
  });
});
