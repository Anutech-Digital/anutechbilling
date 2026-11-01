/* R-2325 — which suggested expenses are already reconciled to another bank line, and the filter. */
import { describe, expect, it } from "vitest";

import { dropReconciledExpenses, expenseSuggestionIds, reconciledElsewhere } from "./reconciled-suggestions";

const s = (match_type: string, match_id: string) => ({ match_type, match_id });

describe("R-2325 reconciled expenses in Suggested matches", () => {
  it("reads only the expense ids, once each", () => {
    expect(expenseSuggestionIds([s("expense", "E2"), s("payment", "P1"), s("expense", "E1"), s("expense", "E2")])).toEqual(["E1", "E2"]);
    expect(expenseSuggestionIds(undefined)).toEqual([]);
  });

  it("reconciled_txn_id on another line, or another line matched to it → reconciled elsewhere", () => {
    const out = reconciledElsewhere(
      "t-now",
      [{ id: "E1", reconciled_txn_id: "t-old" }, { id: "E2", reconciled_txn_id: null }, { id: "E3", reconciled_txn_id: "t-now" }],
      [{ id: "t-older", matched_to_id: "E2" }, { id: "t-now", matched_to_id: "E4" }],
    );
    expect([...out].sort()).toEqual(["E1", "E2"]);
  });

  it("drops only those expenses; payments, salaries and open expenses stay", () => {
    const list = [s("expense", "E1"), s("expense", "E5"), s("payment", "E1"), s("salary", "S1")];
    expect(dropReconciledExpenses(list, new Set(["E1"]))).toEqual([s("expense", "E5"), s("payment", "E1"), s("salary", "S1")]);
    expect(dropReconciledExpenses(undefined, new Set())).toEqual([]);
  });
});
