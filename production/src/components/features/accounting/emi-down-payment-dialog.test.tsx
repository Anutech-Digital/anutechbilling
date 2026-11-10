// @vitest-environment jsdom
/* R-2395 — "Down payment: paid from". Owner example (staging 3 Nov): Thar Roxx, ₹2,00,000 down on
   3 Feb 2026, posted on an FD that opened 29 Aug 2026; the owner paid it in cash himself. The dialog
   shows where it sits now, starts with nothing picked, cannot pick an account opened later, and
   one save sends Paid by owner (or the account) to the server. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const mutateAsync = vi.fn();
const setParts = vi.fn();
let lines: unknown[] = [];
let source: unknown = { kind: "account", accountId: "fd-1", imported: false, amount: 200000, date: "2026-02-03" };
let businessType = "proprietor";
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: [
    { id: "hdfc-1", name: "HDFC Current", is_active: true, account_type: "current", opening_balance_date: "2026-01-01" },
    { id: "fd-1", name: "HDFC FD 2107", is_active: true, account_type: "fixed_deposit", opening_balance_date: "2026-08-29" },
    { id: "cash-1", name: "Petty Cash", is_active: true, account_type: "cash", opening_balance_date: "2026-01-01" },
    { id: "cc-1", name: "HDFC Card", is_active: true, account_type: "credit_card", opening_balance_date: "2026-01-01" },
  ] }),
}));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: { businessType } }) }));
vi.mock("@/lib/queries/emi", () => ({
  useEmiDownPayment: () => ({ data: source, isLoading: false, isError: false }),
  useChangeEmiDownPaymentSource: () => ({ mutateAsync, isPending: false }),
  useDownPaymentLineCandidates: () => ({ data: lines, isLoading: false }),
  useSetEmiDownPaymentParts: () => ({ mutateAsync: setParts, isPending: false }),
}));

import { EmiDownPaymentDialog, rowsFromParts, splitPlan } from "./emi-down-payment-dialog";
import type { EmiPurchase } from "@/lib/queries/emi";

const thar = {
  id: "p-thar", name: "Thar Roxx", down_payment: 200000, processing_fee: 0, processing_fee_gst: 0,
  purchased_on: "2026-02-03", down_bank_txn_id: "t-down", down_account_id: "fd-1",
} as unknown as EmiPurchase;
const save = () => screen.getByRole("button", { name: "Save paid from" }) as HTMLButtonElement;

afterEach(cleanup);
beforeEach(() => {
  mutateAsync.mockReset(); mutateAsync.mockResolvedValue({});
  setParts.mockReset(); setParts.mockResolvedValue({ total: 200000, parts: [] });
  lines = [];
  source = { kind: "account", accountId: "fd-1", imported: false, amount: 200000, date: "2026-02-03" };
  businessType = "proprietor";
});

describe("R-2395 Down payment: paid from", () => {
  it("Thar: shows the FD now, nothing picked, the FD itself and the credit card not offered", () => {
    render(<EmiDownPaymentDialog purchase={thar} onClose={vi.fn()} />);
    expect(screen.getByTestId("down-now").textContent).toBe("HDFC FD 2107");
    expect(screen.getByText(/₹2,00,000 paid on/)).toBeTruthy();
    expect((screen.getByLabelText("Paid from") as HTMLSelectElement).value).toBe("");
    expect(save().disabled).toBe(true);
    expect(screen.queryByRole("option", { name: /HDFC FD 2107/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /HDFC Card/ })).toBeNull();
  });

  it("Thar: FD → Paid by owner, one save", async () => {
    const close = vi.fn();
    render(<EmiDownPaymentDialog purchase={thar} onClose={close} />);
    fireEvent.change(screen.getByLabelText("Paid from"), { target: { value: "__owner__" } });
    expect(screen.getByText(/capital goes up by ₹2,00,000/)).toBeTruthy();
    fireEvent.click(save());
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledWith({ purchaseId: "p-thar", accountId: null, paidByOwner: true, partner: null });
  });

  it("an account opened after the payment cannot be picked; Petty Cash can", async () => {
    source = { kind: "owner", amount: 200000, date: "2026-02-03", partner: null };
    render(<EmiDownPaymentDialog purchase={thar} onClose={vi.fn()} />);
    expect(screen.getByTestId("down-now").textContent).toContain("Paid by owner");
    expect((screen.getByRole("option", { name: /HDFC FD 2107 — opened/ }) as HTMLOptionElement).disabled).toBe(true);
    expect(screen.queryByRole("option", { name: /Paid by owner/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Paid from"), { target: { value: "cash-1" } });
    fireEvent.click(save());
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ accountId: "cash-1", paidByOwner: false });
  });

  it("reconciled to a statement line: no change here, says why", () => {
    source = { kind: "account", accountId: "hdfc-1", imported: true, amount: 200000, date: "2026-02-03" };
    render(<EmiDownPaymentDialog purchase={thar} onClose={vi.fn()} />);
    expect(screen.getByText(/un-reconcile the line in Banking first/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save paid from" })).toBeNull();
  });

  it("Pvt Ltd: no Paid by owner option", () => {
    businessType = "pvt_ltd";
    render(<EmiDownPaymentDialog purchase={thar} onClose={vi.fn()} />);
    expect(screen.queryByRole("option", { name: /Paid by/ })).toBeNull();
  });

  it("partnership: Paid by partner needs the partner", () => {
    businessType = "partnership";
    render(<EmiDownPaymentDialog purchase={thar} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Paid from"), { target: { value: "__owner__" } });
    expect(save().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Which partner"), { target: { value: "Pardeep" } });
    expect(save().disabled).toBe(false);
  });
});

/* R-2523 — the real Thar case (staging 6 Nov): the ₹2,00,000 was paid as HDFC 4523 → Shiva Auto Cars
   ₹21,000 (2 Jan 2026) + ₹87,394 (30 Jan) + ₹19,700 (2 Feb) and ₹71,906 from Petty Cash. */
