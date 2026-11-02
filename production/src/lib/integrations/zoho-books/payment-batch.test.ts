/**
 * R-2360 — Banking "Zoho has a match": one batch read of Zoho payments for the window, matched in
 * memory with R-2359's rules, cached 30 min. Zoho is a fake fetch; values are made up.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  BATCH_CACHE_MS, MAX_PAYMENT_PAGES, cachedZohoPayments, clearZohoBatchCache, countZohoMatches,
  lineHasZohoMatch, linesWithZohoMatch, paymentWindow, readZohoPaymentsInWindow, type BatchLine,
} from "./payment-batch";
import type { ZohoPaymentRow } from "./payment-match";

const pay = (o: Partial<ZohoPaymentRow>): ZohoPaymentRow => ({
  zohoId: "p", number: "1", date: "2026-07-21", amount: 0, reference: "", customerZohoId: "c", customerName: "X", ...o,
});
const line = (o: Partial<BatchLine>): BatchLine => ({ id: "l", txnDate: "2026-07-21", credit: 0, description: null, reference: null, ...o });

function zoho(pages: Array<Array<Record<string, unknown>>>) {
  const calls: URL[] = [];
  const f = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const rows = pages[page - 1] ?? [];
    return Promise.resolve(new Response(JSON.stringify({ code: 0, customerpayments: rows, page_context: { has_more_page: page < pages.length } }), { status: 200 }));
  }) as typeof fetch;
  return { f, calls };
}

beforeEach(() => clearZohoBatchCache());

describe("R-2360 which bank lines have a Zoho payment", () => {
  it("the window covers every line ± 3 days", () => {
    expect(paymentWindow([{ txnDate: "2026-07-21" }, { txnDate: "2026-04-02" }])).toEqual({ from: "2026-03-30", to: "2026-07-24" });
    expect(paymentWindow([])).toBeNull();
  });

  it("UTR in the Zoho reference (the owner's HDFC example) counts; leading zeros ignored", () => {
    const l = line({ credit: 27081, description: "NEFT CR-IDFB0080202-SUPREME MEDIA-IDFB6202M2890149" });
    expect(lineHasZohoMatch(l, [pay({ amount: 1, date: "2026-01-01", reference: "IDFB6202M2890149" })])).toBe(true);
    expect(lineHasZohoMatch(line({ credit: 5, reference: "0000162440272175" }), [pay({ date: null, reference: "162440272175" })])).toBe(true);
  });

  it("no UTR hit → amount ±₹2 and date ±3 days; outside either → no match", () => {
    const l = line({ credit: 11800, txnDate: "2026-07-21" });
    expect(lineHasZohoMatch(l, [pay({ amount: 11802, date: "2026-07-24" })])).toBe(true);
    expect(lineHasZohoMatch(l, [pay({ amount: 11803, date: "2026-07-21" })])).toBe(false);
    expect(lineHasZohoMatch(l, [pay({ amount: 11800, date: "2026-07-25" })])).toBe(false);
  });

  it("only money-in lines with a candidate are listed", () => {
    const ids = linesWithZohoMatch(
      [line({ id: "a", credit: 500 }), line({ id: "b", credit: 900 }), line({ id: "c", credit: 0 })],
      [pay({ amount: 500 }), pay({ amount: 0 })],
    );
    expect(ids).toEqual(["a"]);
  });

  it("reads Zoho page by page for the window, never once per line", async () => {
    const z = zoho([[{ payment_id: "p1", amount: 500, date: "2026-07-21" }], [{ payment_id: "p2", amount: 900, date: "2026-07-22" }]]);
    const lines = Array.from({ length: 40 }, (_, i) => line({ id: `l${i}`, credit: i % 2 ? 500 : 900 }));
    const r = await countZohoMatches("t1", lines, { orgId: "600", token: "x", fetch: z.f });
    expect(z.calls).toHaveLength(2);
    expect(z.calls.every((u) => u.pathname.endsWith("/customerpayments") && u.searchParams.get("date_start") === "2026-07-18"
      && u.searchParams.get("date_end") === "2026-07-24" && !u.searchParams.has("reference_number_contains"))).toBe(true);
    expect(r).toMatchObject({ lines: 40, payments: 2, complete: true });
    expect(r.txnIds).toHaveLength(40);
  });

  it("stops after MAX_PAYMENT_PAGES and says the read is not complete", async () => {
    const z = zoho(Array.from({ length: MAX_PAYMENT_PAGES + 3 }, (_, i) => [{ payment_id: `p${i}`, amount: 1 }]));
    const r = await readZohoPaymentsInWindow("2026-01-01", "2026-12-31", { orgId: "600", token: "x", fetch: z.f });
    expect(z.calls).toHaveLength(MAX_PAYMENT_PAGES);
    expect(r.complete).toBe(false);
  });

  it("the same company + window within 30 min is served from the cache; another company or later → Zoho again", async () => {
    const z = zoho([[{ payment_id: "p1", amount: 500 }]]);
    let now = 1_000_000;
    const deps = { orgId: "600", token: "x", fetch: z.f };
    await cachedZohoPayments("t1", "2026-07-18", "2026-07-24", deps, () => now);
    now += BATCH_CACHE_MS - 1;
    const again = await cachedZohoPayments("t1", "2026-07-18", "2026-07-24", deps, () => now);
    expect(z.calls).toHaveLength(1);
    expect(again.readAt).toBe(new Date(1_000_000).toISOString());
    await cachedZohoPayments("t2", "2026-07-18", "2026-07-24", deps, () => now);
    expect(z.calls).toHaveLength(2);
    now += 2;
    await cachedZohoPayments("t1", "2026-07-18", "2026-07-24", deps, () => now);
    expect(z.calls).toHaveLength(3);
  });

  it("no money-in lines → Zoho not asked", async () => {
    const z = zoho([[]]);
    const r = await countZohoMatches("t1", [line({ credit: 0 })], { orgId: "600", token: "x", fetch: z.f });
    expect(z.calls).toHaveLength(0);
    expect(r.txnIds).toEqual([]);
  });
});
