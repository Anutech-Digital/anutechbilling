/**
 * R-2949 — FY sales from Zoho: the owner leaves invoices out (one by one, or every number starting
 * with a prefix) and the plan obeys: a left-out invoice is not imported, everything else in the plan
 * is exactly as before, and taking it back brings it in again. Also the list's own store: every read
 * and write carries the company's id. Zoho is never called; names and numbers are made up.
 */
import { describe, it, expect } from "vitest";
import type { ZohoSaleFacts } from "./normalise";
import { buildSalesPlan, toPick, type PlanContext } from "./plan";
import { cleanPrefix, leftOutBy, toImportRows, TO_IMPORT_LIST_MAX } from "./left-out";
import { addLeftOut, readLeftOut, removeLeftOut, scannedInvoiceNumber } from "./left-out-store";

const fact = (over: Partial<ZohoSaleFacts>): ZohoSaleFacts => ({
  zohoId: "z1", number: "INV/25-26/0001", date: "2025-05-10", dueDate: null, status: "paid", zohoCustomerId: "c", customerName: "Test Buyer",
  gstin: "29ABCDE1234F1Z5", gstTreatment: "business_gst", appGstTreatment: "registered_regular", posStateCode: "29", currency: "INR", fxRate: null,
  taxable: 1000, tax: 180, amount: 1180, taxRate: 18, head: "igst", lines: [], problems: [], notes: [], ...over,
});
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
  customers: [{ id: "cust-1", name: "Test Buyer", gstin: "29ABCDE1234F1Z5" }], items: [], invoices: [], ...over,
});
/* Three that import, one closed-line number, one void. */
const FACTS = [
  fact({ zohoId: "z1", number: "INV/25-26/0001", taxable: 1000, tax: 180, amount: 1180 }),
  fact({ zohoId: "z2", number: "INV/25-26/0002", date: "2025-06-02", taxable: 20000, tax: 3600, amount: 23600, tds: 2000, tdsSection: "194J" }),
  fact({ zohoId: "z3", number: "LSINV/25-26/0132", date: "2025-06-20", taxable: 1346, tax: 242, amount: 1588 }),
  fact({ zohoId: "z4", number: "INV/25-26/0004", date: "2025-06-25", status: "void", problems: ["Void in Zoho — not a sale, not in revenue or GST."] }),
];

describe("R-2949 prefix rule", () => {
  it("is trimmed and case-insensitive; under 2 characters or too long is refused", () => {
    expect(cleanPrefix("  ls ")).toBe("LS");
    expect(cleanPrefix("LSINV/25-26")).toBe("LSINV/25-26");
    for (const bad of ["", " ", "L", " l ", "x".repeat(21), null, 5, ["LS"]]) expect(cleanPrefix(bad)).toBeNull();
  });

  it("matches only the START of the number, whatever its case or outer spaces", () => {
    const rules = { ids: [], prefixes: ["LS"] };
    expect(leftOutBy(rules, { zohoId: "a", number: "LSINV/25-26/0132" })).toEqual({ by: "prefix", prefix: "LS" });
    expect(leftOutBy(rules, { zohoId: "a", number: " lsinv/25-26/0007" })).toEqual({ by: "prefix", prefix: "LS" });
    expect(leftOutBy(rules, { zohoId: "a", number: "INV/LS/0001" })).toBeNull();
    expect(leftOutBy(rules, { zohoId: "a", number: "INV/25-26/0001" })).toBeNull();
    expect(leftOutBy(undefined, { zohoId: "a", number: "LSINV/1" })).toBeNull();
  });

  it("the invoice's own rule wins over a prefix (it is taken back on its own)", () => {
    expect(leftOutBy({ ids: ["z3"], prefixes: ["LS"] }, { zohoId: "z3", number: "LSINV/25-26/0132" })).toEqual({ by: "invoice" });
  });
});