describe("R-2523 Down payment: split across sources", () => {
  const hdfcLines = [
    { id: "l1", bank_account_id: "hdfc-1", account_name: "HDFC Current", txn_date: "2026-01-02", description: "THAR ADVANCE", debit: 21000 },
    { id: "l2", bank_account_id: "hdfc-1", account_name: "HDFC Current", txn_date: "2026-01-30", description: "THAR PAYMENT", debit: 87394 },
    { id: "l3", bank_account_id: "hdfc-1", account_name: "HDFC Current", txn_date: "2026-02-02", description: "THAR PAYMENT", debit: 19700 },
  ];

  it("Thar: 3 HDFC statement lines + Petty Cash ₹71,906 in one save; must add up first", async () => {
    lines = hdfcLines;
    source = { kind: "account", accountId: "cash-1", imported: false, amount: 200000, date: "2026-02-03",
      parts: [{ kind: "account", lineId: "m1", accountId: "cash-1", imported: false, amount: 200000, date: "2026-02-03" }] };
    const close = vi.fn();
    render(<EmiDownPaymentDialog purchase={thar} onClose={close} />);
    fireEvent.click(screen.getByRole("button", { name: /Split across sources/ }));
    // Starts from what is recorded now: Petty Cash ₹2,00,000.
    expect((screen.getByLabelText("Part 1 paid from") as HTMLSelectElement).value).toBe("acc:cash-1");
    fireEvent.change(screen.getByLabelText("Part 1 amount"), { target: { value: "71906" } });
    expect(screen.getByTestId("down-split-total").textContent).toContain("₹1,28,094 left");
    for (const [i, id] of [[2, "l1"], [3, "l2"], [4, "l3"]] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Add a part" }));
      fireEvent.change(screen.getByLabelText(`Part ${i} paid from`), { target: { value: `line:${id}` } });
    }
    // A statement line already picked cannot be picked again in another part.
    expect((within(screen.getByLabelText("Part 3 paid from")).getByRole("option", { name: /21,000/ }) as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getByTestId("down-split-total").textContent).toContain("₹2,00,000 of ₹2,00,000 ✓");
    fireEvent.click(screen.getByRole("button", { name: "Save 4 parts" }));
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(setParts).toHaveBeenCalledWith({ purchaseId: "p-thar", parts: [
      { account_id: "cash-1", amount: 71906, date: "2026-02-03" },
      { bank_txn_id: "l1" }, { bank_txn_id: "l2" }, { bank_txn_id: "l3" },
    ] });
  });

  it("parts that do not add up cannot be saved", () => {
    lines = hdfcLines;
    render(<EmiDownPaymentDialog purchase={thar} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Split across sources/ }));
    fireEvent.change(screen.getByLabelText("Part 1 amount"), { target: { value: "70000" } });
    expect((screen.getByRole("button", { name: "Save 1 part" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("down-split-total").textContent).toContain("₹1,30,000 left");
  });

  it("already split: lists the parts and opens the split editor (one-source change is not offered)", () => {
    source = { kind: "split", amount: 200000, date: "2026-01-02", parts: [
      { kind: "account", lineId: "l1", accountId: "hdfc-1", imported: true, amount: 21000, date: "2026-01-02" },
      { kind: "account", lineId: "m1", accountId: "cash-1", imported: false, amount: 179000, date: "2026-02-03" },
    ] };
    render(<EmiDownPaymentDialog purchase={thar} onClose={vi.fn()} />);
    expect(screen.getByTestId("down-now").textContent).toBe("Split — 2 parts");
    expect(screen.getByTestId("down-parts").textContent).toContain("HDFC Current · bank statement");
    expect(screen.queryByRole("button", { name: "Save paid from" })).toBeNull();
    expect((screen.getByLabelText("Part 1 paid from") as HTMLSelectElement).value).toBe("line:l1");
    expect((screen.getByLabelText("Part 2 paid from") as HTMLSelectElement).value).toBe("acc:cash-1");
  });
});

describe("R-2523 split helpers", () => {
  it("rowsFromParts: statement → line:, by hand → acc:, owner → OWNER; none → one row for the whole", () => {
    expect(rowsFromParts([], 200000, "2026-02-03")).toEqual([{ key: "r0", source: "", amount: "200000", date: "2026-02-03", partner: "" }]);
    const rows = rowsFromParts([
      { kind: "account", lineId: "l1", accountId: "hdfc-1", imported: true, amount: 21000, date: "2026-01-02" },
      { kind: "owner", amount: 71906, date: "2026-02-03", partner: "Pardeep" },
    ], 200000, "2026-02-03");
    expect(rows.map((r) => r.source)).toEqual(["line:l1", "__owner__"]);
    expect(rows[1].partner).toBe("Pardeep");
  });
  it("splitPlan: the sum uses the statement line's own amount; partner needed for a firm", () => {
    const amt = (id: string) => ({ l1: 21000 } as Record<string, number>)[id];
    const ok = splitPlan([
      { key: "a", source: "line:l1", amount: "", date: "", partner: "" },
      { key: "b", source: "__owner__", amount: "179000", date: "2026-02-03", partner: "" },
    ], 200000, amt, false);
    expect(ok).toMatchObject({ sum: 200000, left: 0, problem: null });
    expect(ok.parts).toEqual([{ bank_txn_id: "l1" }, { paid_by_owner: true, amount: 179000, date: "2026-02-03", partner: null }]);
    expect(splitPlan([{ key: "b", source: "__owner__", amount: "200000", date: "2026-02-03", partner: "" }], 200000, amt, true).problem)
      .toMatch(/partner/);
    expect(splitPlan([{ key: "b", source: "acc:x", amount: "1.5", date: "2026-02-03", partner: "" }], 200000, amt, false).problem)
      .toMatch(/whole rupees/);
  });
});
