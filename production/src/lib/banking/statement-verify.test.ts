/**
 * R-1693 — the statement preview checks the running-balance chain BEFORE import.
 *
 * Staging, 20 Oct 2026 (HDFC, 24 pages): all 12 chunks came back 200, yet the AI simply
 * left lines out of its answers. After import the account was ₹7,96,835 short of the
 * statement's closing balance, with many "Lines missing between …" gaps — and nothing had
 * said so before import. These tests pin: a break is found (inside a chunk and across a
 * chunk border), the broken pages are re-read one at a time, a gap that stays is shown
 * and blocks import, a statement with no balance column says the check did NOT run, and a
 * CSV with a missing line is caught the same way.
 */
import { describe, it, expect } from "vitest";
import { checkPreview, rereadBrokenPages, assembleChunks, type ChunkEntry } from "./statement-verify";
import { parseStatement } from "./statement-parse";
import type { ChunkResult, PageRange, StatementRowLike } from "./statement-chunks";

type Row = StatementRowLike;

/** A clean statement: 2 lines per page, one line per day, balances that chain. */
function statement(pages: number): Row[][] {
  const out: Row[][] = [];
  let bal = 100_000;
  let n = 0;
  for (let p = 1; p <= pages; p++) {
    const page: Row[] = [];
    for (let k = 0; k < 2; k++) {
      n++;
      const debit = n % 3 === 0 ? 0 : 1_000 + n;
      const credit = n % 3 === 0 ? 5_000 + n : 0;
      bal = bal - debit + credit;
      page.push({ txn_date: `2026-04-${String(n).padStart(2, "0")}`, description: `UPI/line-${n}`, debit, credit, balance_after: bal });
    }
    out.push(page);
  }
  return out;
}

const range = (from: number, to: number): PageRange => ({ from, to });
const ok = (rows: Row[], extra: Partial<{ rowCount: number; returned: number }> = {}): ChunkResult<Row> =>
  ({ ok: true, rows, skipped: 0, ...extra });
const TODAY = "2026-10-21";

/** Chunks of 2 pages from a page list, with `drop` applied to the chunk that starts at `dropFrom`. */
function chunksOf(pages: Row[][], edit: (from: number, rows: Row[]) => Row[] = (_, r) => r): ChunkEntry<Row>[] {
  const out: ChunkEntry<Row>[] = [];
  for (let from = 1; from <= pages.length; from += 2) {
    const to = Math.min(pages.length, from + 1);
    out.push({ range: range(from, to), result: ok(edit(from, pages.slice(from - 1, to).flat())) });
  }
  return out;
}

describe("checkPreview — the balance chain over the preview rows", () => {
  it("a complete statement passes", () => {
    const rows = statement(4).flat();
    const c = checkPreview(rows);
    expect(c.ran).toBe(true);
    expect(c.gaps).toEqual([]);
    expect(c.blocking).toBe(false);
  });

  it("a line missing in the middle of a chunk is a gap, named by its pages and amount", () => {
    const pages = statement(6);
    const missing = pages[2][1];                       // page 3, second line
    const rows = assembleChunks(chunksOf(pages, (from, r) => (from === 3 ? r.filter((x) => x !== missing) : r))).rows;
    const c = checkPreview(rows);
    expect(c.blocking).toBe(true);
    expect(c.gaps).toHaveLength(1);
    expect(c.gaps[0].pages).toEqual(range(3, 4));
    expect(c.gaps[0].amount).toBe(missing.debit - missing.credit);
  });

  it("a break across a chunk border (last line of pages 1–2 missing) is found and spans both chunks", () => {
    const pages = statement(4);
    const missing = pages[1][1];                       // page 2, last line
    const rows = assembleChunks(chunksOf(pages, (from, r) => (from === 1 ? r.filter((x) => x !== missing) : r))).rows;
    const c = checkPreview(rows);
    expect(c.gaps).toHaveLength(1);
    expect(c.gaps[0].pages).toEqual(range(1, 4));
    expect(c.gaps[0].amount).toBe(missing.debit - missing.credit);
  });

  it("no balance column at all: the check did NOT run — it never claims a pass", () => {
    const rows = statement(2).flat().map((r) => ({ ...r, balance_after: null }));
    const c = checkPreview(rows);
    expect(c.ran).toBe(false);
    expect(c.gaps).toEqual([]);
    expect(c.blocking).toBe(false);
  });

  it("no balance column + the AI counted more lines than it wrote → blocking", () => {
    const rows = statement(2).flat().map((r) => ({ ...r, balance_after: null, page: range(1, 2) }));
    const c = checkPreview(rows, [{ pages: range(1, 2), counted: 5, returned: 4 }]);
    expect(c.ran).toBe(false);
    expect(c.rowCountIssues).toHaveLength(1);
    expect(c.blocking).toBe(true);
  });

  it("a row-count mismatch on pages the balance chain fully vouches for does not block", () => {
    const rows = statement(2).flat().map((r) => ({ ...r, page: range(1, 2) }));
    const c = checkPreview(rows, [{ pages: range(1, 2), counted: 5, returned: 4 }]);
    expect(c.blocking).toBe(false);
  });

  it("CSV (HDFC Delimited) with one line missing: the same gap — no pages, still blocking", () => {
    const csv = [
      "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
      "01/04/26,NEFT CR-ACME TRADERS,N1,01/04/26,,50000.00,150000.00",
      "02/04/26,UPI-AIRTEL,U2,02/04/26,1180.00,,148820.00",
      // 03/04/26 RENT 25000.00 → 123820.00 is missing from this file
      "04/04/26,UPI-SWIGGY,U4,04/04/26,420.00,,123400.00",
    ].join("\n");
    const parsed = parseStatement(csv);
    expect(parsed.rows).toHaveLength(3);
    const c = checkPreview(parsed.rows);
    expect(c.blocking).toBe(true);
    expect(c.gaps).toEqual([{ after: "2026-04-02", by: "2026-04-04", amount: 25000, pages: null }]);
  });
});

