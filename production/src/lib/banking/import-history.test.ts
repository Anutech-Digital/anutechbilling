/* R-1623 — the account page's Imports list: which lines belong to which import (batch, or an
   old import found by insert time), what "Ye import hatao" sends, and whether an import's
   balances clash with the rest of the account. */
import { describe, expect, it } from "vitest";

import {
  chainEffect,
  importKey,
  linesOfImport,
  reconciledLinesOf,
  removeImportArgs,
  sortImports,
  sourceLabel,
  type BankImportRow,
  type ImportLine,
} from "./import-history";

const base: BankImportRow = {
  kind: "batch", batch_id: null, legacy_from: null, legacy_to: null, file_name: null, source: "pdf",
  line_count: 0, imported_at: "2026-10-17T11:29:06.123456+00:00", imported_by: null, txn_from: null, txn_to: null,
  first_balance: null, last_balance: null, reconciled_count: 0, removed_at: null, removed_by: null,
  remove_reason: null, removed_lines: null,
};
const legacy: BankImportRow = {
  ...base, kind: "legacy", source: "legacy",
  legacy_from: "2026-10-17T11:29:06.123456Z", legacy_to: "2026-10-17T11:29:09.123456Z",
};
const batch: BankImportRow = { ...base, batch_id: "b1", file_name: "jan.pdf", imported_at: "2026-10-18T05:00:00+00:00" };

const line = (id: string, over: Partial<ImportLine> = {}): ImportLine => ({
  id, txn_date: "2026-03-01", debit: 100, credit: 0, balance_after: null, matched_to_type: null,
  import_batch_id: null, source: "csv_upload", created_at: "2026-10-17T11:29:06.123456+00:00", description: id, ...over,
});

describe("linesOfImport", () => {
  it("a batch owns exactly the lines stamped with it", () => {
    const lines = [line("a", { import_batch_id: "b1" }), line("b", { import_batch_id: "b2" }), line("c")];
    expect(linesOfImport(batch, lines).map((l) => l.id)).toEqual(["a"]);
  });

  it("an old import owns the unstamped csv lines inserted inside its range — microseconds included", () => {
    const lines = [
      line("first", { created_at: "2026-10-17T11:29:06.123456+00:00" }),
      line("last", { created_at: "2026-10-17T11:29:09.123456+00:00" }),
      line("typed", { created_at: "2026-10-17T11:29:07+00:00", source: "manual" }),      // not an import
      line("stamped", { created_at: "2026-10-17T11:29:07+00:00", import_batch_id: "b1" }),
      line("later", { created_at: "2026-10-17T11:49:00+00:00" }),
      line("before", { created_at: "2026-10-17T11:29:06.122+00:00" }),
    ];
    expect(linesOfImport(legacy, lines).map((l) => l.id)).toEqual(["first", "last"]);
  });
});

describe("reconciledLinesOf", () => {
  it("lists the import's matched lines — the ones to Un-reconcile first", () => {
    const lines = [line("a", { import_batch_id: "b1", matched_to_type: "expense" }), line("b", { import_batch_id: "b1" })];
    expect(reconciledLinesOf(batch, lines).map((l) => l.id)).toEqual(["a"]);
  });
});

describe("removeImportArgs", () => {
  it("a batch is sent by id", () => {
    expect(removeImportArgs(batch, "acc1", "  galat file ")).toEqual({
      p_account_id: "acc1", p_batch_id: "b1", p_legacy_from: null, p_legacy_to: null, p_reason: "galat file",
    });
  });
  it("an old import is sent by its exact insert-time range, untouched", () => {
    expect(removeImportArgs(legacy, "acc1", "17 Oct galat")).toEqual({
      p_account_id: "acc1", p_batch_id: null,
      p_legacy_from: "2026-10-17T11:29:06.123456Z", p_legacy_to: "2026-10-17T11:29:09.123456Z", p_reason: "17 Oct galat",
    });
  });
});

describe("list order and labels", () => {
  it("newest first, removed ones after the live ones of the same time", () => {
    expect(sortImports([legacy, batch]).map(importKey)).toEqual(["batch:b1", "legacy:2026-10-17T11:29:06.123456Z"]);
  });
  it("names each source in plain words", () => {
    expect(sourceLabel("pdf")).toBe("PDF");
    expect(sourceLabel("xlsx")).toBe("XLS / XLSX");
    expect(sourceLabel("paste")).toBe("Pasted");
    expect(sourceLabel("legacy")).toBe("Old import");
  });
});

describe("chainEffect — does this import clash with the account's balance chain?", () => {
  // A clean chain: 10,000 → 9,900 → 10,400 → 10,200
  const good = [
    line("g1", { txn_date: "2026-03-01", debit: 100, balance_after: 9900, import_batch_id: "b1" }),
    line("g2", { txn_date: "2026-03-02", debit: 0, credit: 500, balance_after: 10400, import_batch_id: "b1" }),
    line("g3", { txn_date: "2026-03-03", debit: 200, balance_after: 10200, import_batch_id: "b1" }),
  ];
  // A wrong import: same dates, amounts that do not fit the chain.
  const wrong = [
    line("w1", { txn_date: "2026-03-02", debit: 7000, balance_after: 3400 }),
    line("w2", { txn_date: "2026-03-03", debit: 0, credit: 50, balance_after: 3450 }),
  ];

  it("removing the wrong import clears the 'Lines missing'", () => {
    const fx = chainEffect([...good, ...wrong], linesOfImport(legacy, wrong), 10000);
    expect(fx).not.toBeNull();
    expect(fx!.before).toBeGreaterThan(0);
    expect(fx!.after).toBe(0);
  });

  it("an import that fits the chain is not flagged", () => {
    const fx = chainEffect(good, good.slice(2), 10000);
    expect(fx).toEqual({ before: 0, after: 0 });
  });

  it("says nothing when the statement has no running balance", () => {
    const noBal = good.map((l) => ({ ...l, balance_after: null }));
    expect(chainEffect(noBal, noBal.slice(0, 1), 10000)).toBeNull();
  });
});
