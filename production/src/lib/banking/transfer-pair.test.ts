/** R-2656: the pair finder's sums and words (the pairing itself: supabase/tests/r2656_bank_pair_detector.test.sql). */
import { describe, expect, it } from "vitest";

import { bookResultText, pairSummary, pairsToBook, undoResultText, type PairRow } from "./transfer-pair";

const row = (o: string, i: string, status: PairRow["status"], amount = 1000, out_date = "2026-10-01"): PairRow => ({
  kind: "transfer", status, reason: "Transfer word in the narration", amount,
  out_txn_id: o, out_account_id: "A", out_account: "HDFC 4523", out_date, out_description: "TRF TO FD",
  in_txn_id: i, in_account_id: "F", in_account: "HDFC FD 1", in_date: out_date, in_description: "DEPOSIT",
});

describe("R-2656 pair finder", () => {
  it("counts sure pairs, their lines and rupees; the rest by status", () => {
    const s = pairSummary([row("1", "2", "sure", 500000), row("3", "4", "sure", 1500), row("5", "6", "ambiguous"), row("5", "7", "ambiguous"), row("8", "9", "other_side_booked"), row("10", "11", "locked"), row("12", "13", "check")]);
    expect(s).toEqual({ sure: 2, sureAmount: 501500, check: 1, ambiguous: 2, otherSideBooked: 1, locked: 1 });
  });

  it("Book sends only sure pairs, each line once", () => {
    expect(pairsToBook([row("1", "2", "sure"), row("5", "6", "ambiguous"), row("1", "9", "sure"), row("3", "4", "sure"), row("8", "9", "locked"), row("12", "13", "check")]))
      .toEqual([{ out_txn_id: "1", in_txn_id: "2" }, { out_txn_id: "3", in_txn_id: "4" }]);
  });

  it("words the Book result, with the first skip reason", () => {
    expect(bookResultText({ run_id: "r", booked: 7, skipped: [] })).toEqual({ title: "7 pairs booked (14 lines reconciled)", detail: null, tone: "success" });
    expect(bookResultText({ run_id: "r", booked: 1, skipped: [{ out_txn_id: "a", in_txn_id: "b", reason: "Not a sure pair any more." }] }))
      .toEqual({ title: "1 pair booked (2 lines reconciled)", detail: "1 pair not booked — Not a sure pair any more.", tone: "warning" });
    expect(bookResultText({ run_id: null, booked: 0, skipped: [] }).title).toBe("Nothing was booked");
  });

  it("words the Undo result", () => {
    expect(undoResultText({ run_id: "r", undone: 6, left: [{ out_txn_id: "a", in_txn_id: "b", txn_date: "2026-03-24", amount: 500000, reason: "Changed since the run" }] }))
      .toEqual({ title: "6 pairs undone — the lines are open again", detail: "1 pair left as it is — Changed since the run", tone: "warning" });
    expect(undoResultText({ run_id: "r", undone: 0, left: [] }).title).toBe("Nothing left to undo");
    expect(undoResultText({ run_id: "r", undone: 0, left: [{ out_txn_id: "a", in_txn_id: "b", txn_date: "2026-03-24", amount: 5, reason: "Books are locked" }] }))
      .toEqual({ title: "Nothing was undone", detail: "1 pair left as it is — Books are locked", tone: "warning" });
  });
});
