/**
 * R-2499 — the generic FY import framework's resumable read (here: invoices, list then details) into its own
 * scan. Zoho is a fake fetch in v3 shapes (money in RUPEES as Zoho sends it); the store is memory.
 * Names and numbers are made up.
 */
import { describe, it, expect } from "vitest";
import { scanStep, type ScanStore, type ScanRun, type ListedRow } from "./scan";
import { zohoSaleFacts, type ZohoSaleFacts } from "../sales-import/normalise";

function memoryStore() {
  const runs = new Map<string, ScanRun>();
  const rows = new Map<string, ListedRow & { fy: string; payload: ZohoSaleFacts | null }>();
  const store: ScanStore<ZohoSaleFacts> = {
    async readRun(fy) { return runs.get(fy) ?? null; },
    async saveRun(fy, r) { runs.set(fy, { ...r }); },
    async addListed(fy, list) {
      for (const x of list) {
        const p = rows.get(x.zohoId);
        rows.set(x.zohoId, { ...x, fy, payload: p && p.status === x.status ? p.payload : null });
      }
    },
    async pendingDetails(fy, limit) { return [...rows.values()].filter((r) => r.fy === fy && !r.payload).map((r) => r.zohoId).slice(0, limit); },
    async saveDetail(_fy, id, facts) { rows.get(id)!.payload = facts; },
    async counts(fy) {
      const all = [...rows.values()].filter((r) => r.fy === fy);
      return { listed: all.length, detailed: all.filter((r) => r.payload).length };
    },
    async reset(fy) { runs.delete(fy); for (const [k, v] of rows) if (v.fy === fy) rows.delete(k); },
  };
  return { store, rows };
}

/** Zoho with `n` invoices over pages of `per`; one is dated outside the FY (Zoho filter slip). */
function fakeZoho(n: number, per = 2) {
  const urls: URL[] = [];
  const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  const f = (async (input: string) => {
    const u = new URL(input);
    urls.push(u);
    const path = u.pathname.replace("/books/v3/", "");
    if (path.startsWith("invoices/")) {
      const id = path.split("/")[1];
      const i = Number(id.replace("inv-", ""));
      return j({ code: 0, invoice: {
        invoice_id: id, invoice_number: `INV/25-26/${String(i).padStart(4, "0")}`, date: "2025-06-01", due_date: "2025-06-15",
        status: i === 2 ? "void" : "paid", customer_id: "c1", customer_name: "Test Buyer", total: 1180.5, tax_total: 180.09,
        adjustment: 0.41, currency_code: "INR", gst_no: "29ABCDE1234F1Z5", gst_treatment: "business_gst", place_of_supply: "KA",
        taxes: [{ tax_name: "IGST18", tax_amount: 180.09 }],
        line_items: [{ item_id: "zi", name: "Cloud Seat", description: "", hsn_or_sac: "998315", quantity: 1, rate: 1000, item_total: 1000, tax_name: "IGST18", tax_percentage: 18 }],
      } });
    }
    const page = Number(u.searchParams.get("page") ?? 1);
    const start = (page - 1) * per;
    const list = Array.from({ length: Math.max(0, Math.min(per, n - start)) }, (_, k) => {
      const i = start + k + 1;
      return { invoice_id: `inv-${i}`, invoice_number: `INV/25-26/${String(i).padStart(4, "0")}`, date: i === n ? "2026-04-02" : "2025-06-01", status: i === 2 ? "void" : "paid", total: 1180.5 };
    });
    return j({ code: 0, invoices: list, page_context: { page, has_more_page: start + per < n } });
  }) as unknown as typeof fetch;
  return { f, urls };
}

const toFacts = (d: Parameters<typeof zohoSaleFacts>[0]) => zohoSaleFacts(d, "07");
const noWait = { sleep: async () => {}, now: () => 0, budget: 1000 };

describe("R-2499 scan — resumable, server-side, READ only", () => {
  it("lists the FY page by page, then reads each detail; stops on the call limit and carries on", async () => {
    const { store, rows } = memoryStore();
    const z = fakeZoho(5);   // inv-5 is dated outside the FY → never kept
    const a = await scanStep(store, "invoices", toFacts, "600", "tok", "2025-26", { ...noWait, maxCalls: 2 }, z.f);
    expect(a).toMatchObject({ listed: 4, detailed: 0, listDone: false, complete: false, calls: 2 });
    const b = await scanStep(store, "invoices", toFacts, "600", "tok", "2025-26", { ...noWait, maxCalls: 3 }, z.f);
    expect(b).toMatchObject({ listed: 4, detailed: 2, listDone: true, complete: false });
    const c = await scanStep(store, "invoices", toFacts, "600", "tok", "2025-26", { ...noWait, maxCalls: 50 }, z.f);
    expect(c).toMatchObject({ listed: 4, detailed: 4, complete: true });
    expect(rows.has("inv-5")).toBe(false);
    expect(z.urls.every((u) => u.searchParams.get("organization_id") === "600")).toBe(true);
    const lists = z.urls.filter((u) => u.pathname === "/books/v3/invoices");
    expect(lists.map((u) => u.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(lists.every((u) => u.searchParams.get("date_start") === "2025-04-01" && u.searchParams.get("date_end") === "2026-03-31")).toBe(true);
  });

  it("stores whole rupees (paise converted once) and Zoho's status, void included", async () => {
    const { store, rows } = memoryStore();
    await scanStep(store, "invoices", toFacts, "600", "tok", "2025-26", { ...noWait, maxCalls: 50 }, fakeZoho(3).f);
    const one = rows.get("inv-1")!.payload!;
    // 1180.50 − 180.09 − 0.41 = 1000.00 taxable; 180 GST; 1181 total (half up)
    expect(one).toMatchObject({ taxable: 1000, tax: 180, amount: 1181, head: "igst", taxRate: 18, problems: [] });
    expect(rows.get("inv-2")!.payload!.problems[0]).toMatch(/Void in Zoho/);
  });

  it("a rerun reads nothing again when Zoho has not changed", async () => {
    const { store } = memoryStore();
    const z = fakeZoho(3);
    await scanStep(store, "invoices", toFacts, "600", "tok", "2025-26", { ...noWait, maxCalls: 50 }, z.f);
    const before = z.urls.length;
    const again = await scanStep(store, "invoices", toFacts, "600", "tok", "2025-26", { ...noWait, maxCalls: 50 }, z.f);
    expect(again.complete).toBe(true);
    expect(z.urls.length).toBe(before);
  });
});
