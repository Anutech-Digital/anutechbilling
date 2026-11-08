// @vitest-environment jsdom
/**
 * R-2606 — "Settle ₹X as round-off" asks before it books: names the ledger and the bank line,
 * says what happens to the part and the next part, and cannot be pressed twice.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SettleShortDialog } from "./settle-short-dialog";

afterEach(cleanup);

function setup(over: Partial<React.ComponentProps<typeof SettleShortDialog>> = {}) {
  const onConfirm = vi.fn();
  render(
    <SettleShortDialog
      open onOpenChange={() => {}}
      amount={60} partIndex={1} partCount={4}
      bankLine={{ amount: 95933, on: "04 Nov 2026" }}
      pending={false} error={null} onConfirm={onConfirm}
      {...over}
    />,
  );
  return onConfirm;
}

describe("SettleShortDialog (R-2606)", () => {
  it("names the ledger, the bank line and what happens next", () => {
    setup();
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Bank Charges · Settlement short of receipt/);
    expect(text).toMatch(/₹95,933/);
    expect(text).toMatch(/04 Nov 2026/);
    expect(text).toMatch(/Part 1 of 4/);
    expect(text).toMatch(/next part/i);
    expect(text).toMatch(/small difference \(round-off\)/);
    expect(text).not.toMatch(/as bank charge/i);
  });

  it("confirms with the typed note (or null)", () => {
    const onConfirm = setup();
    fireEvent.click(screen.getByRole("button", { name: /settle ₹60/i }));
    expect(onConfirm).toHaveBeenCalledWith(null);
    cleanup();
    const on2 = setup();
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: " NEFT short " } });
    fireEvent.click(screen.getByRole("button", { name: /settle ₹60/i }));
    expect(on2).toHaveBeenCalledWith("NEFT short");
  });

  it("disables the button while it is saving (no double booking)", () => {
    const onConfirm = setup({ pending: true });
    const btn = screen.getByRole("button", { name: /settle ₹60/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows the server's refusal in the dialog", () => {
    setup({ error: "Match this receipt to its bank line first (Banking → Reconcile) — then settle the ₹60 difference." });
    expect(screen.getByRole("alert").textContent).toMatch(/Match this receipt to its bank line first/);
  });

  it("without a known bank line it still names the ledger", () => {
    setup({ bankLine: null });
    expect(document.body.textContent).toMatch(/Bank Charges · Settlement short of receipt/);
    expect(document.body.textContent).toMatch(/bank line of the last receipt/);
  });
});
