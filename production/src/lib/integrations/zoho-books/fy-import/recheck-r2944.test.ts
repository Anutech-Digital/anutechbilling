/**
 * R-2944 (G-RECON) — "Read from Zoho again" re-checks the invoices that an OLDER normaliser left out.
 *
 * Staging (Excel), 20 Nov 2026: 79 FY 2025-26 invoices stayed "left out" with reasons the code no longer
 * has ("Zoho has TDS on the invoice itself — book it by hand or ask the CA."): R-2702 changed the sales
 * normaliser but the scan keeps only its normalised facts (no raw Zoho detail) and the invoices' facts
 * version was never raised — so Read again kept every stored row. Raising the version alone would read
 * all 2,780 invoice details again (Zoho's day budget is ~900 calls).
 *
 * The rule tested here: invoices are at facts version 1, and a row made by an older version is read
 * again ONLY when its stored facts say "left out" (`problems`) and its Zoho status is not one that is
 * never a sale (void / draft). Fine rows, void / draft rows and rows already re-checked cost no call.
 * A read imports nothing. Zoho is a fake fetch; the store is memory (same classifyListed + the same
 * helpers as the Supabase store) or a recording fake of the Supabase client. Names / figures made up.
 */
import { describe, it, expect } from "vitest";
import {
  classifyListed, factsVersionOf, leftOutOnlyFromOf, scanStep, storedLeftOut, SCAN_FACTS_VERSION, SCAN_NEVER_RECHECK_STATUS,
  type KnownRow, type ListedRow, type ScanRun, type ScanStore,
} from "./scan";
import { supabaseScanStore, type FyImportDb } from "./store";
import { NOT_A_SALE, zohoSaleFacts, type ZohoSaleFacts } from "../sales-import/normalise";
import { buildSalesPlan, type PlanContext } from "../sales-import/plan";
import { parseSelect } from "@/server/postgrest/parse";

const FY = "2025-26";
const T1 = "2025-08-12T10:00:00+0530";
/** The sentences the old normaliser stored (they are no longer in the code). */
const OLD_TDS = "Zoho has TDS on the invoice itself — book it by hand or ask the CA.";
const OLD_ADJ = "Zoho has an adjustment of ₹500 on it — book it by hand or ask the CA.";
const OLD_MIXED = "Lines at different GST rates (0%, 18%) — one invoice here has one rate.";

describe("R-2944 the invoices' facts version and its re-check rule", () => {
  it("invoices are at version 1; an older row is re-read only when it was left out", () => {
    expect(factsVersionOf("invoices")).toBe(1);
    expect(leftOutOnlyFromOf("invoices")).toBe(0);
    /* Other lists keep R-2653's rule: no version yet, and a bump would re-read every older row. */
    for (const k of ["customerpayments", "bills", "expenses", "vendorpayments"] as const) {
      expect(SCAN_FACTS_VERSION[k]).toBeUndefined();
      expect(leftOutOnlyFromOf(k)).toBeNull();
    }
  });

  it("the statuses never re-checked are exactly the ones the sales normaliser calls not a sale", () => {
    expect([...(SCAN_NEVER_RECHECK_STATUS.invoices ?? [])].sort()).toEqual(Object.keys(NOT_A_SALE).sort());
  });

  it("storedLeftOut: problems on the stored facts, unless the status is never a sale", () => {
    expect(storedLeftOut("invoices", "paid", { problems: [OLD_TDS] })).toBe(true);
    expect(storedLeftOut("invoices", "paid", { problems: [] })).toBe(false);
    expect(storedLeftOut("invoices", "paid", {})).toBe(false);
    expect(storedLeftOut("invoices", "paid", null)).toBe(false);
    expect(storedLeftOut("invoices", "void", { problems: [NOT_A_SALE.void] })).toBe(false);
    expect(storedLeftOut("invoices", "draft", { problems: [NOT_A_SALE.draft, OLD_TDS] })).toBe(false);
    expect(storedLeftOut("invoices", "paid", { problems: "not a list" })).toBe(false);
  });
});

