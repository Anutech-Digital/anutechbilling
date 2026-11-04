// @vitest-environment jsdom
/* R-2376 — Banking → Reconcile → Loan / EMI, money out to a non-bank lender: the split says the
   TDS due once this interest takes the lender's FY total above ₹10,000 (s.393(1) Table 5(iii),
   old 194A) and offers "Keep ₹X back". The box stays 0 until the owner clicks it — the owner
   confirms; nothing posts by itself. Owner example (OD audit 2 Nov): Bajaj Finance OD, ₹46,000
   interest, 5 Jul 2026 — first interest of the FY → 10% = ₹4,600 kept back; bank line ₹41,400. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const repay = vi.fn();
const refresh = vi.fn();
let loans: unknown[] = [];
let tdsData: unknown = null;
let businessType: string | null = "pvt_ltd";
vi.mock("@/lib/queries/business-loans", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/business-loans")>()),
  useBusinessLoans: () => ({ data: loans, isLoading: false }),
  useReconcileCreditToCreditLine: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReconcileDebitToBusinessLoan: () => ({ mutateAsync: repay, isPending: false }),
  useRecordCreditLine: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/loan-interest-tds", () => ({
  useLoanInterestTds: () => ({ data: tdsData }),
  useRefreshLoanInterestTds: () => refresh,
}));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: { businessType } }) }));

import { CreditLineSection } from "./credit-line-section";
import { lenderKey } from "@/lib/accounting/loan-interest-tds";

const bajaj = { id: "od", lender: "Bajaj Finance", kind: "credit_line", credit_limit: 5_000_000, status: "active", principal: 4_000_000, outstanding: 4_000_000, principalPaid: 0, interestPaid: 0, emisPaid: 0 };
const hdfc = { ...bajaj, id: "hd", lender: "HDFC Bank" };
const newNbfc = { ...bajaj, id: "nn", lender: "New Finance" };
const ach = { id: "t-out", credit: 0, debit: 41_400, txn_date: "2026-07-05", description: "ACH DR BAJAJ FINANCE" };
const settings = { off: false, audited: {}, lenders: { [lenderKey("Bajaj Finance")]: "non_bank", [lenderKey("HDFC Bank")]: "bank" } };
const tdsBox = () => (screen.getByLabelText(/TDS/) as HTMLInputElement).value;

afterEach(cleanup);
beforeEach(() => {
  repay.mockReset(); repay.mockResolvedValue("p1"); refresh.mockReset();
  loans = [bajaj];
  businessType = "pvt_ltd";
  tdsData = { ready: true, settings, events: [] };
});

describe("R-2376 TDS on a lender repayment", () => {
  it("non-bank lender, interest crosses ₹10,000 → says ₹4,600 due; box stays 0 until 'Keep ₹4,600 back'", async () => {
    render(<CreditLineSection transaction={ach} onDone={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/Interest/), { target: { value: "46000" } });
    expect(tdsBox()).toBe("0");
    const advice = screen.getByTestId("credit-line-tds-advice").textContent ?? "";
    expect(advice).toContain("₹4,600");
    expect(advice).toContain("s.393(1) Table 5(iii) (old 194A)");
    fireEvent.click(screen.getByRole("button", { name: /Keep ₹4,600 back/ }));
    expect(tdsBox()).toBe("4600");
    fireEvent.click(screen.getByRole("button", { name: /Reconcile repayment/ }));
    await Promise.resolve(); await Promise.resolve();
    expect(repay).toHaveBeenCalledWith({ txnId: "t-out", loanId: "od", principal: 0, interest: 46_000, tds: 4_600 });
    expect(refresh).toHaveBeenCalled();   // the next repayment's figure counts this one
  });

  it("the default interest-only path (Interest not edited) also shows the TDS due", () => {
    render(<CreditLineSection transaction={{ ...ach, debit: 46_000 }} onDone={() => undefined} />);
    expect(screen.getByTestId("credit-line-tds-advice").textContent).toContain("₹4,600");
  });

  it("a bank lender → no TDS line", () => {
    loans = [hdfc];
    render(<CreditLineSection transaction={{ ...ach, debit: 46_000, description: "ACH DR HDFC BANK" }} onDone={() => undefined} />);
    expect(screen.queryByTestId("credit-line-tds-advice")).toBeNull();
    expect(tdsBox()).toBe("0");
  });

  it("an unmarked lender above the limit → 'mark whether … is a bank' (not silent)", () => {
    loans = [newNbfc];
    render(<CreditLineSection transaction={{ ...ach, debit: 46_000, description: "ACH NEW FINANCE" }} onDone={() => undefined} />);
    expect(screen.getByTestId("credit-line-tds-advice").textContent).toMatch(/mark whether New Finance is a bank/);
    expect(screen.queryByRole("button", { name: /Keep/ })).toBeNull();
  });

  it("proprietorship not tax-audited → no TDS line", () => {
    businessType = "proprietor";
    tdsData = { ready: true, settings: { ...settings, audited: { "2025": false } }, events: [] };
    render(<CreditLineSection transaction={{ ...ach, debit: 46_000 }} onDone={() => undefined} />);
    expect(screen.queryByTestId("credit-line-tds-advice")).toBeNull();
  });
});
