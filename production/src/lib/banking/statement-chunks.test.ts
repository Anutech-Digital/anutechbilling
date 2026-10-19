/**
 * R-1690 — a long bank-statement PDF is read a few pages at a time.
 *
 * Measured on staging, 19 Oct 2026: a one-month statement timed out at 60 s on both models,
 * every time — one call has to write out every row as JSON, and that does not fit in 60 s.
 * These tests pin the pieces that make it fit: the page plan, the limited parallelism, the
 * merge in page order, the duplicate at a chunk border, and — the money rule — a chunk that
 * fails is NAMED, never silently missing from the preview.
 */
import { describe, it, expect } from "vitest";
import {
  planPageChunks,
  readStatementInChunks,
  mergeChunkRows,
  chunkResultFrom,
  pagesLabel,
  classifyStatementFailure,
  type PageRange,
} from "./statement-chunks";

type Row = { txn_date: string; description: string; debit: number; credit: number; balance_after: number | null };
const row = (n: number, page: number): Row => ({
  txn_date: `2026-09-${String(n).padStart(2, "0")}`,
  description: `UPI/row-${n}/p${page}`,
  debit: n % 2 ? 100 * n : 0,
  credit: n % 2 ? 0 : 100 * n,
  balance_after: 10_000 + n,
});

describe("planPageChunks", () => {
  it("12 pages → six chunks of 2, in page order", () => {
    expect(planPageChunks(12, 2)).toEqual([
      { from: 1, to: 2 }, { from: 3, to: 4 }, { from: 5, to: 6 },
      { from: 7, to: 8 }, { from: 9, to: 10 }, { from: 11, to: 12 },
    ]);
  });
  it("an odd last chunk is one page", () => {
    expect(planPageChunks(5, 2).at(-1)).toEqual({ from: 5, to: 5 });
  });
  it("labels read like a person writes them", () => {
    expect(pagesLabel({ from: 5, to: 6 })).toBe("5–6");
    expect(pagesLabel({ from: 7, to: 7 })).toBe("7");
  });
});

describe("mergeChunkRows", () => {
  it("drops a row repeated across a chunk border, keeps genuine repeats inside a chunk", () => {
    const a = [row(1, 1), row(2, 1), row(3, 2)];
    const b = [row(3, 2), row(4, 3)];             // row 3 sits on the border and came back twice
    const sameTwice = { ...row(5, 3) };
    const c = [sameTwice, { ...sameTwice }];       // two identical lines in ONE chunk: both real
    const out = mergeChunkRows([a, b, c]);
    expect(out.rows.map((r) => r.description)).toEqual([
      "UPI/row-1/p1", "UPI/row-2/p1", "UPI/row-3/p2", "UPI/row-4/p3", "UPI/row-5/p3", "UPI/row-5/p3",
    ]);
    expect(out.borderDuplicates).toBe(1);
  });
  it("a failed chunk between two good ones is no border — nothing is dropped across the gap", () => {
    const out = mergeChunkRows([[row(1, 1)], null, [row(1, 1)]]);
    expect(out.rows).toHaveLength(2);
    expect(out.borderDuplicates).toBe(0);
    expect(out.repeatsAcrossChunks).toBe(1);   // reported, not dropped
  });
});