describe("rereadBrokenPages — broken pages are read again one page at a time", () => {
  it("a chunk missing a middle row → pages 3 and 4 re-read singly → the row is back, preview complete", async () => {
    const pages = statement(6);
    const missing = pages[2][1];
    const chunks = chunksOf(pages, (from, r) => (from === 3 ? r.filter((x) => x !== missing) : r));
    const asked: number[] = [];
    const out = await rereadBrokenPages({
      chunks, today: TODAY, concurrency: 1,
      readPage: async (p) => { asked.push(p); return ok(pages[p - 1]); },
    });
    expect(asked).toEqual([3, 4]);
    expect(out.retried).toEqual([3, 4]);
    expect(out.check.gaps).toEqual([]);
    expect(out.check.blocking).toBe(false);
    expect(out.rows).toHaveLength(12);
    expect(out.rows.find((r) => r.description === missing.description)?.page).toEqual(range(3, 3));
    expect(out.note).toMatch(/page 3, 4/i);
  });

  it("the re-read still misses the row → the gap stays, narrowed to its page, and blocks", async () => {
    const pages = statement(6);
    const missing = pages[2][1];
    const chunks = chunksOf(pages, (from, r) => (from === 3 ? r.filter((x) => x !== missing) : r));
    const out = await rereadBrokenPages({
      chunks, today: TODAY, concurrency: 1,
      readPage: async (p) => ok(pages[p - 1].filter((x) => x !== missing)),
    });
    expect(out.retried).toEqual([3, 4]);
    expect(out.check.blocking).toBe(true);
    expect(out.check.gaps).toHaveLength(1);
    expect(out.check.gaps[0].pages).toEqual(range(3, 4));
    expect(out.note).toMatch(/still missing/);
  });

  it("a border break is repaired by re-reading both chunks' pages", async () => {
    const pages = statement(4);
    const missing = pages[1][1];
    const chunks = chunksOf(pages, (from, r) => (from === 1 ? r.filter((x) => x !== missing) : r));
    const out = await rereadBrokenPages({ chunks, today: TODAY, concurrency: 2, readPage: async (p) => ok(pages[p - 1]) });
    expect(out.retried).toEqual([1, 2, 3, 4]);
    expect(out.check.gaps).toEqual([]);
  });

  it("a complete statement costs no extra calls", async () => {
    const pages = statement(6);
    let calls = 0;
    const out = await rereadBrokenPages({ chunks: chunksOf(pages), today: TODAY, readPage: async (p) => { calls++; return ok(pages[p - 1]); } });
    expect(calls).toBe(0);
    expect(out.retried).toEqual([]);
    expect(out.note).toBeNull();
  });

  it("the AI says a page had more lines than it wrote → that chunk is re-read even when balances are absent", async () => {
    const pages = statement(4).map((p) => p.map((r) => ({ ...r, balance_after: null })));
    const chunks: ChunkEntry<Row>[] = [
      { range: range(1, 2), result: ok(pages.slice(0, 2).flat().slice(0, 3), { rowCount: 4, returned: 3 }) },
      { range: range(3, 4), result: ok(pages.slice(2, 4).flat(), { rowCount: 4, returned: 4 }) },
    ];
    const asked: number[] = [];
    const out = await rereadBrokenPages({
      chunks, today: TODAY, concurrency: 1,
      readPage: async (p) => { asked.push(p); return ok(pages[p - 1], { rowCount: 2, returned: 2 }); },
    });
    expect(asked).toEqual([1, 2]);
    expect(out.rows).toHaveLength(8);
    expect(out.check.ran).toBe(false);
    expect(out.check.blocking).toBe(false);
  });

  it("re-reads are capped; the pages left out are named", async () => {
    const pages = statement(12);
    // every chunk loses its second line
    const chunks = chunksOf(pages, (_, r) => r.filter((_x, i) => i !== 1));
    let calls = 0;
    const out = await rereadBrokenPages({
      chunks, today: TODAY, maxPages: 4, concurrency: 1,
      readPage: async (p) => { calls++; return ok(pages[p - 1]); },
    });
    expect(calls).toBe(4);
    expect(out.retried).toEqual([1, 2, 3, 4]);
    expect(out.notRetried).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(out.check.blocking).toBe(true);
    expect(out.note).toMatch(/not re-read/);
  });

  it("Gemini paused (breaker open) → stops asking at once", async () => {
    const pages = statement(8);
    const chunks = chunksOf(pages, (_, r) => r.filter((_x, i) => i !== 1));
    let calls = 0;
    const out = await rereadBrokenPages({
      chunks, today: TODAY, concurrency: 1,
      readPage: async () => { calls++; return { ok: false, error: "AI ke kai call abhi lagatar fail hue", kind: "paused" }; },
    });
    expect(calls).toBe(1);
    expect(out.stopped).toMatch(/paused/);
    expect(out.check.blocking).toBe(true);
  });

  it("the time budget stops new re-reads", async () => {
    const pages = statement(8);
    const chunks = chunksOf(pages, (_, r) => r.filter((_x, i) => i !== 1));
    let t = 0;
    let calls = 0;
    const out = await rereadBrokenPages({
      chunks, today: TODAY, concurrency: 1, budgetMs: 100, now: () => t,
      readPage: async (p) => { calls++; t += 60; return ok(pages[p - 1]); },
    });
    expect(calls).toBe(2);   // started at 0 and 60; at 120 the budget is spent
    expect(out.stopped).toMatch(/time limit/);
  });
});
