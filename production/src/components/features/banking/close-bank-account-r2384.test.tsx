// @vitest-environment jsdom
/* R-2384 — Banking → account menu → "Close account" (a broken FD at ₹0), and Add/Edit account
   for a Fixed deposit without last-4 / IFSC. Pardeep, 2 Nov 2026: "jo FD break ho chuki ho unhe
   archive me rakho". */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BankAccountRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({ close: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/queries/bank", () => ({
  useCloseBankAccount: () => ({ mutateAsync: state.close, isPending: false }),
  useCreateBankAccount: () => ({ mutateAsync: state.create, isPending: false }),
  useUpdateBankAccount: () => ({ mutateAsync: state.update, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("@/lib/dates/ist", async (orig) => ({
  ...(await orig<typeof import("@/lib/dates/ist")>()),
  istToday: () => "2026-11-02",
}));

Object.assign(Element.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  setPointerCapture: () => {},
  scrollIntoView: () => {},
});

import { CloseBankAccountDialog } from "./close-bank-account-dialog";
import { AddBankAccountForm } from "./add-bank-account-form";

const fd = (over: Partial<BankAccountRow> = {}): BankAccountRow => ({
  id: "fd-1", tenant_id: "t", name: "FD 1234 (broken)", bank_name: "HDFC Bank",
  account_number_last4: null, ifsc: null, account_type: "fixed_deposit",
  opening_balance: 100000, opening_balance_date: "2026-04-01", is_active: true,
  notes: null, created_at: "", updated_at: "", current_balance: 0, ...over,
});

beforeEach(() => {
  state.close.mockReset(); state.close.mockResolvedValue(undefined);
  state.update.mockReset(); state.update.mockResolvedValue({});
  state.create.mockReset(); state.create.mockResolvedValue({});
});
afterEach(() => cleanup());

describe("R-2384 Close account dialog", () => {
  it("at ₹0: asks the closed date (today) + an optional note, and closes", async () => {
    const onOpenChange = vi.fn();
    render(<CloseBankAccountDialog open onOpenChange={onOpenChange} account={fd()} />);
    expect(screen.getByText(/Close “FD 1234 \(broken\)”\?/)).toBeTruthy();
    const date = screen.getByLabelText(/Closed on/) as HTMLInputElement;
    expect(date.value).toBe("2026-11-02");
    fireEvent.change(date, { target: { value: "2026-04-10" } });
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: "FD broken, money to HDFC Current" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close account" })); });
    expect(state.close).toHaveBeenCalledWith({ id: "fd-1", closedOn: "2026-04-10", note: "FD broken, money to HDFC Current" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("with a balance: says why, no Close button, nothing saved", () => {
    render(<CloseBankAccountDialog open onOpenChange={() => {}} account={fd({ current_balance: 50000 })} />);
    expect(screen.getByRole("alert").textContent).toBe(
      "Balance is ₹50,000. An account can be closed only at ₹0 — move the money out first with Own transfer, then close it.",
    );
    expect(screen.queryByRole("button", { name: "Close account" })).toBeNull();
    expect(screen.queryByLabelText(/Closed on/)).toBeNull();
    expect(state.close).not.toHaveBeenCalled();
  });
});

describe("R-2389 Close account: the server's refusal shows in the dialog", () => {
  it("staging 403 (permission denied for function ist_today): stays open and shows the server's words", async () => {
    const onOpenChange = vi.fn();
    state.close.mockRejectedValue({ code: "42501", message: "permission denied for function ist_today" });
    render(<CloseBankAccountDialog open onOpenChange={onOpenChange} account={fd()} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close account" })); });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Could not close: You don't have access to this.");
    expect(alert.textContent).toContain("Server said: permission denied for function ist_today");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("a guard's own sentence is shown as written (no 'Server said' twice)", async () => {
    state.close.mockRejectedValue({ message: "The closed date cannot be before the last line on this account (10 Apr 2026)" });
    render(<CloseBankAccountDialog open onOpenChange={() => {}} account={fd()} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close account" })); });
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not close: The closed date cannot be before the last line on this account (10 Apr 2026)",
    );
  });
});

describe("R-2384 Fixed deposit: last-4 and IFSC optional", () => {
  it("an FD saves with no last-4 and no IFSC", async () => {
    render(<AddBankAccountForm open onOpenChange={() => {}} account={fd()} />);
    expect(screen.getByText("Last 4 digits (optional)")).toBeTruthy();
    expect(screen.getByText("IFSC (optional)")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save changes" })); });
    expect(state.update).toHaveBeenCalledTimes(1);
    const patch = state.update.mock.calls[0][0].patch;
    expect(patch.account_type).toBe("fixed_deposit");
    expect(patch.account_number_last4).toBeNull();
    expect(patch.ifsc).toBeNull();
  });

  it("an FD with a wrong IFSC typed is still checked", async () => {
    render(<AddBankAccountForm open onOpenChange={() => {}} account={fd({ ifsc: "BAD" })} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save changes" })); });
    expect(state.update).not.toHaveBeenCalled();
  });

  it("a current account still needs last-4 and IFSC", async () => {
    render(<AddBankAccountForm open onOpenChange={() => {}} account={fd({ account_type: "current", name: "HDFC Current" })} />);
    expect(screen.queryByText("IFSC (optional)")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save changes" })); });
    expect(state.update).not.toHaveBeenCalled();
    expect(screen.getByText("Last 4 digits only")).toBeTruthy();
    expect(screen.getByText(/Add the IFSC/)).toBeTruthy();
  });
});
