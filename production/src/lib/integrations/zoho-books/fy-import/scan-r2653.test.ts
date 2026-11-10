/**
 * R-2653 — "Read from Zoho again" never re-reads what we already have: it lists the FY again (list
 * calls only) and reads the detail only of documents that are new, changed in Zoho (status, FY,
 * last_modified_time), made by an older normaliser (facts version) or — for receipts — limited to one
 * deposit account. A document not listed again is re-checked once the whole list is in (404 → dropped;
 * one only missed because Zoho's pages shifted is kept). Zoho is a fake fetch (never the real one); the store is
 * memory and uses the same classifyListed as the Supabase store. Names and numbers are made up.
 */
import { describe, it, expect } from "vitest";
import { classifyListed, scanStep, type KnownRow, type ListedRow, type ScanFacts, type ScanRun, type ScanStore } from "./scan";
import { zohoReceiptFacts } from "../receipts-import/normalise";

type Row = { fy: string; status: string; modified: string | null; accountId: string; payload: ScanFacts | null; detailedAt: string | null; listedAt: number };

/** Memory twin of supabaseScanStore (store.ts): same verdicts, same re-check, same refresh. */
function memoryStore() {
  const runs = new Map<string, ScanRun>();
  const rows = new Map<string, Row>();
  let clock = 1_000;
  const tick = () => ++clock;
  const store: ScanStore<ScanFacts> = {
    async readRun(fy) { const r = runs.get(fy); return r ? { ...r } : null; },
    async saveRun(fy, r) { runs.set(fy, { ...r }); },
    async addListed(fy, list: ListedRow[], run) {
      const now = tick();
      for (const x of list) {
        const p = rows.get(x.zohoId);
        const known: KnownRow | null = p ? { status: p.status, fy: p.fy, modified: p.modified, detailedAt: p.detailedAt, hasDetail: !!p.payload, accountId: p.accountId || null } : null;
        const v = classifyListed(known, x, fy, run?.onlyAccount ?? null);
        if (v === "skip") continue;
        if (v === "seen") { p!.listedAt = now; continue; }
        const base = { fy, status: x.status, modified: x.modified || p?.modified || null, accountId: x.accountId ?? "", listedAt: now };
        rows.set(x.zohoId, v === "fresh" ? { ...base, payload: null, detailedAt: null } : { ...p!, ...base });
      }
    },
    async requeueUnlisted(fy, since) {
      let n = 0;
      for (const v of rows.values()) if (v.fy === fy && v.listedAt < Number(since)) { v.payload = null; v.detailedAt = null; n++; }
      return n;
    },
    async refresh(fy, o) { runs.set(fy, { nextPage: 1, listDone: false, listStartedAt: String(tick()), onlyAccount: o.onlyAccount }); },
    async pendingDetails(fy, limit) { return [...rows.entries()].filter(([, r]) => r.fy === fy && !r.payload).map(([id]) => id).slice(0, limit); },
    async saveDetail(_fy, id, f) { const r = rows.get(id)!; r.payload = f; r.detailedAt = "2026-11-10T06:00:00Z"; },
    async drop(_fy, id) { rows.delete(id); },
    async counts(fy) { const a = [...rows.values()].filter((r) => r.fy === fy); return { listed: a.length, detailed: a.filter((r) => r.payload).length }; },
    async reset(fy) { runs.delete(fy); for (const [k, v] of rows) if (v.fy === fy) rows.delete(k); },
  };
  return { store, rows, runs };
}

