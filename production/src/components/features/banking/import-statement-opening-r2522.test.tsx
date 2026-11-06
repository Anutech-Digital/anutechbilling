// @vitest-environment jsdom
/* R-2522 — the import dialog on the real staging case (HDFC 4523, FY 25-26 statement, 6 Nov 2026).
   - SUBHVISION NEFT ₹37,170 (txn 01/04/26, value 31/03/26) is inside the bank's 31 Mar closing =
     the account's 1 Apr 2026 opening ₹9,03,552: the check MATCHES, no override.
   - "As of" defaults to the statement's FIRST date (it proposed 1 Apr 2026 before).
   - Clearing / typing the date never makes the opening box disappear.
   - Lines out of order inside one day: an info note, not a "does not follow" warning.
   - 3,665 lines: the preview shows a page of 100 rows (with their dropdowns), Previous / Next.
   - A hand-entered line between the dates is counted (as the database counts it) and warned
     about — the real "EMI 1 Thar Roxx" ₹27,764 next to the bank's EMI ₹30,183.
   - The owner's "set it anyway" needs a reason, which travels with the import. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  importSpy: vi.fn(),
  account: { id: "acc-1", opening_balance: 903552, opening_balance_date: "2026-04-01", account_type: "current" },
  windowLines: [] as unknown[],
}));

vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/queries/txn-category-rules", async (orig) => ({
  ...(await orig<object>()),
  useTxnCategoryRules: () => ({ data: [] }),
  useCreateTxnCategoryRule: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/bank", async (orig) => ({
  ...(await orig<object>()),
  useBankAccount: () => ({ data: state.account }),
  useExistingTxnKeys: () => ({ data: { bal: new Map(), prefix: new Map(), prefixNoBal: new Map() } }),
  useHasBankLinesFrom: () => ({ data: true }),
  useBankLinesBetween: () => ({ data: state.windowLines }),
  useImportBankTransactions: () => ({ mutateAsync: state.importSpy, isPending: false }),
  useUpdateBankAccount: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { ImportStatementDialog, PREVIEW_PAGE_SIZE } from "./import-statement-dialog";
import { SUBHVISION_CSV } from "@/lib/banking/opening-move-r2522.fixture";

async function paste(csv: string) {
  render(<ImportStatementDialog open onOpenChange={() => {}} accountId="acc-1" />);
  const box = document.getElementById("import-statement-or-paste-csv-text") as HTMLTextAreaElement;
  await act(async () => { fireEvent.change(box, { target: { value: csv } }); });
}
const openingTick = () => screen.getByRole("checkbox", { name: /Set opening balance from this statement/ }) as HTMLInputElement;
const tick = async () => { await act(async () => { fireEvent.click(openingTick()); }); };
const dateBox = () => document.getElementById("opening-date") as HTMLInputElement;
const importButton = () => screen.getByRole("button", { name: /Import \d+ row|Set opening balance$/ }) as HTMLButtonElement;

beforeEach(() => {
  state.importSpy.mockReset().mockResolvedValue({ inserted: 5, duplicates: 0 });
  state.account = { id: "acc-1", opening_balance: 903552, opening_balance_date: "2026-04-01", account_type: "current" };
  state.windowLines = [];
});
afterEach(() => cleanup());

describe("R-2522 import dialog — the FY 25-26 HDFC statement", () => {
  it("As of = the statement's first date; SUBHVISION matches the opening; value date sent", async () => {
    await paste(SUBHVISION_CSV);
    expect(dateBox().value).toBe("2025-04-10");
    await tick();
    const check = screen.getByTestId("opening-move-check");
    expect(check.textContent).toMatch(/₹9,03,552.*₹9,03,552/);
    expect(check.textContent).toMatch(/matches the current opening/i);
    expect(check.textContent).toMatch(/Includes 1 new line dated 1 Apr 2026/);
    expect(check.textContent).toMatch(/₹2 less \(paise rounding/);
    expect(importButton().disabled).toBe(false);
    await act(async () => { fireEvent.click(importButton()); });
    const call = state.importSpy.mock.calls[0][0];
    expect(call.opening).toEqual({ amount: 2020919, date: "2025-04-10", acceptDifference: false });
    expect(call.rows.find((r: { reference: string }) => r.reference === "IN42609055612841")).toMatchObject({
      txn_date: "2026-04-01", value_date: "2026-03-31", credit: 37170,
    });
  });

  it("clearing the date (typing) keeps the opening box, checkbox and date field", async () => {
    await paste(SUBHVISION_CSV);
    await act(async () => { fireEvent.change(dateBox(), { target: { value: "" } }); });
    expect(screen.getByTestId("opening-box")).toBeTruthy();
    expect(dateBox()).toBeTruthy();
    expect(openingTick().disabled).toBe(true);
    await act(async () => { fireEvent.change(dateBox(), { target: { value: "2025-04-01" } }); });
    expect(openingTick().disabled).toBe(false);
  });

  it("lines out of order inside one day: an info note, not a warning", async () => {
    await paste([
      "Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance",
      "20/11/2025,IN,,1000,2000",
      "21/11/2025,FD REDEMPTION 2,,700,3000",
      "21/11/2025,FD REDEMPTION 1,,300,2300",
      "22/11/2025,FEE,100,,2900",
    ].join("\n"));
    expect(screen.getByTestId("out-of-order-note").textContent).toMatch(/printed out of order within the day \(21 Nov 2025\)/);
    expect(screen.queryByText(/does not follow from the line before/)).toBeNull();
  });

  it("a long statement shows one page of rows at a time", async () => {
    const lines = ["Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance"];
    let bal = 100000;
    for (let i = 0; i < 250; i++) { bal -= 10; lines.push("01/05/2026,FEE " + i + ",10,," + bal); }
    await paste(lines.join("\n"));
    expect(screen.getAllByRole("combobox", { name: /Category for/ })).toHaveLength(PREVIEW_PAGE_SIZE);
    expect(screen.getByTestId("preview-pager").textContent).toMatch(/Rows 1–100 of 250/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next" })); });
    expect(screen.getByTestId("preview-pager").textContent).toMatch(/Rows 101–200 of 250/);
    expect(screen.getByRole("combobox", { name: "Category for FEE 100" })).toBeTruthy();
  });

  it("a hand-entered line between the dates counts and is warned about; set anyway needs a reason", async () => {
    state.account = { id: "acc-1", opening_balance: 10000, opening_balance_date: "2026-04-01", account_type: "current" };
    state.windowLines = [{ id: "m1", txn_date: "2026-03-03", debit: 27764, credit: 0, balance_after: null, source: "manual", description: "EMI 1 Thar Roxx" }];
    await paste([
      "Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance",
      "05/03/2026,EMI THAR,30183,,10000",
    ].join("\n"));
    await act(async () => { fireEvent.change(dateBox(), { target: { value: "2026-03-01" } }); });
    await tick();
    const check = screen.getByTestId("opening-move-check");
    expect(check.textContent).toMatch(/differs by −₹27,764/);
    expect(screen.getByTestId("manual-in-window").textContent).toMatch(/3 Mar 2026 · ₹27,764 out · EMI 1 Thar Roxx/);
    await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: /set it anyway/ })); });
    expect(importButton().disabled).toBe(true);
    await act(async () => { fireEvent.change(screen.getByLabelText(/Why do the figures differ/), { target: { value: "EMI entered by hand twice" } }); });
    expect(importButton().disabled).toBe(false);
    await act(async () => { fireEvent.click(importButton()); });
    expect(state.importSpy.mock.calls[0][0].opening).toMatchObject({ acceptDifference: true, reason: "EMI entered by hand twice" });
  });
});