describe("R-2944 classifyListed — an older version with the left-out-only rule", () => {
  const known = (o: Partial<KnownRow> = {}): KnownRow => ({ status: "paid", fy: FY, modified: T1, detailedAt: "2026-11-01T00:00:00Z", hasDetail: true, factsVersion: null, ...o });
  const row: ListedRow = { zohoId: "i1", number: "INV/25-26/0001", date: "2025-08-12", status: "paid", modified: T1 };

  it("old + left out → fresh; old + fine → kept; current + left out → kept", () => {
    expect(classifyListed(known({ leftOut: true }), row, FY, null, 1, 0)).toBe("fresh");
    expect(classifyListed(known({ leftOut: false }), row, FY, null, 1, 0)).toBe("kept");
    expect(classifyListed(known({ factsVersion: 1, leftOut: true }), row, FY, null, 1, 0)).toBe("kept");
  });
  it("without the rule (null) an older version is always read again — R-2653 as before", () => {
    expect(classifyListed(known({ leftOut: false }), row, FY, null, 1)).toBe("fresh");
    expect(classifyListed(known({ leftOut: false }), row, FY, null, 1, null)).toBe("fresh");
  });
  it("a version below the rule's start is read again in full (a later bump that changes fine rows too)", () => {
    expect(classifyListed(known({ factsVersion: 0, leftOut: false }), row, FY, null, 2, 1)).toBe("fresh");
    expect(classifyListed(known({ factsVersion: 1, leftOut: false }), row, FY, null, 2, 1)).toBe("kept");
    expect(classifyListed(known({ factsVersion: 1, leftOut: true }), row, FY, null, 2, 1)).toBe("fresh");
  });
  it("a change in Zoho still wins: an old fine row edited in Zoho is read again", () => {
    expect(classifyListed(known({ leftOut: false }), { ...row, modified: "2026-11-19T10:00:00+0530" }, FY, null, 1, 0)).toBe("fresh");
    expect(classifyListed(known({ leftOut: false }), { ...row, status: "void" }, FY, null, 1, 0)).toBe("fresh");
  });
});

// ── a whole Read again against a fake Zoho ────────────────────────────────────────────────────────

type Row = { fy: string; status: string; modified: string | null; payload: ZohoSaleFacts | null; detailedAt: string | null; listedAt: number; factsVersion: number | null };

/** Memory twin of supabaseScanStore for invoices: same verdicts, same left-out rule, same version stamp. */
function memoryStore() {
  const runs = new Map<string, ScanRun>();
  const rows = new Map<string, Row>();
  let clock = 1_000;
  const tick = () => ++clock;
  const store: ScanStore<ZohoSaleFacts> = {
    async readRun(fy) { const r = runs.get(fy); return r ? { ...r } : null; },
    async saveRun(fy, r) { runs.set(fy, { ...r }); },
    async addListed(fy, list: ListedRow[]) {
      const now = tick();
      for (const x of list) {
        const p = rows.get(x.zohoId);
        const known: KnownRow | null = p ? {
          status: p.status, fy: p.fy, modified: p.modified, detailedAt: p.detailedAt, hasDetail: !!p.payload,
          factsVersion: p.factsVersion, leftOut: !!p.payload && storedLeftOut("invoices", p.status, p.payload),
        } : null;
        const v = classifyListed(known, x, fy, null, factsVersionOf("invoices"), leftOutOnlyFromOf("invoices"));
        const base = { fy, status: x.status, modified: x.modified || p?.modified || null, listedAt: now };
        if (v === "fresh") rows.set(x.zohoId, { ...base, payload: null, detailedAt: null, factsVersion: p?.factsVersion ?? null });
        else if (v === "kept") rows.set(x.zohoId, { ...p!, ...base });
      }
    },
    async requeueUnlisted(fy, since) {
      let n = 0;
      for (const v of rows.values()) if (v.fy === fy && v.listedAt < Number(since)) { v.payload = null; v.detailedAt = null; n++; }
      return n;
    },
    async refresh(fy) { runs.set(fy, { nextPage: 1, listDone: false, listStartedAt: String(tick()), onlyAccount: null }); },
    async pendingDetails(fy, limit) { return [...rows.entries()].filter(([, r]) => r.fy === fy && !r.payload).map(([id]) => id).slice(0, limit); },
    async saveDetail(_fy, id, f) { const r = rows.get(id)!; r.payload = f; r.detailedAt = "2026-11-20T05:00:00Z"; r.factsVersion = factsVersionOf("invoices"); },
    async drop(_fy, id) { rows.delete(id); },
    async counts(fy) { const a = [...rows.values()].filter((r) => r.fy === fy); return { listed: a.length, detailed: a.filter((r) => r.payload).length }; },
    async reset(fy) { runs.delete(fy); for (const [k, v] of rows) if (v.fy === fy) rows.delete(k); },
  };
  return { store, rows, runs };
}

