/* R-2384 — close / archive a bank account (a broken FD at ₹0). Pure rules behind the menu,
   the "Closed (N)" toggle, the pickers and the FD warning on "Mark reconciled manually". */
import { describe, expect, it } from "vitest";
import { closeAccountProblem, fdMoveWarning, FD_MOVE_WARNING, pickableAccounts, splitByStatus } from "./account-close";

const fd = { is_active: true, account_type: "fixed_deposit", opening_balance: 100000 };

describe("R-2384 closeAccountProblem", () => {
  it("a broken FD at ₹0 can be closed", () => {
    expect(closeAccountProblem({ ...fd, current_balance: 0 })).toBeNull();
  });
  it("an FD still holding money cannot — the reason names the balance and the next step", () => {
    expect(closeAccountProblem({ ...fd, current_balance: 50000 })).toBe(
      "Balance is ₹50,000. An account can be closed only at ₹0 — move the money out first with Own transfer, then close it.",
    );
  });
  it("falls back to the opening balance when the live balance is not loaded", () => {
    expect(closeAccountProblem({ ...fd })).toMatch(/^Balance is ₹1,00,000\./);
  });
  it("a card shows what is owed", () => {
    expect(closeAccountProblem({ is_active: true, account_type: "credit_card", opening_balance: 0, current_balance: -2500 })).toMatch(/^Balance is ₹2,500 owed\./);
  });
  it("the default Petty Cash and an already-closed account cannot be closed", () => {
    expect(closeAccountProblem({ is_active: true, account_type: "cash", opening_balance: 0, current_balance: 0, is_default_petty_cash: true })).toMatch(/Petty Cash cannot be closed/);
    expect(closeAccountProblem({ ...fd, is_active: false, current_balance: 0 })).toBe("This account is already closed.");
  });
});

describe("R-2384 splitByStatus / pickableAccounts", () => {
  const rows = [
    { id: "a", is_active: true }, { id: "b", is_active: false }, { id: "c", is_active: true },
  ];
  it("active first-class, closed behind the toggle (order kept)", () => {
    const { active, closed } = splitByStatus(rows);
    expect(active.map((r) => r.id)).toEqual(["a", "c"]);
    expect(closed.map((r) => r.id)).toEqual(["b"]);
    expect(splitByStatus(null)).toEqual({ active: [], closed: [] });
  });
  it("pickers offer active accounts only, plus the closed one already saved on the record", () => {
    expect(pickableAccounts(rows).map((r) => r.id)).toEqual(["a", "c"]);
    expect(pickableAccounts(rows, "b").map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(pickableAccounts(rows, "").map((r) => r.id)).toEqual(["a", "c"]);
  });
});

describe("R-2384 fdMoveWarning", () => {
  it.each([
    "FD PREMAT CLOSURE 1234",
    "AUTO SWEEP TO FD",
    "SWEEP IN 50000",
    "TRF FROM FD NO.50300012345",
    "FDR/000123 REDEMPTION",
    "REDEEM TD 778899",
    "Pre-mature closure of fixed deposit",
    "FD A/C 4455 INT",
  ])("warns on %s", (d) => {
    expect(fdMoveWarning(d)).toBe(FD_MOVE_WARNING);
  });
  it.each([
    "NEFT CR ANUTECH DIGITAL PVT LTD 1234",
    "UPI/PAYTM/FOOD",
    "TDS PAID 2026",
    "",
  ])("stays quiet on %s", (d) => {
    expect(fdMoveWarning(d)).toBeNull();
  });
  it("the warning text is the owner's", () => {
    expect(FD_MOVE_WARNING).toBe("This moves money to/from an FD — use Own transfer so the FD balance changes.");
  });
});