interface Pay { id: string; modified: string; account: string; status?: string }
const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** Fake Zoho customer payments (list rows carry last_modified_time + account_id, as Zoho's list does). */
function fakeZoho(pays: () => Pay[], per = 200) {
  const urls: URL[] = [];
  const f = (async (input: string) => {
    const u = new URL(input);
    urls.push(u);
    const path = u.pathname.replace("/books/v3/", "");
    const all = pays();
    if (path.startsWith("customerpayments/")) {
      const p = all.find((x) => x.id === path.split("/")[1]);
      if (!p) return j({ code: 1002, message: "Payment does not exist." }, 404);
      return j({ code: 0, payment: {
        payment_id: p.id, payment_number: `PAY-${p.id}`, date: "2025-06-01", customer_id: "c1", customer_name: "Test Buyer",
        amount: 1000, unused_amount: 0, account_id: p.account, account_name: p.account === "ZA-RZP" ? "Razorpay Clearing" : "HDFC",
        payment_mode: "banktransfer", reference_number: "", last_modified_time: p.modified,
        invoices: [{ invoice_id: "inv-1", invoice_number: "INV-1", amount_applied: 1000, tax_amount_withheld: 0 }],
      } });
    }
    const page = Number(u.searchParams.get("page") ?? 1);
    const slice = all.slice((page - 1) * per, page * per);
    return j({
      code: 0,
      customerpayments: slice.map((p) => ({
        payment_id: p.id, payment_number: `PAY-${p.id}`, date: "2025-06-01", amount: 1000, status: p.status ?? "paid",
        account_id: p.account, last_modified_time: p.modified,
      })),
      page_context: { page, has_more_page: page * per < all.length },
    });
  }) as unknown as typeof fetch;
  const details = () => urls.filter((u) => /\/customerpayments\/./.test(u.pathname)).length;
  const lists = () => urls.filter((u) => u.pathname === "/books/v3/customerpayments").length;
  return { f, urls, details, lists, reset: () => { urls.length = 0; } };
}

const noWait = { sleep: async () => {}, now: () => 0, budget: 10_000, maxCalls: 10_000 };
const read = (store: ScanStore<ScanFacts>, f: typeof fetch) => scanStep(store, "customerpayments", zohoReceiptFacts, "600", "tok", "2025-26", noWait, f);
const T1 = "2025-06-01T10:00:00+0530", T2 = "2026-11-09T12:00:00+0530";

function year(n: number, account = (i: number) => (i % 10 === 0 ? "ZA-RZP" : "ZA-HDFC")): Pay[] {
  return Array.from({ length: n }, (_, k) => ({ id: `p${k + 1}`, modified: T1, account: account(k + 1) }));
}

describe("R-2653 classifyListed — what Read again does with one listed row", () => {
  const known = (o: Partial<KnownRow> = {}): KnownRow => ({ status: "paid", fy: "2025-26", modified: T1, detailedAt: "2026-11-01T00:00:00Z", hasDetail: true, ...o });
  const row = (o: Partial<ListedRow> = {}): ListedRow => ({ zohoId: "p1", number: "PAY-1", date: "2025-06-01", status: "paid", modified: T1, accountId: "ZA-HDFC", ...o });

  it("new → fresh; same modified time → kept; different → fresh", () => {
    expect(classifyListed(null, row(), "2025-26")).toBe("fresh");
    expect(classifyListed(known(), row(), "2025-26")).toBe("kept");
    expect(classifyListed(known(), row({ modified: T2 }), "2025-26")).toBe("fresh");
  });
  it("status or FY changed, or no detail yet → fresh (old behaviour kept)", () => {
    expect(classifyListed(known(), row({ status: "void" }), "2025-26")).toBe("fresh");
    expect(classifyListed(known({ fy: "2024-25" }), row(), "2025-26")).toBe("fresh");
    expect(classifyListed(known({ hasDetail: false }), row(), "2025-26")).toBe("fresh");
  });
  it("legacy row (read before R-2653, no stored modified): changed after our detail read → fresh, else kept", () => {
    expect(classifyListed(known({ modified: null }), row({ modified: "2026-11-02T10:00:00+0530" }), "2025-26")).toBe("fresh");
    expect(classifyListed(known({ modified: null }), row({ modified: "2025-06-01T10:00:00+0530" }), "2025-26")).toBe("kept");
  });
  it("no modified time from Zoho (or unreadable) → status decides, as before", () => {
    expect(classifyListed(known(), row({ modified: "" }), "2025-26")).toBe("kept");
    expect(classifyListed(known({ modified: null }), row({ modified: "not a date" }), "2025-26")).toBe("kept");
  });
  it("deposit-account filter: other account new → skip, existing → seen (left as it was)", () => {
    expect(classifyListed(null, row(), "2025-26", "ZA-RZP")).toBe("skip");
    expect(classifyListed(known({ accountId: "ZA-HDFC" }), row({ modified: T2 }), "2025-26", "ZA-RZP")).toBe("seen");
    expect(classifyListed(known({ accountId: "ZA-HDFC" }), row({ accountId: "ZA-RZP", modified: T2 }), "2025-26", "ZA-RZP")).toBe("fresh");
    expect(classifyListed(known({ accountId: "ZA-RZP" }), row({ accountId: "ZA-RZP" }), "2025-26", "ZA-RZP")).toBe("kept");
    expect(classifyListed(null, row({ accountId: "ZA-RZP" }), "2025-26", "ZA-RZP")).toBe("fresh");
  });
  it("filter: a payment moved OUT of the chosen account, or into this FY, is read again (its facts are stale)", () => {
    expect(classifyListed(known({ accountId: "ZA-RZP" }), row({ accountId: "ZA-HDFC" }), "2025-26", "ZA-RZP")).toBe("fresh");
    expect(classifyListed(known({ accountId: "ZA-HDFC", fy: "2024-25" }), row(), "2025-26", "ZA-RZP")).toBe("fresh");
  });
  it("filter on rows stored before R-2653 (account unknown): re-read only when changed", () => {
    expect(classifyListed(known({ accountId: null }), row(), "2025-26", "ZA-RZP")).toBe("seen");
    expect(classifyListed(known({ accountId: null, modified: null }), row({ modified: "2026-11-02T10:00:00+0530" }), "2025-26", "ZA-RZP")).toBe("fresh");
  });
  it("facts made by an older normaliser version → fresh (once); same version → kept", () => {
    expect(classifyListed(known({ factsVersion: null }), row(), "2025-26", null, 1)).toBe("fresh");
    expect(classifyListed(known({ factsVersion: 1 }), row(), "2025-26", null, 1)).toBe("kept");
    expect(classifyListed(known({ factsVersion: null }), row(), "2025-26", null, 0)).toBe("kept");
  });
});

describe("R-2653 Read again — list calls + new/changed details only", () => {
  it("unchanged year = list calls only (2,576 payments: 13 list calls, 0 detail calls)", async () => {
    const pays = year(2576);
    const z = fakeZoho(() => pays);
    const { store } = memoryStore();
    const first = await read(store, z.f);
    expect(first.complete).toBe(true);
    expect(z.details()).toBe(2576);

    z.reset();
    await store.refresh("2025-26", { onlyAccount: null, nowIso: "" });
    const again = await read(store, z.f);
    expect(again).toMatchObject({ listed: 2576, detailed: 2576, complete: true });
    expect(z.lists()).toBe(13);
    expect(z.details()).toBe(0);
  });

  it("changed modified time / status / new payment → only those details read again, with the new facts", async () => {
    const pays = year(10);
    const z = fakeZoho(() => pays);
    const { store, rows } = memoryStore();
    await read(store, z.f);
    pays[2] = { ...pays[2], modified: T2 };                 // edited in Zoho
    pays[4] = { ...pays[4], status: "void", modified: T2 };   // voided
    pays.push({ id: "p11", modified: T2, account: "ZA-HDFC" }); // new
    z.reset();
    await store.refresh("2025-26", { onlyAccount: null, nowIso: "" });
    const again = await read(store, z.f);
    expect(again).toMatchObject({ listed: 11, detailed: 11, complete: true });
    const read2 = z.urls.filter((u) => /\/customerpayments\/./.test(u.pathname)).map((u) => u.pathname.split("/").pop()).sort();
    expect(read2).toEqual(["p11", "p3", "p5"]);
    expect(rows.get("p3")!.modified).toBe(T2);
  });

  it("a payment that only moved pages while Zoho was listed (another one deleted mid-list) is re-checked and KEPT", async () => {
    let pays = year(450);
    const z = fakeZoho(() => pays);
    const { store, rows } = memoryStore();
    await read(store, z.f);
    await store.refresh("2025-26", { onlyAccount: null, nowIso: "" });
    /* page 1 listed … then p5 (page 1) is deleted in Zoho: p201 slides onto page 1 and page 2 starts at p202 */
    await scanStep(store, "customerpayments", zohoReceiptFacts, "600", "tok", "2025-26", { ...noWait, maxCalls: 1 }, z.f);
    pays = pays.filter((p) => p.id !== "p5");
    z.reset();
    const rest = await read(store, z.f);
    expect(rest).toMatchObject({ listed: 450, detailed: 450, complete: true });
    expect(rows.has("p201")).toBe(true);           // never listed this time, still in Zoho → re-checked, kept
    expect(rows.get("p201")!.payload).not.toBeNull();
    expect(z.details()).toBe(1);                   // only the one not listed was checked
    /* p5 was listed before it was deleted — the next Read again drops it */
    z.reset();
    await store.refresh("2025-26", { onlyAccount: null, nowIso: "" });
    expect(await read(store, z.f)).toMatchObject({ listed: 449, detailed: 449, complete: true });
    expect(rows.has("p5")).toBe(false);
  });

  it("a payment deleted in Zoho is dropped only after the full list is in (a list stopped half way drops nothing)", async () => {
    let pays = year(450);
    const z = fakeZoho(() => pays);
    const { store, rows } = memoryStore();
    await read(store, z.f);
    pays = pays.filter((p) => p.id !== "p7");
    await store.refresh("2025-26", { onlyAccount: null, nowIso: "" });
    /* One call only: page 1 of 3 listed — p7 (page 1) is simply not listed yet; nothing is dropped. */
    const half = await scanStep(store, "customerpayments", zohoReceiptFacts, "600", "tok", "2025-26", { ...noWait, maxCalls: 1 }, z.f);
    expect(half.listDone).toBe(false);
    expect(rows.size).toBe(450);
    const rest = await read(store, z.f);
    expect(rest).toMatchObject({ listed: 449, detailed: 449, complete: true });
    expect(rows.has("p7")).toBe(false);
  });

  it("deposit account filter (Razorpay Clearing): ~list + that account's new/changed payments only; others left as they were", async () => {
    const pays = year(2576);   // every 10th → ZA-RZP (257)
    const z = fakeZoho(() => pays);
    const { store, rows } = memoryStore();
    await read(store, z.f);
    const oldHdfc = rows.get("p1")!.payload;
    /* Since then: every Razorpay payment edited in Zoho (fee booked), one HDFC edited, two new (one each). */
    for (const p of pays) if (p.account === "ZA-RZP") p.modified = T2;
    pays[0] = { ...pays[0], modified: T2 };
    pays.push({ id: "n-rzp", modified: T2, account: "ZA-RZP" }, { id: "n-hdfc", modified: T2, account: "ZA-HDFC" });
    z.reset();
    await store.refresh("2025-26", { onlyAccount: "ZA-RZP", nowIso: "" });
    const again = await read(store, z.f);
    expect(again.complete).toBe(true);
    expect(z.lists()).toBe(13);
    expect(z.details()).toBe(258);              // 257 edited + 1 new Razorpay — not 2,578
    expect(z.lists() + z.details()).toBeLessThan(300);
    expect(rows.has("n-hdfc")).toBe(false);     // new HDFC payment: not read this time
    expect(rows.get("p1")!.payload).toBe(oldHdfc); // edited HDFC payment: kept as it was …
    expect(rows.get("p1")!.modified).toBe(T1);    // … and still "old", so a read of all accounts re-checks it

    z.reset();
    await store.refresh("2025-26", { onlyAccount: null, nowIso: "" });
    await read(store, z.f);
    expect(z.urls.filter((u) => /\/customerpayments\/./.test(u.pathname)).map((u) => u.pathname.split("/").pop()).sort()).toEqual(["n-hdfc", "p1"]);
  });

  it("a first read (no Read again) still works as before — nothing swept, every detail read once", async () => {
    const z = fakeZoho(() => year(5));
    const { store, runs } = memoryStore();
    const r = await read(store, z.f);
    expect(r).toMatchObject({ listed: 5, detailed: 5, complete: true });
    expect(runs.get("2025-26")!.listStartedAt ?? null).toBeNull();
  });
});