type Shape = "plain" | "tds" | "adjustment" | "mixed";
interface Inv { id: string; number: string; shape: Shape; status?: string; modified?: string }

/** Zoho's invoice JSON (₹1,00,000 at 18% for a Delhi buyer) in each shape R-2702 handles. */
function zohoInvoice(i: Inv): Record<string, unknown> {
  const base = {
    invoice_id: i.id, invoice_number: i.number, date: "2025-08-12", due_date: "2025-08-27", status: i.status ?? "paid",
    customer_id: "c-1", customer_name: "Delhi Buyer", currency_code: "INR", last_modified_time: i.modified ?? T1,
    gst_no: "07ABCDE1234F1Z5", gst_treatment: "business_gst", place_of_supply: "DL",
    total: 118000, tax_total: 18000,
    line_items: [{ item_id: "z-1", name: "Cloud Seat Plan", rate: 1000, quantity: 100, item_total: 100000, tax_name: "GST18", tax_percentage: 18, hsn_or_sac: "998315" }],
    taxes: [{ tax_name: "CGST9", tax_amount: 9000 }, { tax_name: "SGST9", tax_amount: 9000 }],
  };
  /* TDS on the invoice: Zoho's total is net of it (1,00,000 + 18,000 − 10,000). */
  if (i.shape === "tds") return { ...base, total: 108000, tds_amount: 10000, tds_tax_name: "Professional Fees [10%] - 194 J" };
  if (i.shape === "adjustment") return { ...base, total: 117500, adjustment: -500, adjustment_description: "Settlement" };
  if (i.shape === "mixed") return { ...base, line_items: [...base.line_items, { item_id: "z-2", name: "Export part", rate: 5000, quantity: 1, item_total: 5000, tax_name: "", tax_percentage: 0, hsn_or_sac: "998315" }], total: 123000 };
  return base;
}

const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function fakeZoho(invs: () => Inv[], opts: { failDetailAt?: number } = {}) {
  const detailIds: string[] = [];
  let lists = 0;
  let failAt = opts.failDetailAt ?? 0;
  const f = (async (input: string) => {
    const u = new URL(input);
    const path = u.pathname.replace("/books/v3/", "");
    const all = invs();
    if (path.startsWith("invoices/")) {
      const id = path.split("/")[1];
      if (failAt && detailIds.length + 1 === failAt) { failAt = 0; throw new Error("no answer (test)"); }
      detailIds.push(id);
      const inv = all.find((x) => x.id === id);
      return inv ? j({ code: 0, invoice: zohoInvoice(inv) }) : j({ code: 1002, message: "Invoice does not exist." }, 404);
    }
    lists += 1;
    return j({
      code: 0,
      invoices: all.map((x) => ({ invoice_id: x.id, invoice_number: x.number, date: "2025-08-12", status: x.status ?? "paid", total: 118000, last_modified_time: x.modified ?? T1 })),
      page_context: { page: 1, has_more_page: false },
    });
  }) as unknown as typeof fetch;
  return { f, detailIds, lists: () => lists, reset: () => { detailIds.length = 0; lists = 0; } };
}

const SELLER = "07";
const noWait = { sleep: async () => {}, now: () => 0, budget: 10_000, maxCalls: 10_000 };
const read = (store: ScanStore<ZohoSaleFacts>, f: typeof fetch, maxCalls = 10_000) =>
  scanStep(store, "invoices", (d) => zohoSaleFacts(d, SELLER), "600", "tok", FY, { ...noWait, maxCalls }, f);

