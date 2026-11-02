/* R-2361 — the pure rules behind "Mark reconciled manually": reason check, which lines can be a
   reversal, and what a reconciled line shows under its badge. */
import { describe, expect, it } from "vitest";

import { lineNoteLines, reasonProblem, reversalCandidates, reversalLabel, type LineLike } from "./manual-reconcile";

const line = (over: Partial<LineLike>): LineLike => ({
  id: "x", bank_account_id: "acc-1", txn_date: "2026-10-10", description: "", debit: 0, credit: 0, matched_to_type: null, ...over,
});

describe("reasonProblem", () => {
  it("needs 5+ characters after trimming", () => {
    expect(reasonProblem("")).toMatch(/Write why/);
    expect(reasonProblem("  ab  ")).toMatch(/at least 5/);
    expect(reasonProblem("RTGS failed")).toBeNull();
    expect(reasonProblem("x".repeat(501))).toMatch(/under 500/);
  });
});

describe("reversalCandidates", () => {
  const out = line({ id: "out", debit: 1200000 });
  it("same account, same amount, other side, open, within 30 days — nearest first", () => {
    const lines = [
      line({ id: "far", credit: 1200000, txn_date: "2026-11-20" }),          // 41 days
      line({ id: "ok-late", credit: 1200000, txn_date: "2026-10-25" }),
      line({ id: "ok-near", credit: 1200000, txn_date: "2026-10-12" }),
      line({ id: "other-acc", credit: 1200000, bank_account_id: "acc-2" }),
      line({ id: "amount", credit: 1199999 }),
      line({ id: "same-side", debit: 1200000 }),
      line({ id: "done", credit: 1200000, matched_to_type: "manual" }),
      out,
    ];
    expect(reversalCandidates(out, lines).map((l) => l.id)).toEqual(["ok-near", "ok-late"]);
  });
});

describe("lineNoteLines", () => {
  const partner = line({ id: "p", credit: 1200000, txn_date: "2026-10-12" });
  const byId = new Map([["p", partner]]);
  it("a paired manual line shows the reversal and the reason", () => {
    expect(lineNoteLines({ id: "a", matched_to_type: "manual", reconcile_note: " RTGS failed ", reversal_of: "p" }, byId))
      .toEqual({ reversal: reversalLabel(partner), note: "RTGS failed" });
    expect(reversalLabel(partner)).toBe("Reversal of 12 Oct 2026 ₹12,00,000");
  });
  it("an Owner capital / drawings line shows its booking note", () => {
    expect(lineNoteLines({ id: "o", matched_to_type: "owner_equity" }, byId, new Map([["o", "Capital from Pardeep"]])))
      .toEqual({ reversal: null, note: "Capital from Pardeep" });
  });
  it("an open line or a line with nothing to say shows nothing", () => {
    expect(lineNoteLines({ id: "a", matched_to_type: null, reconcile_note: "x" }, byId)).toBeNull();
    expect(lineNoteLines({ id: "a", matched_to_type: "payment" }, byId)).toBeNull();
  });
});
