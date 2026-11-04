// @vitest-environment jsdom
/* R-2374 — Banking → Reconcile → Loan / EMI: a Bajaj Finance flexi / OD (OD audit 2 Nov 2026).
   Money in "FT BAJAJ FINANCE FLEXI DISB ₹40,00,000" → drawdown on the credit line.
   Money out "ACH DR BAJAJ FINANCE ₹1,66,000" → split ₹46,000 interest (Finance cost) + ₹1,20,000
   principal (reduces the line); interest-only by default; TDS 194A box defaults to 0. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const draw = vi.fn();
const repay = vi.fn();
const setUp = vi.fn();
let loans: unknown[] = [];
vi.mock("@/lib/queries/business-loans", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/business-loans")>()),
  useBusinessLoans: () => ({ data: loans, isLoading: false }),
  useReconcileCreditToCreditLine: () => ({ mutateAsync: draw, isPending: false }),
  useReconcileDebitToBusinessLoan: () => ({ mutateAsync: repay, isPending: false }),
  useRecordCreditLine: () => ({ mutateAsync: setUp, isPending: false }),
}));
/* R-2376: the TDS box reads the loan-interest TDS answers — none here, so TDS stays 0. */
vi.mock("@/lib/queries/loan-interest-tds", () => ({ useLoanInterestTds: () => ({ data: undefined }) }));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: undefined }) }));

import { CreditLineSection } from "./credit-line-section";

const bajaj = { id: "od", lender: "Bajaj Finance", kind: "credit_line", credit_limit: 5_000_000, status: "active", principal: 4_000_000, outstanding: 4_000_000, principalPaid: 0, interestPaid: 0, emisPaid: 0 };
const tata = { id: "tl", lender: "Tata Capital", kind: "term", credit_limit: null, status: "active", principal: 200_000, outstanding: 200_000, principalPaid: 0, interestPaid: 0, emisPaid: 0 };
const inLine = { id: "t-in", credit: 4_000_000, debit: 0, txn_date: "2026-06-06", description: "FT BAJAJ FINANCE FLEXI DISB" };
const outLine = { id: "t-out", credit: 0, debit: 166_000, txn_date: "2026-08-05", description: "ACH DR BAJAJ FINANCE" };
const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(cleanup);
beforeEach(() => {
  draw.mockReset(); draw.mockResolvedValue("d1");
  repay.mockReset(); repay.mockResolvedValue("p1");
  setUp.mockReset(); setUp.mockResolvedValue("new");
  loans = [tata, bajaj];
});

describe("R-2374 credit line on a bank line", () => {
  it("money in → only the credit line is offered → Reconcile as drawdown", async () => {
    const onDone = vi.fn();
    render(<CreditLineSection transaction={inLine} onDone={onDone} />);
    expect(screen.queryByText(/Tata Capital/)).toBeNull();
    expect(screen.getByText(/Bajaj Finance/)).toBeTruthy();
    expect(screen.getByText(/₹10,00,000 free/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Reconcile as drawdown/ }));
    await vi.waitFor(() => expect(draw).toHaveBeenCalledWith({ txnId: "t-in", loanId: "od" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("money out → Bajaj (named) first; interest-only default; ₹46,000 interest → ₹1,20,000 principal", async () => {
    render(<CreditLineSection transaction={outLine} onDone={() => {}} />);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios[0].checked).toBe(true);
    expect(radios[0].closest("label")?.textContent).toContain("Bajaj Finance");
    expect((screen.getByLabelText(/^Interest/) as HTMLInputElement).value).toBe("166000");
    expect((screen.getByLabelText(/^Principal/) as HTMLInputElement).value).toBe("0");
    expect((screen.getByLabelText(/^TDS 194A/) as HTMLInputElement).value).toBe("0");
    type(/^Interest/, "46000");
    expect((screen.getByLabelText(/^Principal/) as HTMLInputElement).value).toBe("120000");
    expect(screen.getByTestId("credit-line-split").textContent).toContain("Interest on loans / OD (Finance cost)");
    fireEvent.click(screen.getByRole("button", { name: /Reconcile repayment/ }));
    await vi.waitFor(() => expect(repay).toHaveBeenCalledWith({ txnId: "t-out", loanId: "od", principal: 120_000, interest: 46_000, tds: 0 }));
  });

  it("a split that does not add up to the line cannot be saved", () => {
    render(<CreditLineSection transaction={outLine} onDone={() => {}} />);
    type(/^Interest/, "46000");
    type(/^Principal/, "100000");
    expect(screen.getByText("Principal + interest − TDS must equal the bank line.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Reconcile repayment/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("no credit line yet → Set up a credit line (lender, limit) from the line", async () => {
    loans = [];
    render(<CreditLineSection transaction={inLine} onDone={() => {}} />);
    expect(screen.getByText(/No credit line is set up yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Set up a credit line/ }));
    type(/^Lender/, "Bajaj Finance");
    type(/^Limit/, "5000000");
    type(/^Interest %/, "15");
    expect((screen.getByLabelText(/^Started on/) as HTMLInputElement).value).toBe("2026-06-06");
    fireEvent.click(screen.getByRole("button", { name: /Set up credit line/ }));
    await vi.waitFor(() => expect(setUp).toHaveBeenCalledWith({
      lender: "Bajaj Finance", purpose: null, limit: 5_000_000, interestRate: 15, startOn: "2026-06-06", opening: 0,
    }));
  });
});
