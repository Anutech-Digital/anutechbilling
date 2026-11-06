// @vitest-environment jsdom
/* R-2497 — the import dialog never silently overwrites an account's opening balance.
   Owner example (a company's current account): opening ₹1,00,000 as of 1 Apr 2026 (the
   account already has FY 26-27 lines). The FY 25-26 statement starts at ₹70,000 on 1 Apr 2025.
   - Opening tick OFF: the lines before 1 Apr 2026 are said to be NOT counted in the balance.
   - Tick ON, date 1 Apr 2025: the dialog shows the statement's balance at the start of 1 Apr
     2026 next to the old opening; Import sends the lines AND the opening in one call (the
     database moves them in one transaction, set_bank_opening_from_statement's check), never a
     plain account update.
   - Statement does not agree: the difference is shown, Import waits until the OWNER ticks
     "The figures differ — set it anyway". */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  role: "owner" as string,
  importSpy: vi.fn(),
  updateSpy: vi.fn(),
  hasCountedLines: true,
  windowLines: [] as unknown[],
}));

vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: state.role } }) }));
vi.mock("@/lib/queries/txn-category-rules", async (orig) => ({
  ...(await orig<object>()),
  useTxnCategoryRules: () => ({ data: [] }),
  useCreateTxnCategoryRule: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/bank", async (orig) => ({
  ...(await orig<object>()),
  useBankAccount: () => ({
    data: { id: "acc-1", opening_balance: 100000, opening_balance_date: "2026-04-01", account_type: "current" },
  }),
  useExistingTxnKeys: () => ({ data: { bal: new Map(), prefix: new Map(), prefixNoBal: new Map() } }),
  // the account already has a FY 26-27 line counted under the 1 Apr 2026 opening — money to keep
  useHasBankLinesFrom: () => ({ data: state.hasCountedLines }),
  useBankLinesBetween: () => ({ data: state.windowLines }),
  useImportBankTransactions: () => ({ mutateAsync: state.importSpy, isPending: false }),
  useUpdateBankAccount: () => ({ mutateAsync: state.updateSpy, isPending: false }),
}));

import { ImportStatementDialog } from "./import-statement-dialog";

// FY 25-26: 70,000 at the start of 1 Apr 2025; +80,000; −50,000 → 1,00,000 at 31 Mar 2026.
const CSV = [
  "Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance",
  "15/04/2025,NEFT IN,,80000,150000",
  "01/10/2025,RENT,50000,,100000",
].join("\n");
const CSV_OFF = CSV.replace("150000", "140000").replace(",100000", ",90000");

async function paste(csv = CSV) {
  render(<ImportStatementDialog open onOpenChange={() => {}} accountId="acc-1" />);
  const box = document.getElementById("import-statement-or-paste-csv-text") as HTMLTextAreaElement;
  await act(async () => { fireEvent.change(box, { target: { value: csv } }); });
}
async function tickOpening(date = "2025-04-01") {
  await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: /Set opening balance from this statement/ })); });
  const d = document.getElementById("opening-date") as HTMLInputElement;
  await act(async () => { fireEvent.change(d, { target: { value: date } }); });
}
const importButton = () => screen.getByRole("button", { name: /Import \d+ row|Set opening balance$/ });

beforeEach(() => {
  state.role = "owner";
  state.hasCountedLines = true;
  state.importSpy.mockReset().mockResolvedValue({ inserted: 2, duplicates: 0 });
  state.updateSpy.mockReset().mockResolvedValue({});
});
afterEach(() => cleanup());

describe("R-2497 import dialog — opening balance", () => {
  it("tick off: lines before the account's opening date are said to be not counted", async () => {
    await paste();
    expect(screen.getByTestId("lines-before-opening").textContent).toMatch(
      /2 lines are dated before this account's opening date \((1 Apr 2026)\).*not be counted/);
  });

  it("tick on, earlier date, statement agrees: shows the match; lines + opening go in one call", async () => {
    await paste();
    await tickOpening();
    const check = screen.getByTestId("opening-move-check");
    expect(check.textContent).toMatch(/start of (1 Apr 2026).*₹1,00,000/);
    expect(check.textContent).toMatch(/matches the current opening/i);
    await act(async () => { fireEvent.click(importButton()); });
    expect(state.importSpy).toHaveBeenCalledTimes(1);
    expect(state.importSpy).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "acc-1",
      opening: { amount: 70000, date: "2025-04-01", acceptDifference: false },
    }));
    expect(state.importSpy.mock.calls[0][0].rows).toHaveLength(2);
    expect(state.updateSpy).not.toHaveBeenCalled();
  });

  it("statement does not agree: the difference is shown and Import waits for the owner's tick", async () => {
    // the statement starts at 60,000 → 90,000 at the start of 1 Apr 2026 (not 1,00,000)
    await paste(CSV_OFF);
    await tickOpening();
    const check = screen.getByTestId("opening-move-check");
    expect(check.textContent).toMatch(/₹90,000/);
    expect(check.textContent).toMatch(/differs by −₹10,000/);
    expect((importButton() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: /The figures differ — set it anyway/ })); });
    // R-2522: the owner must say why — Import waits for the reason
    expect((importButton() as HTMLButtonElement).disabled).toBe(true);
    const reason = screen.getByLabelText(/Why do the figures differ/) as HTMLTextAreaElement;
    await act(async () => { fireEvent.change(reason, { target: { value: "Passbook checked" } }); });
    expect((importButton() as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(importButton()); });
    expect(state.importSpy).toHaveBeenCalledWith(expect.objectContaining({
      opening: { amount: 60000, date: "2025-04-01", acceptDifference: true, reason: "Passbook checked" },
    }));
  });

  it("an accountant sees the difference but cannot accept it — told to ask the owner", async () => {
    state.role = "accountant";
    await paste(CSV_OFF);
    await tickOpening();
    expect(screen.queryByRole("checkbox", { name: /The figures differ — set it anyway/ })).toBeNull();
    expect(screen.getByTestId("opening-move-check").textContent).toMatch(/Only the owner can accept/);
    expect((importButton() as HTMLButtonElement).disabled).toBe(true);
    expect(state.importSpy).not.toHaveBeenCalled();
  });

  it("opening 0 and no line counted under it: nothing to keep, no check box, Import goes ahead", async () => {
    state.hasCountedLines = false;
    // a fresh account: the mock opening is 1,00,000, so make it a zero-opening account for this case
    const bank = await import("@/lib/queries/bank");
    const spy = vi.spyOn(bank, "useBankAccount").mockReturnValue({
      data: { id: "acc-1", opening_balance: 0, opening_balance_date: "2026-11-01", account_type: "current" },
    } as unknown as ReturnType<typeof bank.useBankAccount>);
    await paste(CSV_OFF);
    await tickOpening();
    expect(screen.queryByTestId("opening-move-check")).toBeNull();
    expect((importButton() as HTMLButtonElement).disabled).toBe(false);
    spy.mockRestore();
  });
});