describe("R-2949 plan — left out by you", () => {
  it("a left-out invoice is not in the plan: skipped as 'Left out by you', never a pick", () => {
    const plan = buildSalesPlan(FACTS, ctx({ leftOut: { ids: ["z2"], prefixes: [] } }));
    const row = plan.rows.find((r) => r.facts.zohoId === "z2")!;
    expect(row.verdict).toBe("skip");
    expect(row.leftOut).toEqual({ by: "invoice" });
    expect(row.reason).toBe("Left out by you.");
    expect(plan.rows.filter((r) => r.verdict !== "skip").map(toPick).map((p) => p.zoho_invoice_id)).toEqual(["z1", "z3"]);
    expect(plan.counts).toMatchObject({ scanned: 4, import: 2, skip: 2, leftOutByYou: 1, voidOrDraft: 1 });
  });

  it("the prefix rule keeps the closed line's number out, whatever case it was typed in", () => {
    const plan = buildSalesPlan(FACTS, ctx({ leftOut: { ids: [], prefixes: [cleanPrefix(" ls ")!] } }));
    const row = plan.rows.find((r) => r.facts.zohoId === "z3")!;
    expect(row).toMatchObject({ verdict: "skip", leftOut: { by: "prefix", prefix: "LS" }, reason: 'Left out by you — its number starts with "LS".' });
    expect(plan.counts).toMatchObject({ import: 2, skip: 2, leftOutByYou: 1 });
    expect(plan.rows.filter((r) => r.verdict === "import").map((r) => r.facts.number)).toEqual(["INV/25-26/0001", "INV/25-26/0002"]);
  });

  it("nothing else in the plan changes: the other rows, Zoho's months, and the to-import totals less exactly that invoice", () => {
    const before = buildSalesPlan(FACTS, ctx());
    const after = buildSalesPlan(FACTS, ctx({ leftOut: { ids: [], prefixes: ["LS"] } }));
    /* Zoho's own sales totals still carry it (it IS a Zoho sale). */
    expect(after.zohoByMonth).toEqual(before.zohoByMonth);
    expect(after.gstinChoices).toEqual(before.gstinChoices);
    /* The generic "why" list never gains a line for it — it has its own block. */
    expect(after.skipReasons).toEqual(before.skipReasons);
    for (const [i, r] of after.rows.entries()) {
      if (r.facts.zohoId === "z3") continue;
      expect(r).toEqual(before.rows[i]);
    }
    const june = (p: typeof before) => p.importByMonth.find((m) => m.month === "2025-06")!;
    expect(before.importByMonth.find((m) => m.month === "2025-05")).toEqual(after.importByMonth.find((m) => m.month === "2025-05"));
    expect(june(before)).toEqual({ month: "2025-06", count: 2, taxable: 21346, igst: 3842, cgst: 0, sgst: 0, amount: 25188 });
    expect(june(after)).toEqual({ month: "2025-06", count: 1, taxable: 20000, igst: 3600, cgst: 0, sgst: 0, amount: 23600 });
    expect(before.counts.import - after.counts.import).toBe(1);
    expect(after.counts.skip - before.counts.skip).toBe(1);
  });

  it("taking it back brings it in again, with the same figures as before", () => {
    const before = buildSalesPlan(FACTS, ctx());
    const out = buildSalesPlan(FACTS, ctx({ leftOut: { ids: ["z1"], prefixes: ["LS"] } }));
    expect(out.counts).toMatchObject({ import: 1, leftOutByYou: 2 });
    const back = buildSalesPlan(FACTS, ctx({ leftOut: { ids: [], prefixes: [] } }));
    expect(back).toEqual(before);
    expect(before.counts.leftOutByYou).toBe(0);
  });

  it("an already imported invoice stays 'already in the app' — leaving out never un-books a sale", () => {
    const plan = buildSalesPlan(FACTS, ctx({
      invoices: [{ id: "INV/25-26/0001", externalNumber: "INV/25-26/0001", documentKind: "tax_invoice", zohoInvoiceId: "z1" }],
      leftOut: { ids: ["z1"], prefixes: ["INV"] },
    }));
    const row = plan.rows.find((r) => r.facts.zohoId === "z1")!;
    expect(row.verdict).toBe("already");
    expect(row.leftOut ?? null).toBeNull();
    expect(plan.counts).toMatchObject({ already: 1, import: 1, leftOutByYou: 1 });
  });

  it("an invoice left out for another reason keeps that reason (void stays void)", () => {
    const plan = buildSalesPlan(FACTS, ctx({ leftOut: { ids: ["z4"], prefixes: [] } }));
    const row = plan.rows.find((r) => r.facts.zohoId === "z4")!;
    expect(row.reason).toMatch(/Void in Zoho/);
    expect(row.leftOut ?? null).toBeNull();
    expect(plan.counts.leftOutByYou).toBe(0);
  });
});

describe("R-2949 the to-import list", () => {
  it("one light row per to-import invoice: number, date, customer, total, TDS / adjustment — nothing else", () => {
    const facts = [...FACTS, fact({ zohoId: "z5", number: "INV/25-26/0005", date: "2025-07-01", amount: 930, adjustment: -250, roundOff: -250 })];
    const plan = buildSalesPlan(facts, ctx({ leftOut: { ids: [], prefixes: ["LS"] } }));
    const list = toImportRows(plan.rows);
    expect(list.more).toBe(0);
    expect(list.rows).toEqual([
      { zohoId: "z1", number: "INV/25-26/0001", date: "2025-05-10", customer: "Test Buyer", amount: 1180, tds: 0, tdsSection: null, adjustment: 0 },
      { zohoId: "z2", number: "INV/25-26/0002", date: "2025-06-02", customer: "Test Buyer", amount: 23600, tds: 2000, tdsSection: "194J", adjustment: 0 },
      { zohoId: "z5", number: "INV/25-26/0005", date: "2025-07-01", customer: "Test Buyer", amount: 930, tds: 0, tdsSection: null, adjustment: -250 },
    ]);
  });

  it("is capped (a year of thousands never reaches the browser) and says how many more there are", () => {
    const many = Array.from({ length: TO_IMPORT_LIST_MAX + 7 }, (_, i) => fact({ zohoId: `m${i}`, number: `INV/25-26/${1000 + i}` }));
    const list = toImportRows(buildSalesPlan(many, ctx()).rows);
    expect(list.rows).toHaveLength(TO_IMPORT_LIST_MAX);
    expect(list.more).toBe(7);
  });
});

