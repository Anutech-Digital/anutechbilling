// @vitest-environment jsdom
/* R-2384 — Banking list shows ACTIVE accounts; closed (archived) ones sit behind "Closed (N)",
   greyed, with Reopen. Totals use active accounts only. Staging 2 Nov 2026: five FDs broken on
   10 Apr at ₹0 cluttered the list and could not be archived (menu had View / Edit / Delete only). */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { BankAccountRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({
  accounts: [] as unknown[],
  reopen: vi.fn(),
  closeFor: null as null | { name: string },
  transferAccounts: [] as Array<{ id: string }>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: state.accounts, isLoading: false, isError: false, refetch: vi.fn() }),
  useReopenBankAccount: () => ({ mutate: state.reopen, isPending: false }),
}));
vi.mock("@/components/features/banking/add-bank-account-form", () => ({ AddBankAccountForm: () => null }));
vi.mock("@/components/features/banking/delete-bank-account-dialog", () => ({ DeleteBankAccountDialog: () => null }));
vi.mock("@/components/features/banking/close-bank-account-dialog", () => ({
  CloseBankAccountDialog: ({ account }: { account: { name: string } | null }) => {
    state.closeFor = account;
    return account ? <div data-testid="close-dialog">{account.name}</div> : null;
  },
}));
vi.mock("@/components/features/banking/transfer-dialog", () => ({
  TransferDialog: ({ accounts }: { accounts: Array<{ id: string }> }) => { state.transferAccounts = accounts; return null; },
}));

import BankingPage from "./page";

const acc = (over: Partial<BankAccountRow>): BankAccountRow => ({
  id: "x", tenant_id: "t", name: "x", bank_name: "HDFC Bank", account_number_last4: "1234", ifsc: "HDFC0001234",
  account_type: "current", opening_balance: 0, opening_balance_date: "2026-04-01", is_active: true,
  notes: null, created_at: "", updated_at: "", current_balance: 0, ...over,
});

beforeEach(() => {
  state.reopen.mockReset();
  state.closeFor = null;
  state.accounts = [
    acc({ id: "cur", name: "HDFC Current", current_balance: 250000 }),
    acc({ id: "fd-live", name: "FD 5678", account_type: "fixed_deposit", current_balance: 50000 }),
    acc({ id: "pc", name: "Petty Cash", bank_name: "Cash in hand", account_type: "cash", current_balance: 0, is_default_petty_cash: true }),
    acc({ id: "fd-1", name: "FD 1111 (broken)", account_type: "fixed_deposit", is_active: false, closed_on: "2026-04-10", closed_note: "FD broken, money to HDFC Current" }),
    acc({ id: "fd-2", name: "FD 2222 (broken)", account_type: "fixed_deposit", is_active: false, closed_on: "2026-04-10" }),
  ];
});
afterEach(() => cleanup());

function openMenu(card: HTMLElement) {
  const trigger = within(card).getByRole("button", { name: "Account actions" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.keyDown(trigger, { key: "Enter" });
}
const cardOf = (name: string) => screen.getByText(name).closest("div.relative") as HTMLElement;

describe("R-2384 Banking: closed accounts", () => {
  it("lists active accounts only; totals and count use active ones; a Closed (2) toggle", () => {
    render(<BankingPage />);
    expect(screen.getByText("HDFC Current")).toBeTruthy();
    expect(screen.queryByText("FD 1111 (broken)")).toBeNull();
    expect(screen.getByText("₹3.0L")).toBeTruthy(); // 2,50,000 + 50,000 + 0
    expect(screen.getByText("Active · 2 closed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Closed (2)" }).getAttribute("aria-expanded")).toBe("false");
    // Own transfer / Move money is offered between ACTIVE accounts only
    expect(state.transferAccounts.map((a) => a.id)).toEqual(["cur", "fd-live", "pc"]);
  });

  it("the toggle shows the closed accounts greyed, with the closed date and note, and Reopen", async () => {
    render(<BankingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Closed (2)" }));
    const card = cardOf("FD 1111 (broken)");
    expect(card.className).toMatch(/opacity-75/);
    expect(within(card).getByText("Closed 10 Apr 2026")).toBeTruthy();
    expect(within(card).getByText("FD broken, money to HDFC Current")).toBeTruthy();
    await act(async () => { openMenu(card); });
    expect(screen.queryByRole("menuitem", { name: /Close account/ })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /Reopen account/ })); });
    expect(state.reopen).toHaveBeenCalledWith("fd-1");
  });

  it("an active account's menu has Close account, which opens the close dialog for it", async () => {
    render(<BankingPage />);
    await act(async () => { openMenu(cardOf("FD 5678")); });
    expect(screen.queryByRole("menuitem", { name: /Reopen account/ })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /Close account/ })); });
    expect(screen.getByTestId("close-dialog").textContent).toBe("FD 5678");
  });

  it("no closed accounts → no toggle", () => {
    state.accounts = (state.accounts as BankAccountRow[]).filter((a) => a.is_active);
    render(<BankingPage />);
    expect(screen.queryByRole("button", { name: /^Closed \(/ })).toBeNull();
    expect(screen.getByText("Active")).toBeTruthy();
  });
});
