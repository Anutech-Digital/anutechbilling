// @vitest-environment jsdom
/**
 * R-2606 — "Settle ₹X as round-off" asks before it books: names the ledger and the real bank line
 * (from the server's preview), says what happens to the part and the next part, sends the amount
 * the owner saw, and cannot be pressed twice or without a bank line.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SettleShortDialog } from "./settle-short-dialog";

afterEach(cleanup);

const PREVIEW = { amount: 60, bankLine: { credit: 95933, txnDate: "2026-11-03" } };

function setup(over: Partial<React.ComponentProps<typeof SettleShortDialog>> = {}) {
  const onConfirm = vi.fn();
  render(
    <SettleShortDialog
      open onOpenChange={() => {}}
      rowAmount={60} partIndex={1} partCount={4}
      preview={PREVIEW}
      pending={false} error={null} onConfirm={onConfirm}
      {...over}
    />,
  );
  return onConfirm;
}
const settleBtn = () => screen.getByRole("button", { name: /^settle ₹/i }) as HTMLButtonElement;

describe("SettleShortDialog (R-2606)", () => {
  it("names the ledger, the bank line and what happens next", () => {
    setup();
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Bank Charges · Settlement short of receipt/);
    expect(text).toMatch(/₹95,933 credited on 3 Nov 2026/);
    expect(text).toMatch(/Part 1 of 4/);
    expect(text).toMatch(/next part/i);
    expect(text).toMatch(/small difference \(round-off\)/);
    expect(text).not.toMatch(/as bank charge/i);
  });

  it("confirms with the typed note (or null) and the amount shown", () => {
    const onConfirm = setup();
    fireEvent.click(settleBtn());
    expect(onConfirm).toHaveBeenCalledWith(null, 60);
    cleanup();
    const on2 = setup();
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: " NEFT short " } });
    fireEvent.click(settleBtn());
    expect(on2).toHaveBeenCalledWith("NEFT short", 60);
  });

  it("the server's figure wins over the row's", () => {
    const onConfirm = setup({ rowAmount: 60, preview: { amount: 61, bankLine: PREVIEW.bankLine } });
    expect(settleBtn().textContent).toMatch(/Settle ₹61/);
    fireEvent.click(settleBtn());
    expect(onConfirm).toHaveBeenCalledWith(null, 61);
  });

  it("disables the button while it is saving (no double booking)", () => {
    const onConfirm = setup({ pending: true });
    expect(settleBtn().disabled).toBe(true);
    fireEvent.click(settleBtn());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("still reading → 'Checking…', no Settle", () => {
    setup({ preview: undefined });
    expect(document.body.textContent).toMatch(/Checking…/);
    expect(settleBtn().disabled).toBe(true);
  });

  it("receipt not on a bank line → says where to match it, no Settle", () => {
    setup({ preview: { amount: 60, bankLine: null } });
    expect(document.body.textContent).toMatch(/not matched to a bank line yet — match it on Banking → Reconcile/);
    expect(settleBtn().disabled).toBe(true);
  });

  it("shows the server's refusal in the dialog", () => {
    setup({ error: "Only a small difference (up to 1% of the part, max ₹500) can be settled here." });
    expect(screen.getByRole("alert").textContent).toMatch(/Only a small difference/);
  });
});
