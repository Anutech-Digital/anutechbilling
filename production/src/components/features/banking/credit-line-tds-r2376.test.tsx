// @vitest-environment jsdom
/* R-2376 — Banking → Reconcile → Loan / EMI, money out to a non-bank lender: the TDS box is filled
   with the TDS due once this interest takes the lender's FY total above ₹10,000 (s.393(1) Table
   5(iii), old 194A). The owner sees it and confirms by reconciling — nothing posts by itself.
   Owner example (OD audit 2 Nov): Bajaj Finance OD, ₹46,000 interest-only ACH, 5 Jul 2026 —
   first interest of the FY → 10% = ₹4,600 kept back; bank line ₹41,400. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const repay = vi.fn();
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
vi.mock("@/lib/queries/loan-interest-tds", () => ({ useLoanInterestTds: () => ({ data: tdsData }) }));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: { businessType } }) }));

import { CreditLineSection } from "./credit-line-section";
import { lenderKey } from "@/lib/accounting/loan-interest-tds";

const bajaj = { id: "od", lender: "Bajaj Finance", kind: "credit_line", credit_limit: 5_000_000, status: "active", principal: 4_000_000, outstanding: 4_000_000, principalPaid: 0, interestPaid: 0, emisPaid: 0 };
const hdfc = { ...bajaj, id: "hd", lender: "HDFC Bank" };
const ach = { id: "t-out", credit: 0, debit: 41_400, txn_date: "2026-07-05", description: "ACH DR BAJAJ FINANCE" };
const settings = { off: false, audited: {}, lenders: { [lenderKey("Bajaj Finance")]: "non_bank", [lenderKey("HDFC Bank")]: "bank" } };

afterEach(cleanup);
beforeEach(() => {
  repay.mockReset(); repay.mockResolvedValue("p1");
  loans = [bajaj];
  businessType = "pvt_ltd";
  tdsData = { ready: true, settings, events: [] };
});

describe("R-2376 TDS box on a lender repayment", () => {
  it("non-bank lender, interest crosses ₹10,000 → TDS filled with 10%, the line balances", async () => {
    render(<CreditLineSection transaction={ach} onDone={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/Interest/), { target: { value: "46000" } });
    expect((screen.getByLabelText(/TDS/) as HTMLInputElement).value).toBe("4600");
    expect(screen.getByTestId("credit-line-split").textContent).toContain("s.393(1) Table 5(iii) (old 194A)");
    fireEvent.click(screen.getByRole("button", { name: /Reconcile repayment/ }));
    await Promise.resolve();
    expect(repay).toHaveBeenCalledWith({ txnId: "t-out", loanId: "od", principal: 0, interest: 46_000, tds: 4_600 });
  });

  it("a bank lender → TDS stays 0", () => {
    loans = [hdfc];
    render(<CreditLineSection transaction={{ ...ach, debit: 46_000, description: "ACH DR HDFC BANK" }} onDone={() => undefined} />);
    expect((screen.getByLabelText(/TDS/) as HTMLInputElement).value).toBe("0");
  });

  it("the owner's own TDS figure is kept (not overwritten)", () => {
    render(<CreditLineSection transaction={ach} onDone={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/TDS/), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText(/Interest/), { target: { value: "41400" } });
    expect((screen.getByLabelText(/TDS/) as HTMLInputElement).value).toBe("0");
  });

  it("proprietorship not tax-audited → 0", () => {
    businessType = "proprietor";
    tdsData = { ready: true, settings: { ...settings, audited: { "2025": false } }, events: [] };
    render(<CreditLineSection transaction={ach} onDone={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/Interest/), { target: { value: "46000" } });
    expect((screen.getByLabelText(/TDS/) as HTMLInputElement).value).toBe("0");
  });
});
