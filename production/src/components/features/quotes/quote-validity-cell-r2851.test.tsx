// @vitest-environment jsdom
// R-2851 — the /quotes Valid-until cell: a payment request past pay-by is amber "still payable", not red "Expired Nd".
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";
import { QuoteValidityCell } from "./quote-validity-cell";
import { PAY_BY_PASSED_LABEL } from "@/lib/billing/proforma";

afterEach(cleanup);
const base = { status: "sent", payment_status: "awaiting", expires_date: "2026-11-07", amount: 100, payment_amount: 0 };

describe("QuoteValidityCell (R-2851)", () => {
  it("payment request past pay-by: amber words, no 'Expired'", () => {
    render(<QuoteValidityCell q={{ ...base, subscription_billing_id: "SB-1" }} today="2026-11-15" />);
    expect(screen.getByText(PAY_BY_PASSED_LABEL)).toBeTruthy();
    expect(screen.queryByText(/Expired/)).toBeNull();
  });
  it("normal quote past validity: red 'Expired 8d' as before", () => {
    render(<QuoteValidityCell q={base} today="2026-11-15" />);
    expect(screen.getByText("Expired 8d")).toBeTruthy();
  });
  it("normal quote with days left: unchanged", () => {
    render(<QuoteValidityCell q={{ ...base, expires_date: "2026-11-20" }} today="2026-11-15" />);
    expect(screen.getByText("5d left")).toBeTruthy();
  });
  it("accepted / no date: dash", () => {
    render(<QuoteValidityCell q={{ ...base, status: "accepted" }} today="2026-11-15" />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});