/* A tiny stand-in for the admin client: records every filter, keeps rows per table. */
function fakeDb(seed: { left?: Array<Record<string, unknown>>; scan?: Array<Record<string, unknown>> } = {}) {
  const tables: Record<string, Array<Record<string, unknown>>> = { zoho_fy_left_out: [...(seed.left ?? [])], zoho_fy_scan: [...(seed.scan ?? [])] };
  const log: Array<{ table: string; op: string; eq: Record<string, unknown> }> = [];
  const from = (table: string) => {
    const state = { op: "select", eq: {} as Record<string, unknown>, row: null as Record<string, unknown> | null };
    const match = (r: Record<string, unknown>) => Object.entries(state.eq).every(([k, v]) => r[k] === v);
    const run = () => {
      log.push({ table, op: state.op, eq: { ...state.eq } });
      if (state.op === "delete") { tables[table] = tables[table].filter((r) => !match(r)); return { data: null, error: null }; }
      if (state.op === "upsert") {
        const r = state.row!;
        const same = (x: Record<string, unknown>) => ["tenant_id", "kind", "rule", "value"].every((k) => x[k] === r[k]);
        if (!tables[table].some(same)) tables[table].push(r);
        return { data: null, error: null };
      }
      return { data: tables[table].filter(match), error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q, order: () => q, limit: () => q, range: () => q,
      eq: (k: string, v: unknown) => { state.eq[k] = v; return q; },
      delete: () => { state.op = "delete"; return q; },
      upsert: (row: Record<string, unknown>) => { state.op = "upsert"; state.row = row; return q; },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    };
    return q;
  };
  return { db: { from }, tables, log };
}

describe("R-2949 the left-out list in the database — one company at a time", () => {
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";

  it("a rule saved for company A is never read for company B; every query carries the company id", async () => {
    const f = fakeDb();
    await addLeftOut(f.db, A, "user-a", { rule: "prefix", value: "LS" });
    await addLeftOut(f.db, A, "user-a", { rule: "doc", value: "z2", number: "INV/25-26/0002" });
    expect(await readLeftOut(f.db, A)).toEqual({ docs: [{ zohoId: "z2", number: "INV/25-26/0002" }], prefixes: ["LS"] });
    expect(await readLeftOut(f.db, B)).toEqual({ docs: [], prefixes: [] });
    expect(f.tables.zoho_fy_left_out.every((r) => r.tenant_id === A && r.kind === "invoices" && r.created_by === "user-a")).toBe(true);
    for (const l of f.log.filter((x) => x.op !== "upsert")) expect(l.eq.tenant_id === A || l.eq.tenant_id === B).toBe(true);
  });

  it("saving the same rule twice keeps one row; taking it back removes only this company's", async () => {
    const f = fakeDb({ left: [{ tenant_id: B, kind: "invoices", rule: "prefix", value: "LS", number: null, created_by: "user-b" }] });
    await addLeftOut(f.db, A, "user-a", { rule: "prefix", value: "LS" });
    await addLeftOut(f.db, A, "user-a", { rule: "prefix", value: "LS" });
    expect(f.tables.zoho_fy_left_out.filter((r) => r.tenant_id === A)).toHaveLength(1);
    await removeLeftOut(f.db, A, "prefix", "LS");
    await removeLeftOut(f.db, A, "prefix", "LS");
    expect(f.tables.zoho_fy_left_out).toEqual([expect.objectContaining({ tenant_id: B, value: "LS" })]);
  });

  it("an invoice can be left out only when it is in THIS company's Zoho read", async () => {
    const f = fakeDb({ scan: [{ tenant_id: B, kind: "invoices", zoho_id: "z9", number: "INV/9" }, { tenant_id: A, kind: "invoices", zoho_id: "z2", number: "INV/25-26/0002" }] });
    expect(await scannedInvoiceNumber(f.db, A, "z2")).toBe("INV/25-26/0002");
    expect(await scannedInvoiceNumber(f.db, A, "z9")).toBeNull();
  });
});
