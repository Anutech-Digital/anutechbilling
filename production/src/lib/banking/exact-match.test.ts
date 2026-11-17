/** R-2677: "Match all exact" — the sheet's pure helpers (the server re-checks every row). */
import { describe, expect, it } from "vitest";

import {
  EXACT_LINE_CAP, bookExactText, exactScope, exactSummary, mergeBookResults, reviewRows, rowsToBook, scopeText, sortExactRows, undoExactText,
  type ExactRow,
} from "./exact-match";

const row = (id: string, status: ExactRow["status"], extra: Partial<ExactRow> = {}): ExactRow => ({
  txn_id: id, txn_date: "2025-04-10", description: "NEFT", amount: 1000, direction: "out", status,
  kind: status === "exact" ? "expense" : null, match_id: status === "exact" ? `EXP-${id}` : null,
  match_label: null, match_amount: null, match_date: null, why: "because", ...extra,
});

describe("exactScope / scopeText — the page's own filter", () => {
  it("takes dates and money in / out from the page filter", () => {
    expect(exactScope({ from: "2025-04-01", to: "2025-04-30", dir: "out" })).toEqual({ from: "2025-04-01", to: "2025-04-30", dir: "out" });
    expect(exactScope({ from: "", to: null, dir: "all" })).toEqual({ from: null, to: null, dir: "all" });
  });
  it("says which lines were checked", () => {
    const fmt = (s: string) => s;
    expect(scopeText({ from: "2025-04-01", to: "2025-04-30", dir: "in" }, fmt)).toBe("2025-04-01 – 2025-04-30 · money in");
    expect(scopeText({ from: null, to: null, dir: "all" }, fmt)).toBe("all dates");
    expect(scopeText({ from: "2025-05-01", to: null, dir: "out" }, fmt)).toBe("from 2025-05-01 · money out");
  });
});

describe("exactSummary", () => {
  it("counts each status and the exact amount", () => {
    const s = exactSummary([row("1", "exact", { amount: 2548 }), row("2", "exact", { amount: 1416 }), row("3", "ambiguous"),
      row("4", "locked"), row("5", "drawer"), row("6", "likely"), row("7", "none")]);
    expect(s).toMatchObject({ checked: 7, exact: 2, exactAmount: 3964, ambiguous: 1, locked: 1, drawer: 1, likely: 1, none: 1, cut: false });
  });
  it("says when the server stopped at its cap", () => {
    const rows = Array.from({ length: EXACT_LINE_CAP }, (_, i) => row(String(i), "none"));
    expect(exactSummary(rows).cut).toBe(true);
  });
});

describe("rowsToBook — only ticked exact rows go to the server", () => {
  it("drops unticked rows and every non-exact row", () => {
    const rows = [row("1", "exact"), row("2", "exact"), row("3", "ambiguous", { kind: "payment", match_id: "P3" }), row("4", "likely")];
    expect(rowsToBook(rows, new Set(["2"]))).toEqual([{ txn_id: "1", match_type: "expense", match_id: "EXP-1" }]);
  });
  it("an exact row with no record is never sent", () => {
    expect(rowsToBook([row("1", "exact", { match_id: null })], new Set())).toEqual([]);
  });
  it("reviewRows lists ambiguous / locked / drawer, not the no-record lines", () => {
    const r = reviewRows([row("1", "exact"), row("2", "ambiguous"), row("3", "locked"), row("4", "drawer"), row("5", "none"), row("6", "likely")]);
    expect(r.map((x) => x.txn_id)).toEqual(["2", "3", "4"]);
  });
});

describe("result words", () => {
  it("book", () => {
    expect(bookExactText({ run_id: "r", booked: 3, skipped: [] })).toEqual({ title: "3 lines matched to the records already in the books", detail: null, tone: "success" });
    expect(bookExactText({ run_id: null, booked: 0, skipped: [{ txn_id: "1", reason: "Already reconciled (matched meanwhile)." }] }))
      .toEqual({ title: "Nothing was matched", detail: "1 line not matched — Already reconciled (matched meanwhile).", tone: "warning" });
  });
  it("undo", () => {
    expect(undoExactText({ run_id: "r", undone: 2, left: [], remaining: 0 }).title).toBe("2 lines un-reconciled — open again");
    expect(undoExactText({ run_id: "r", undone: 0, left: [], remaining: 0 }).title).toBe("Nothing left to undo");
    expect(undoExactText({ run_id: "r", undone: 1, left: [{ txn_id: "x", reason: "Changed since the run" }], remaining: 0 }).detail).toBe("1 line left as it is — Changed since the run");
  });
});

describe("paging and chunks — one press is one run", () => {
  it("sorts the id-paged lines by date, then id", () => {
    const r = sortExactRows([row("b", "none", { txn_date: "2025-04-02" }), row("c", "none", { txn_date: "2025-04-01" }), row("a", "none", { txn_date: "2025-04-02" })]);
    expect(r.map((x) => x.txn_id)).toEqual(["c", "a", "b"]);
  });
  it("adds the chunks' answers up under the first run id", () => {
    expect(mergeBookResults([
      { run_id: "R1", booked: 50, skipped: [] },
      { run_id: "R1", booked: 3, skipped: [{ txn_id: "x", reason: "Already reconciled (matched meanwhile)." }] },
    ])).toEqual({ run_id: "R1", booked: 53, skipped: [{ txn_id: "x", reason: "Already reconciled (matched meanwhile)." }] });
  });
  it("says when a later chunk stopped the press", () => {
    const t = bookExactText({ run_id: "R1", booked: 50, skipped: [], stoppedEarly: "canceling statement due to statement timeout" });
    expect(t.tone).toBe("warning");
    expect(t.detail).toContain("Stopped before the end");
  });
});