describe("readStatementInChunks", () => {
  it("12-page PDF: six calls, at most 3 at a time, rows merged in page order, border duplicates removed", async () => {
    let inFlight = 0, maxInFlight = 0;
    const calls: PageRange[] = [];
    const progress: number[] = [];
    const out = await readStatementInChunks<Row>({
      pageCount: 12, chunkPages: 2, concurrency: 3,
      onProgress: (p) => progress.push(p.pagesDone),
      readChunk: async (r) => {
        calls.push(r);
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        // Later chunks answer FIRST — the merge must still follow page order.
        await new Promise((res) => setTimeout(res, (13 - r.from) * 2));
        inFlight--;
        const rows = [row(r.from, r.from), row(r.to, r.to)];
        // Every chunk after the first also repeats the previous chunk's last row.
        if (r.from > 1) rows.unshift(row(r.from - 1, r.from - 1));
        return { ok: true, rows, skipped: 1 };
      },
    });
    expect(calls).toHaveLength(6);
    expect(maxInFlight).toBe(3);
    expect(out.rows.map((r) => r.txn_date.slice(-2))).toEqual(
      ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"],
    );
    expect(out.borderDuplicates).toBe(5);
    expect(out.skipped).toBe(6);
    expect(out.failed).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(progress.at(-1)).toBe(12);
  });

  it("one chunk times out: the other rows come back and a warning names the missing pages", async () => {
    const out = await readStatementInChunks<Row>({
      pageCount: 12, chunkPages: 2, concurrency: 3,
      readChunk: async (r) =>
        r.from === 5
          ? { ok: false, error: "Statement bada hai — AI ko zyada samay laga." }
          : { ok: true, rows: [row(r.from, r.from), row(r.to, r.to)], skipped: 0 },
    });
    expect(out.rows).toHaveLength(10);
    expect(out.rows.some((r) => r.txn_date.endsWith("-05") || r.txn_date.endsWith("-06"))).toBe(false);
    expect(out.failed).toEqual([{ from: 5, to: 6, error: "Statement bada hai — AI ko zyada samay laga." }]);
    expect(out.allFailed).toBe(false);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/Page 5–6/);
    expect(out.warnings[0]).toMatch(/12 me se/);
    expect(out.warnings[0]).toMatch(/NAHI/);
  });

  it("a thrown read (network drop) counts as a failed chunk, not a crash", async () => {
    const out = await readStatementInChunks<Row>({
      pageCount: 4, chunkPages: 2,
      readChunk: async (r) => {
        if (r.from === 3) throw new Error("Failed to fetch");
        return { ok: true, rows: [row(1, 1)], skipped: 0 };
      },
    });
    expect(out.failed.map(pagesLabel)).toEqual(["3–4"]);
    expect(out.rows).toHaveLength(1);
  });

  it("every chunk failing is allFailed, with the first reason kept for the error", async () => {
    const out = await readStatementInChunks<Row>({
      pageCount: 4, chunkPages: 2,
      readChunk: async () => ({ ok: false, error: "The AI couldn't open this file." }),
    });
    expect(out.allFailed).toBe(true);
    expect(out.rows).toEqual([]);
    expect(out.failed[0].error).toBe("The AI couldn't open this file.");
  });

  it("rows repeated across non-adjacent chunks are kept but flagged for the preview", async () => {
    const out = await readStatementInChunks<Row>({
      pageCount: 6, chunkPages: 2,
      // The model ignored the page range and read from page 1 every time.
      readChunk: async (r) => ({
        ok: true,
        rows: Array.from({ length: r.to }, (_, i) => row(i + 1, i + 1)),
        skipped: 0,
      }),
    });
    expect(out.rows.length).toBeGreaterThan(6);      // kept, not guessed away …
    expect(out.warnings.join(" ")).toMatch(/ek se zyada hisson/);   // … and flagged
  });
});

describe("chunkResultFrom", () => {
  it("maps an ok response to rows and a refused one to its error", () => {
    expect(chunkResultFrom(true, { rows: [row(1, 1)], skipped: 2 })).toEqual({ ok: true, rows: [row(1, 1)], skipped: 2 });
    expect(chunkResultFrom(false, { error: "nope" })).toEqual({ ok: false, error: "nope" });
    expect(chunkResultFrom(false, null)).toEqual({ ok: false, error: "The AI reader failed." });
  });
});

describe("classifyStatementFailure", () => {
  it("a timeout is a big statement, not a busy Google", () => {
    expect(classifyStatementFailure("timed out after 60000ms")).toBe("timeout");
    expect(classifyStatementFailure("Gemini ne 60 second me jawab nahi diya, dobara koshish ke baad bhi.")).toBe("timeout");
  });
  it("503 / overload is busy", () => {
    expect(classifyStatementFailure("Gemini is temporarily unavailable — The model is overloaded. Nothing is misconfigured")).toBe("busy");
    expect(classifyStatementFailure("HTTP 503 high demand")).toBe("busy");
  });
  it("400 is an unopenable file; the breaker is its own case", () => {
    expect(classifyStatementFailure("Gemini rejected the request — Request contains an invalid argument.")).toBe("unreadable");
    expect(classifyStatementFailure("Gemini failed repeatedly just now, so calls are paused for a minute. It retries on its own.")).toBe("paused");
    expect(classifyStatementFailure("something else")).toBe("other");
  });
});