/** A stored row as the OLD normaliser left it (version 0 = stored before any version). */
function oldRow(inv: Inv, problems: string[]): Row {
  const facts = { ...zohoSaleFacts({ ...detailOf(inv) }, SELLER), problems, notes: [] } as ZohoSaleFacts;
  return { fy: FY, status: inv.status ?? "paid", modified: inv.modified ?? T1, payload: facts, detailedAt: "2026-11-06T00:00:00Z", listedAt: 1, factsVersion: null };
}
/** The fy-fetch detail of a plain invoice — only to give old rows believable facts. */
function detailOf(inv: Inv) {
  return {
    kind: "invoices" as const, id: inv.id, number: inv.number, date: "2025-08-12", status: inv.status ?? "paid", contactId: "c-1", contactName: "Delhi Buyer",
    totalPaise: 1_18_000_00, balancePaise: 0, currency: "INR", raw: {}, lines: [], taxes: [{ name: "CGST9", amountPaise: 9_000_00 }, { name: "SGST9", amountPaise: 9_000_00 }],
    taxTotalPaise: 18_000_00, tdsPaise: 0, gstNo: "07ABCDE1234F1Z5", gstTreatment: "business_gst", placeOfSupply: "DL", reverseCharge: false,
  };
}

const ctx: PlanContext = {
  fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
  customers: [{ id: "cust-dl", name: "Delhi Buyer", gstin: "07ABCDE1234F1Z5" }], items: [], invoices: [],
};

/** A year as staging holds it: fine rows, and rows the old rules left out. */
function stagingLike() {
  const invs: Inv[] = [
    { id: "f1", number: "INV/25-26/0001", shape: "plain" },
    { id: "f2", number: "INV/25-26/0002", shape: "plain" },
    { id: "f3", number: "INV/25-26/0003", shape: "plain" },
    { id: "tds", number: "INV/25-26/0696", shape: "tds" },
    { id: "adj", number: "INV/25-26/0065", shape: "adjustment" },
    { id: "mix", number: "INV/25-26/1248", shape: "mixed" },
    { id: "void", number: "INV/25-26/0400", shape: "plain", status: "void" },
    { id: "draft", number: "INV/25-26/0401", shape: "plain", status: "draft" },
  ];
  const m = memoryStore();
  const old: Record<string, string[]> = { tds: [OLD_TDS], adj: [OLD_ADJ], mix: [OLD_MIXED], void: [NOT_A_SALE.void], draft: [NOT_A_SALE.draft] };
  for (const i of invs) m.rows.set(i.id, oldRow(i, old[i.id] ?? []));
  m.runs.set(FY, { nextPage: 1, listDone: true, listStartedAt: null, onlyAccount: null });
  return { invs, ...m };
}

