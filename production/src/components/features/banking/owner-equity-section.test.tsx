// @vitest-environment jsdom
/* R-1839 — Banking → Reconcile, the owner choice: a proprietor's money-out line books as Owner
   drawings (or onto an entry recorded by hand — no double count); a money-in line as Capital
   introduced; a firm needs the partner; a Pvt Ltd sees "Paid to a director" choices, never drawings. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";
import type { OwnerEquityMovement } from "@/lib/accounting/owner-equity";

const mutateAsync = vi.fn();
let businessType: string | null = "proprietor";
let movements: OwnerEquityMovement[] = [];
vi.mock("@/lib/compliance/profile", () => ({
  useComplianceProfile: () => ({ data: { businessType, gstFiling: null, columnsMissing: false } }),
}));
vi.mock("@/lib/queries/owner-equity", () => ({
  useOwnerEquityMovements: () => ({ data: movements, isLoading: false, isError: false }),
  useBookBankTxnAsOwnerEquity: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { OwnerEquitySection, ownerEntryCandidates } from "./owner-equity-section";

const txn = (over: Partial<BankTransactionRow>): BankTransactionRow => ({
  id: "t1", tenant_id: "x", bank_account_id: "acc-1", txn_date: "2026-10-06", description: "UPI/SELF",
  debit: 5000, credit: 0, balance_after: null, reference: null, source: "csv_upload",
  matched_to_type: null, matched_to_id: null, matched_at: null, matched_by: null, match_confidence: null,
  imported_at: "", created_at: "", updated_at: "", ...over,
} as BankTransactionRow);
const mv = (over: Partial<OwnerEquityMovement>): OwnerEquityMovement => ({
  id: "m1", kind: "drawings", movement_date: "2026-10-05", amount: 5000, bank_account_id: "acc-1", bank_txn_id: "s1",
  own_line: true, partner_name: null, note: "Home rent", ...over,
});

afterEach(cleanup);
beforeEach(() => { mutateAsync.mockReset(); mutateAsync.mockResolvedValue({}); businessType = "proprietor"; movements = []; });

describe("R-1839 reconcile — owner drawings (debit)", () => {
  it("proprietor: books the money-out line as Owner drawings, not an expense", async () => {
    const done = vi.fn();
    render(<OwnerEquitySection transaction={txn({})} onDone={done} />);
    expect(screen.getByText(/not an expense/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Book ₹5,000 as owner drawings/ }));
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledWith({ transactionId: "t1", partner: null, note: null, movementId: null });
  });

  it("an entry recorded by hand for the same amount on this account is offered — and used", async () => {
    movements = [mv({}), mv({ id: "m2", amount: 4000 }), mv({ id: "m3", bank_account_id: "acc-2" }), mv({ id: "m4", own_line: false })];
    render(<OwnerEquitySection transaction={txn({})} onDone={vi.fn()} />);
    const use = screen.getAllByRole("button", { name: "Use this entry" });
    expect(use).toHaveLength(1);
    fireEvent.click(use[0]);
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ transactionId: "t1", movementId: "m1" });
  });

  it("candidates: same direction only, nearest date first", () => {
    const list = ownerEntryCandidates(
      [mv({ id: "far", movement_date: "2026-09-01" }), mv({ id: "near", movement_date: "2026-10-07" }), mv({ id: "cap", kind: "capital_introduced" })],
      txn({}),
    );
    expect(list.map((m) => m.id)).toEqual(["near", "far"]);
  });

  it("partnership: the partner is required before booking", async () => {
    businessType = "partnership";
    render(<OwnerEquitySection transaction={txn({})} onDone={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /as partner drawings/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Partner"), { target: { value: "Ravi" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ partner: "Ravi" });
  });

  it("LLP says partner withdrawal", () => {
    businessType = "llp";
    render(<OwnerEquitySection transaction={txn({})} onDone={vi.fn()} />);
    expect(screen.getByRole("button", { name: /as partner withdrawal/ })).toBeTruthy();
  });

  it("Pvt Ltd: director choices with the s.185 caution, never drawings", () => {
    businessType = "pvt_ltd";
    const { container } = render(<OwnerEquitySection transaction={txn({})} onDone={vi.fn()} />);
    expect(screen.getByText("Paid to a director?")).toBeTruthy();
    expect(screen.getByText(/s\.185/)).toBeTruthy();
    // Says why there is no drawings, but never offers it.
    expect(container.textContent).not.toMatch(/Owner drawings|Partner drawings|Partner withdrawal/);
    expect(screen.queryByRole("button", { name: /Book/ })).toBeNull();
    expect((screen.getAllByRole("link", { name: "Open" }) as HTMLAnchorElement[]).map((a) => a.getAttribute("href")))
      .toEqual(["/accounting/payroll", "/accounting/loans-given", "/accounting/reimbursements"]);
  });
});

describe("business type not set = Pvt Ltd (one rule for the app, 24 Oct)", () => {
  it("an empty type gives the director choices, not drawings", () => {
    businessType = null;
    const { container } = render(<OwnerEquitySection transaction={txn({})} onDone={vi.fn()} />);
    expect(screen.getByText("Paid to a director?")).toBeTruthy();
    expect(container.textContent).not.toMatch(/Owner drawings|Partner drawings|Partner withdrawal/);
    expect(screen.queryByRole("button", { name: /Book/ })).toBeNull();
  });
  it("after choosing Proprietor the drawings option appears", () => {
    businessType = null;
    const { rerender } = render(<OwnerEquitySection transaction={txn({})} onDone={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /owner drawings/ })).toBeNull();
    businessType = "proprietor";
    rerender(<OwnerEquitySection transaction={txn({ id: "t1" })} onDone={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Book ₹5,000 as owner drawings/ })).toBeTruthy();
  });
});

describe("R-1839 reconcile — capital introduced (credit)", () => {
  it("proprietor: money in books as Capital introduced, not income", async () => {
    render(<OwnerEquitySection transaction={txn({ debit: 0, credit: 15000 })} onDone={vi.fn()} />);
    expect(screen.getByText(/not income/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Book ₹15,000 as capital introduced/ }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
  });
  it("Pvt Ltd: nothing here (share capital / director's loan has its own box)", () => {
    businessType = "pvt_ltd";
    const { container } = render(<OwnerEquitySection transaction={txn({ debit: 0, credit: 15000 })} onDone={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});
