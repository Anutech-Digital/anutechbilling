// @vitest-environment jsdom
/* R-2508 — a minus in the Withdrawal column with no balance to prove what it means is never
   guessed: the line is marked "Check the sign" in the preview and Import waits until the owner
   says money in (a reversal) or money out. Made-up statement in HDFC's column layout. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({ importSpy: vi.fn() }));

vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/queries/txn-category-rules", async (orig) => ({
  ...(await orig<object>()),
  useTxnCategoryRules: () => ({ data: [] }),
  useCreateTxnCategoryRule: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/bank", async (orig) => ({
  ...(await orig<object>()),
  useBankAccount: () => ({ data: { id: "acc-1", opening_balance: 0, opening_balance_date: "2025-04-01", account_type: "current" } }),
  useExistingTxnKeys: () => ({ data: { bal: new Map(), prefix: new Map(), prefixNoBal: new Map() } }),
  useHasBankLinesFrom: () => ({ data: false }),
  useImportBankTransactions: () => ({ mutateAsync: state.importSpy, isPending: false }),
  useUpdateBankAccount: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { ImportStatementDialog } from "./import-statement-dialog";

const CSV = [
  "Date,Narration,Withdrawal Amt.,Deposit Amt.",
  "09/09/2025,NEFT CR-DEMO,,5000.00",
  "10/09/2025,DEMO RENT,-20000.00,",
].join("\n");

async function paste(csv = CSV) {
  render(<ImportStatementDialog open onOpenChange={() => {}} accountId="acc-1" />);
  const box = document.getElementById("import-statement-or-paste-csv-text") as HTMLTextAreaElement;
  await act(async () => { fireEvent.change(box, { target: { value: csv } }); });
}
const importButton = () => screen.getByRole("button", { name: /Import \d+ row/ });

beforeEach(() => { state.importSpy.mockReset().mockResolvedValue({ inserted: 2, duplicates: 0 }); });
afterEach(() => cleanup());

describe("R-2508 import dialog — check the sign", () => {
  it("the line is listed under 'Check the sign' and Import is blocked", async () => {
    await paste();
    const box = screen.getByTestId("sign-check");
    expect(box.textContent).toMatch(/Check the sign/);
    expect(box.textContent).toMatch(/DEMO RENT/);
    expect((importButton() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(importButton()); });
    expect(state.importSpy).not.toHaveBeenCalled();
  });

  it("owner picks Money out → Import opens and sends a 20,000 withdrawal", async () => {
    await paste();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Money out/ })); });
    expect(screen.queryByTestId("sign-check")).toBeNull();
    expect((importButton() as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(importButton()); });
    const rows = state.importSpy.mock.calls[0][0].rows as Array<{ description: string; debit: number; credit: number }>;
    expect(rows.find((r) => r.description === "DEMO RENT")).toMatchObject({ debit: 20000, credit: 0 });
  });

  it("owner picks Money in → sent as a 20,000 credit marked (reversal)", async () => {
    await paste();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Money in/ })); });
    await act(async () => { fireEvent.click(importButton()); });
    const rows = state.importSpy.mock.calls[0][0].rows as Array<{ description: string; debit: number; credit: number }>;
    expect(rows.find((r) => r.description.startsWith("DEMO RENT"))).toMatchObject({ debit: 0, credit: 20000, description: "DEMO RENT (reversal)" });
  });
});

describe("R-2508 review — Deposit column, and other choices survive", () => {
  it("a Deposit-column minus: Money out is the reversal, Money in keeps it as a deposit", async () => {
    await paste(["Date,Narration,Withdrawal Amt.,Deposit Amt.", "09/09/2025,NEFT CR-DEMO,,5000.00", "10/09/2025,DEMO REFUND,,-750.00"].join("\n"));
    expect(screen.getByRole("button", { name: "Money out (reversal)" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Money in" })); });
    await act(async () => { fireEvent.click(importButton()); });
    const rows = state.importSpy.mock.calls[0][0].rows as Array<{ description: string; debit: number; credit: number }>;
    expect(rows.find((r) => r.description === "DEMO REFUND")).toMatchObject({ debit: 0, credit: 750 });
  });

  it("answering the sign keeps a category the owner already picked", async () => {
    await paste();
    const pick = screen.getByLabelText("Category for NEFT CR-DEMO") as HTMLSelectElement;
    const value = Array.from(pick.options).map((o) => o.value).find((v) => v !== "")!;
    await act(async () => { fireEvent.change(pick, { target: { value } }); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Money out/ })); });
    expect((screen.getByLabelText("Category for NEFT CR-DEMO") as HTMLSelectElement).value).toBe(value);
  });
});
