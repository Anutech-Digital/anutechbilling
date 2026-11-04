// @vitest-environment jsdom
/* R-2376 — Business Loans: "TDS 10% due" when interest to a non-bank lender crosses ₹10,000 in
   the FY (s.393(1) Table 5(iii), old 194A). Owner example (OD audit 2 Nov 2026): Tata Capital
   processing fee ₹4,000 + EMIs ₹3,000 → crosses on the 4th booking (₹13,000) → ₹1,300 due. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const save = vi.fn();
let data: unknown = null;
let businessType: string | null = "pvt_ltd";
let role = "owner";
vi.mock("@/lib/queries/loan-interest-tds", () => ({
  useLoanInterestTds: () => ({ data, isLoading: false }),
  useSetLoanInterestTds: () => ({ mutate: save, isPending: false }),
}));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: { businessType } }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role } }) }));
vi.mock("@/lib/dates/ist", async (orig) => ({ ...(await orig<typeof import("@/lib/dates/ist")>()), istToday: () => "2026-11-04" }));

import { LoanInterestTdsCard } from "./loan-interest-tds-card";
import { lenderKey } from "@/lib/accounting/loan-interest-tds";

const tata = [
  { lender: "Tata Capital", on: "2026-04-10", amount: 4000, kind: "fee", tdsKept: 0, lenderType: null },
  { lender: "Tata Capital", on: "2026-05-05", amount: 3000, kind: "interest", tdsKept: 0, lenderType: null },
  { lender: "Tata Capital", on: "2026-06-05", amount: 3000, kind: "interest", tdsKept: 0, lenderType: null },
  { lender: "Tata Capital", on: "2026-07-05", amount: 3000, kind: "interest", tdsKept: 0, lenderType: null },
];
const marked = { off: false, audited: {}, lenders: { [lenderKey("Tata Capital")]: "non_bank" } };

afterEach(cleanup);
beforeEach(() => { save.mockReset(); businessType = "pvt_ltd"; role = "owner"; });

describe("R-2376 TDS on loan interest card", () => {
  it("non-bank lender above ₹10,000 → TDS 10% due with amount, section and the entry", () => {
    data = { ready: true, settings: marked, events: tata };
    render(<LoanInterestTdsCard />);
    const card = screen.getByTestId("loan-interest-tds");
    expect(card.textContent).toContain("Tata Capital");
    expect(card.textContent).toContain("TDS 10% due");
    expect(card.textContent).toContain("₹1,300");
    expect(card.textContent).toContain("s.393(1) Table 5(iii) (old 194A)");
    expect(card.textContent).toMatch(/Dr Tata Capital.*Cr TDS payable/);
    expect(save).not.toHaveBeenCalled();   // nothing is posted by itself
  });

  it("an unmarked lender → asks once; the answer is saved by its key", () => {
    data = { ready: true, settings: { off: false, audited: {}, lenders: {} }, events: tata };
    render(<LoanInterestTdsCard />);
    fireEvent.click(screen.getByRole("button", { name: /Not a bank/ }));
    expect(save).toHaveBeenCalledWith({ what: "lender", key: lenderKey("Tata Capital"), value: "non_bank" });
  });

  it("a bank lender → nothing shown", () => {
    data = { ready: true, settings: { off: false, audited: {}, lenders: { [lenderKey("Tata Capital")]: "bank" } }, events: tata };
    const { container } = render(<LoanInterestTdsCard />);
    expect(container.textContent).toBe("");
  });

  it("below the limit → nothing shown", () => {
    data = { ready: true, settings: marked, events: tata.slice(0, 3) };
    const { container } = render(<LoanInterestTdsCard />);
    expect(container.textContent).toBe("");
  });

  it("proprietorship, not answered → asks 'tax-audited in FY 2025-26?' (never silently off)", () => {
    businessType = "proprietor";
    data = { ready: true, settings: marked, events: tata };
    render(<LoanInterestTdsCard />);
    expect(screen.getByTestId("loan-interest-tds").textContent).toContain("FY 2025-26");
    fireEvent.click(screen.getByRole("button", { name: /^No/ }));
    expect(save).toHaveBeenCalledWith({ what: "audited", key: "2025", value: "false" });
  });

  it("proprietorship not tax-audited → nothing due shown", () => {
    businessType = "proprietor";
    data = { ready: true, settings: { ...marked, audited: { "2025": false } }, events: tata };
    render(<LoanInterestTdsCard />);
    expect(screen.queryByText(/TDS 10% due/)).toBeNull();
  });

  it("turn off → saved; when off only a short note with Turn on stays", () => {
    data = { ready: true, settings: marked, events: tata };
    render(<LoanInterestTdsCard />);
    fireEvent.click(screen.getByRole("button", { name: /Turn this check off/ }));
    expect(save).toHaveBeenCalledWith({ what: "off", key: null, value: "true" });
    cleanup();
    data = { ready: true, settings: { ...marked, off: true }, events: tata };
    render(<LoanInterestTdsCard />);
    expect(screen.queryByText(/TDS 10% due/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Turn on/ }));
    expect(save).toHaveBeenLastCalledWith({ what: "off", key: null, value: "false" });
  });

  it("a sales user sees the due line but no answer buttons", () => {
    role = "sales";
    data = { ready: true, settings: { off: false, audited: {}, lenders: {} }, events: tata };
    render(<LoanInterestTdsCard />);
    expect(screen.queryByRole("button", { name: /Not a bank/ })).toBeNull();
  });

  it("before the migration → nothing", () => {
    data = { ready: false, settings: marked, events: tata };
    const { container } = render(<LoanInterestTdsCard />);
    expect(container.textContent).toBe("");
  });
});

describe("R-2376 review fixes on the card", () => {
  it("proprietor not answered → 'may be due' and no entry until answered", () => {
    businessType = "proprietor";
    data = { ready: true, settings: marked, events: tata };
    render(<LoanInterestTdsCard />);
    const t = screen.getByTestId("loan-interest-tds").textContent ?? "";
    expect(t).toContain("TDS 10% may be due");
    expect(t).not.toContain("Entry when you deduct");
  });
  it("a lender booked only as EMIs → says the EMI line has no TDS box yet (no false 'TDS box' advice)", () => {
    data = { ready: true, settings: marked, events: tata.map((e) => ({ ...e, viaEmi: true })) };
    render(<LoanInterestTdsCard />);
    const t = screen.getByTestId("loan-interest-tds").textContent ?? "";
    expect(t).toContain("an EMI line has no TDS box in the app yet");
    expect(t).not.toContain("Keep it back from the next payment");
  });
  it("last FY's interest is not shown as this FY's due", () => {
    data = { ready: true, settings: marked, events: tata.map((e) => ({ ...e, on: e.on.replace("2026", "2025") })) };
    const { container } = render(<LoanInterestTdsCard />);
    expect(container.textContent).toBe("");
  });
});
