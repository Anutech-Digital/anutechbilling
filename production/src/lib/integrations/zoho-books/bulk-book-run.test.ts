/**
 * R-2535 — the run rules: what is a clean pair (UTR-paired, nothing to check), the preview counts,
 * the browser sending rows 10 at a time under ONE run id and stopping at the first failure, and the
 * server's screen (money exact, one line once).
 */
import { describe, it, expect } from "vitest";
import type { PlanRow } from "./bulk-reconcile-plan";
import { bookKindOf, bookOnServer, BOOK_CHUNK, isCleanPair, previewCounts, screenRows, type ScreenRow } from "./bulk-book-run";

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
function row(n: number, over: Partial<PlanRow> = {}): PlanRow {
  return {
    txnId: id(n), txnDate: "2025-10-10", credit: 1000 * n, description: null, kind: "match", summary: null,
    zoho: { paymentId: "z", paymentNumber: "P", by: "utr", amount: 1000 * n, invoiceNumbers: [], candidates: 1 },
    customer: { kind: "existing", id: "c1", name: "Buyer", by: "gstin" }, lines: [], seatDiffs: [], saleTotal: null, tds: 0,
    payer: null, problems: [], notes: [], ticked: true,
    book: { kind: "new_sale", item: null, opening: null } as unknown as PlanRow["book"],
    ...over,
  } as PlanRow;
}

describe("R-2535 clean pairs and the preview", () => {
  it("only a UTR-paired, ticked row with no problem is clean", () => {
    expect(isCleanPair(row(1))).toBe(true);
    expect(isCleanPair(row(2, { zoho: { ...row(2).zoho, by: "amount_date" } }))).toBe(false);
    expect(isCleanPair(row(3, { problems: ["Payer differs"], ticked: false }))).toBe(false);
    expect(isCleanPair(row(4, { book: null }))).toBe(false);
  });
  it("N clean pairs, M need a look — booked rows left out", () => {
    const plan = [row(1), row(2), row(3, { zoho: { ...row(3).zoho, by: "amount_date" } }), row(4, { problems: ["x"] })];
    expect(previewCounts(plan, new Set([id(2)]))).toEqual({ clean: 1, cleanTotal: 1000, needLook: 2 });
  });
  it("run line kinds: a single new sale is undoable, several invoices are a split", () => {
    expect(bookKindOf(row(1))).toBe("new_sale");
    expect(bookKindOf(row(1, { book: { kind: "new_sale", sales: [{}, {}] } as unknown as PlanRow["book"] }))).toBe("split");
    expect(bookKindOf(row(1, { book: { kind: "pay_item" } as unknown as PlanRow["book"] }))).toBe("pay_item");
  });
});

describe("R-2535 the server's screen", () => {
  const ok = (n: number, over: Partial<ScreenRow> = {}): ScreenRow => ({ txn_id: id(n), ok: true, reason: null, credit: 1000 * n, txn_date: "2025-10-10", ...over });
  it("refuses a matched / locked / unknown line, an amount that is not the line's, and the same line twice", () => {
    const rows = [row(1), row(2), row(3), row(4), row(5), row(5)];
    const screen = [ok(1), ok(2, { ok: false, reason: "matched" }), ok(3, { ok: false, reason: "locked" }), ok(5)];
    screen.push(ok(4, { credit: 3999 }));
    const { ok: good, refused } = screenRows(rows, screen);
    expect(good.map((r) => r.txnId)).toEqual([id(1), id(5)]);
    expect(refused.map((r) => r.reason)).toEqual([
      expect.stringMatching(/Already reconciled/), expect.stringMatching(/locked month/),
      expect.stringMatching(/amount or date/), expect.stringMatching(/sent twice/),
    ]);
  });
});

describe("R-2535 bookOnServer", () => {
  it(`sends ${BOOK_CHUNK} rows a request under the first answer's run id`, async () => {
    const bodies: Array<{ runId: string | null; rows: PlanRow[] }> = [];
    const post = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      bodies.push(b);
      return new Response(JSON.stringify({ ok: true, runId: "run-1", refused: [], error: null,
        done: b.rows.map((r: PlanRow) => ({ txnId: r.txnId, outcome: "booked" })) }));
    }) as unknown as typeof fetch;
    const rows = Array.from({ length: 23 }, (_, i) => row(i + 1));
    const seen: number[] = [];
    const res = await bookOnServer("acc", rows, null, post, (at) => seen.push(at));
    expect(bodies.map((b) => b.rows.length)).toEqual([10, 10, 3]);
    expect(bodies.map((b) => b.runId)).toEqual([null, "run-1", "run-1"]);
    expect(res.done).toHaveLength(23);
    expect(seen).toEqual([10, 20, 23]);
  });
  it("stops at the first row the server could not book; later chunks are not sent", async () => {
    let calls = 0;
    const post = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true, runId: "run-1", refused: [], done: [], error: { txnId: id(1), txnDate: "2025-10-10", credit: 1000, reason: "Below cost" } }));
    }) as unknown as typeof fetch;
    const res = await bookOnServer("acc", Array.from({ length: 15 }, (_, i) => row(i + 1)), null, post);
    expect(calls).toBe(1);
    expect(res.error?.reason).toBe("Below cost");
  });
  it("a refused request (e.g. role) is reported as the error, nothing more sent", async () => {
    const post = (async () => new Response(JSON.stringify({ ok: false, error: "Only an owner or accountant can book from Zoho Books.", why: "x" }), { status: 403 })) as unknown as typeof fetch;
    const res = await bookOnServer("acc", [row(1)], null, post);
    expect(res.error?.reason).toMatch(/Only an owner/);
    expect(res.done).toEqual([]);
  });
});