describe("R-2944 Read from Zoho again — only the invoices an older rule left out are read again", () => {
  it("old-rule left-out invoice is re-read and becomes to import; fine old rows are not re-read; void and draft stay left out without a call", async () => {
    const { invs, store, rows } = stagingLike();
    const z = fakeZoho(() => invs);
    /* Before: the plan from the stored facts leaves the TDS invoice out with the OLD sentence. */
    const before = buildSalesPlan([...rows.values()].map((r) => r.payload!), ctx);
    expect(before.rows.find((r) => r.facts.zohoId === "tds")).toMatchObject({ verdict: "skip", reason: OLD_TDS });

    await store.refresh(FY, { onlyAccount: null, nowIso: "" });
    const r = await read(store, z.f);
    expect(r).toMatchObject({ listed: 8, detailed: 8, complete: true });
    expect(z.lists()).toBe(1);
    expect([...z.detailIds].sort()).toEqual(["adj", "mix", "tds"]);   // 3 of 8 — not the fine ones, not void / draft

    const tds = rows.get("tds")!;
    expect(tds.factsVersion).toBe(1);
    expect(tds.payload!.problems).toEqual([]);
    expect(tds.payload!.amount).toBe(118000);     // the full sale — never Zoho's net 1,08,000 (money rule G18)
    expect(tds.payload!.tds).toBe(10000);
    expect(rows.get("adj")!.payload!.problems).toEqual([]);
    expect(rows.get("adj")!.payload!.adjustment).toBe(-500);

    const after = buildSalesPlan([...rows.values()].map((x) => x.payload!), ctx);
    const verdict = (id: string) => after.rows.find((x) => x.facts.zohoId === id)!;
    expect(verdict("tds").verdict).toBe("import");
    expect(verdict("adj").verdict).toBe("import");
    /* Still left out by TODAY's rules — with today's sentence, not the old one. */
    expect(verdict("mix")).toMatchObject({ verdict: "skip" });
    expect(verdict("mix").reason).toMatch(/R-2717/);
    expect(verdict("void")).toMatchObject({ verdict: "skip", reason: NOT_A_SALE.void });
    expect(verdict("draft")).toMatchObject({ verdict: "skip", reason: NOT_A_SALE.draft });
    /* Untouched: same stored facts object, still the old version. */
    expect(rows.get("f1")!.factsVersion).toBeNull();
    expect(rows.get("void")!.payload!.problems).toEqual([NOT_A_SALE.void]);
  });

  it("second Read again reads nothing: a row re-checked once (even one still left out) is current", async () => {
    const { invs, store } = stagingLike();
    const z = fakeZoho(() => invs);
    await store.refresh(FY, { onlyAccount: null, nowIso: "" });
    await read(store, z.f);
    z.reset();
    await store.refresh(FY, { onlyAccount: null, nowIso: "" });
    const again = await read(store, z.f);
    expect(again).toMatchObject({ listed: 8, detailed: 8, complete: true });
    expect(z.lists()).toBe(1);
    expect(z.detailIds).toEqual([]);
  });

  it("stops on the call limit and resumes: the rest stays pending, nothing is read twice", async () => {
    const { invs, store, rows } = stagingLike();
    const z = fakeZoho(() => invs);
    await store.refresh(FY, { onlyAccount: null, nowIso: "" });
    /* 1 list call + 1 detail call, then the limit. */
    const part = await read(store, z.f, 2);
    expect(part.complete).toBe(false);
    expect(part).toMatchObject({ listed: 8, detailed: 6 });   // the preview refuses until it is complete (route: detailed < listed)
    expect(z.detailIds).toHaveLength(1);
    expect([...rows.values()].filter((r) => !r.payload)).toHaveLength(2);
    const rest = await read(store, z.f);
    expect(rest).toMatchObject({ listed: 8, detailed: 8, complete: true });
    expect(z.lists()).toBe(1);                                   // not listed again
    expect([...z.detailIds].sort()).toEqual(["adj", "mix", "tds"]);   // each once
  });

  it("a Zoho call fails mid re-check (network — or the day budget refusing the call, R-2661: both throw out of the step): what was read is kept, the next read carries on", async () => {
    const { invs, store, rows } = stagingLike();
    const z = fakeZoho(() => invs, { failDetailAt: 2 });
    await store.refresh(FY, { onlyAccount: null, nowIso: "" });
    await expect(read(store, z.f)).rejects.toThrow(/Zoho/);
    expect(z.detailIds).toHaveLength(1);
    expect([...rows.values()].filter((r) => r.factsVersion === 1)).toHaveLength(1);
    const rest = await read(store, z.f);
    expect(rest).toMatchObject({ listed: 8, detailed: 8, complete: true });
    expect([...z.detailIds].sort()).toEqual(["adj", "mix", "tds"]);
  });

  it("Read again pressed twice mid re-check: pending rows stay pending, re-checked ones are not read again", async () => {
    const { invs, store } = stagingLike();
    const z = fakeZoho(() => invs);
    await store.refresh(FY, { onlyAccount: null, nowIso: "" });
    await read(store, z.f, 2);                       // list + 1 detail
    await store.refresh(FY, { onlyAccount: null, nowIso: "" });   // the owner presses it again
    const end = await read(store, z.f);
    expect(end).toMatchObject({ listed: 8, detailed: 8, complete: true });
    expect([...z.detailIds].sort()).toEqual(["adj", "mix", "tds"]);   // 3 detail calls in all
  });

  it("a re-checked invoice Zoho no longer has is dropped (R-2653, as before)", async () => {
    const { invs, store, rows } = stagingLike();
    const z = fakeZoho(() => invs.filter((i) => i.id !== "adj"));
    /* gone from Zoho's list and its detail: re-checked once the whole list is in → 404 → dropped */
    await store.refresh(FY, { onlyAccount: null, nowIso: "" });
    const r = await read(store, z.f);
    expect(r).toMatchObject({ listed: 7, detailed: 7, complete: true });
    expect(rows.has("adj")).toBe(false);
  });
});

// ── the Supabase store ───────────────────────────────────────────────────────────────────────────

