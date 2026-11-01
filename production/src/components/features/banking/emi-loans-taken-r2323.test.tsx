// @vitest-environment jsdom
/* R-2323 — Accounting › Business Loans lists a loan set up from an EMI line: the bike loan
   (₹2,50,000, EMI ₹19,054, 14 EMIs) after EMI 1 → ₹2,33,238 outstanding, 1 / 14 EMIs paid. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("@/components/features/accounting/emi-loan-dialogs", () => ({ EmiScheduleDialog: () => <div>schedule dialog</div> }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { EmiLoansTaken } from "./emi-loans-taken";
import type { EmiPurchase } from "@/lib/queries/emi";

afterEach(cleanup);

const bike = {
  id: "p1", name: "Loan — HDFC Bank", lender: "HDFC Bank", kind: "loan", status: "active", financed: 250000,
  emi_amount: 19054, emi_count: 14, first_emi_on: "2026-10-05", outstanding: 233238, emisPaid: 1, principalPaid: 16762,
} as unknown as EmiPurchase;

describe("R-2323 — loans with an EMI schedule on Business Loans", () => {
  it("shows the lender, outstanding principal and paid instalments", () => {
    render(<EmiLoansTaken loans={[bike]} />);
    const row = screen.getByTestId("emi-loan-row");
    expect(within(row).getByText("HDFC Bank")).toBeTruthy();
    expect(row.textContent).toContain("₹2,33,238");
    expect(row.textContent).toContain("1 / 14");
    expect(row.textContent).toContain("₹19,054");
    expect(within(row).getByRole("button", { name: "Schedule" })).toBeTruthy();
  });
  it("renders nothing when there is no such loan", () => {
    const { container } = render(<EmiLoansTaken loans={[]} />);
    expect(container.textContent).toBe("");
  });
});
