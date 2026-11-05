// @vitest-environment jsdom
/* R-2497 — the account page: a line dated before the opening date says "Before opening" (it is
   inside the opening, not counted), and the last opening change (old → new) is shown from
   bank_opening_history, so an import never overwrites the opening silently. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({ history: [] as unknown[] }));
vi.mock("@/lib/queries/bank", async (orig) => ({
  ...(await orig<object>()),
  useBankOpeningHistory: () => ({ data: state.history }),
}));

import { RunningBalanceText } from "./running-balance-text";
import { OpeningHistoryNote } from "./opening-history-note";
import { runningBalances } from "@/lib/banking/running-balance";

afterEach(() => cleanup());

describe("R-2497 account page", () => {
  it("a line before the opening date shows 'Before opening', not a balance", () => {
    const r = runningBalances(
      [
        { id: "old", txn_date: "2025-06-01", debit: 0, credit: 5000, balance_after: null },
        { id: "new", txn_date: "2026-05-01", debit: 0, credit: 2000, balance_after: null },
      ],
      100000,
      "2026-04-01",
    );
    render(<><RunningBalanceText running={r.get("old")} /><RunningBalanceText running={r.get("new")} /></>);
    expect(screen.getByTestId("before-opening").textContent).toBe("Before opening");
    expect(screen.getByTestId("running-balance").textContent).toMatch(/1,02,000/);
  });

  it("shows the old opening after a change from a statement, and an accepted difference", () => {
    state.history = [{
      id: "h1", old_balance: 100000, old_date: "2026-04-01", new_balance: 60000, new_date: "2025-04-01",
      source: "statement", difference: -10000, accepted_difference: true, changed_at: "2026-11-05T07:00:00Z",
    }];
    render(<OpeningHistoryNote accountId="acc-1" />);
    const t = screen.getByTestId("opening-history").textContent ?? "";
    expect(t).toMatch(/Was ₹1,00,000 as of 1 Apr 2026/);
    expect(t).toMatch(/from a statement/);
    expect(t).toMatch(/owner accepted a ₹10,000 difference/);
  });

  it("never changed → nothing shown", () => {
    state.history = [];
    render(<OpeningHistoryNote accountId="acc-1" />);
    expect(screen.queryByTestId("opening-history")).toBeNull();
  });
});