interface Call { table: string; op: string; arg?: unknown; filters: Array<[string, string, unknown]> }
function fakeDb(selectRows: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  const db: FyImportDb = {
    from(table: string) {
      const c: Call = { table, op: "", filters: [] };
      calls.push(c);
      const q: Record<string, unknown> = {};
      const chain = (name: string) => (...a: unknown[]) => { c.filters.push([name, String(a[0]), a[1]]); return q; };
      for (const f of ["eq", "in", "lt", "is", "not", "order", "limit", "or"]) q[f] = chain(f);
      q.select = (...a: unknown[]) => { if (!c.op) c.op = "select"; c.filters.push(["select", String(a[0]), undefined]); return q; };
      for (const op of ["upsert", "update", "delete"]) q[op] = (arg?: unknown) => { c.op = op; c.arg = arg; return q; };
      q.then = (res: (v: unknown) => unknown) => res({ data: c.op === "select" ? selectRows : [], error: null });
      return q;
    },
  };
  return { db, calls };
}

describe("R-2944 supabaseScanStore.addListed — invoices", () => {
  const known = (id: string, over: Record<string, unknown> = {}) => ({
    zoho_id: id, zoho_status: "paid", fy: FY, zoho_modified: T1, detailed_at: "2026-11-06T00:00:00Z", deposit_account_id: null,
    facts_version: null, payload: { problems: [] }, ...over,
  });
  const listed = (id: string, status = "paid"): ListedRow => ({ zohoId: id, number: id, date: "2025-08-12", status, modified: T1, accountId: "" });

  it("only old rows that were left out (not void / draft) get their detail read again; everything else keeps its facts", async () => {
    const { db, calls } = fakeDb([
      known("old-fine"),
      known("old-tds", { payload: { problems: [OLD_TDS] } }),
      known("old-void", { zoho_status: "void", payload: { problems: [NOT_A_SALE.void] } }),
      known("old-draft", { zoho_status: "draft", payload: { problems: [NOT_A_SALE.draft] } }),
      known("new-mixed", { facts_version: 1, payload: { problems: ["Lines at different GST rates (0%, 18%) — waits for per-line GST in reports, card R-2717."] } }),
      known("new-fine", { facts_version: 1 }),
    ]);
    await supabaseScanStore(db, "t1", "invoices").addListed(FY, [
      listed("old-fine"), listed("old-tds"), listed("old-void", "void"), listed("old-draft", "draft"), listed("new-mixed"), listed("new-fine"),
    ]);
    const sel = calls[0];
    expect(sel.table).toBe("zoho_fy_scan");
    const cols = sel.filters.find(([k]) => k === "select")![1];
    expect(cols).toContain(", payload");
    expect(cols).not.toContain("->");                 // the data gateway refuses JSON paths in a select
    expect(() => parseSelect(cols)).not.toThrow();
    /* §17c: the admin client bypasses RLS — the read is this company's and this list's only. */
    expect(sel.filters).toContainEqual(["eq", "tenant_id", "t1"]);
    expect(sel.filters).toContainEqual(["eq", "kind", "invoices"]);

    const ups = calls.filter((c) => c.op === "upsert").map((c) => c.arg as Array<Record<string, unknown>>);
    const fresh = ups.find((g) => g.some((r) => r.payload === null)) ?? [];
    const kept = ups.find((g) => g.every((r) => !("payload" in r))) ?? [];
    expect(fresh.map((r) => r.zoho_id)).toEqual(["old-tds"]);
    expect(fresh[0]).toMatchObject({ tenant_id: "t1", kind: "invoices", payload: null, detailed_at: null });
    expect(kept.map((r) => r.zoho_id).sort()).toEqual(["new-fine", "new-mixed", "old-draft", "old-fine", "old-void"]);
    /* A read writes the scan only — never an invoice. */
    expect([...new Set(calls.map((c) => c.table))]).toEqual(["zoho_fy_scan"]);
  });

  it("saveDetail stamps the invoices' current version, so the row is not re-checked again", async () => {
    const { db, calls } = fakeDb();
    await supabaseScanStore(db, "t1", "invoices").saveDetail(FY, "old-tds", { number: "INV/25-26/0696", date: "2025-08-12", status: "paid" });
    expect(calls[0]).toMatchObject({ table: "zoho_fy_scan", op: "update" });
    expect(calls[0].arg).toMatchObject({ facts_version: 1 });
  });

  it("a list with no left-out rule (bills) does not read payloads", async () => {
    const { db, calls } = fakeDb([{ ...known("b1"), payload: undefined }]);
    await supabaseScanStore(db, "t1", "bills").addListed(FY, [listed("b1")]);
    expect(calls[0].filters.find(([k]) => k === "select")![1]).not.toContain("payload");
  });
});
