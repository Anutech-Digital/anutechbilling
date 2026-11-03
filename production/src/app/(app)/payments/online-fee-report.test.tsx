// @vitest-environment jsdom
//
// R-2418 — Online fee report: who sees the button, the month/customer numbers, and the
// "Fee GST credit blocked" banner only while Razorpay has no GSTIN in Vendors.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import type { OnlineFeeReportData } from "@/lib/queries/online-fee-report";
import type { FeeReportPayment } from "@/lib/razorpay/fee-report";

const state: { data: OnlineFeeReportData | undefined } = { data: undefined };
vi.mock("@/lib/queries/online-fee-report", () => ({
  useOnlineFeeReport: () => ({ data: state.data, isLoading: false, error: null, refetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { OnlineFeeReportButton } from "./online-fee-report";

afterEach(cleanup);

const row = (over: Partial<FeeReportPayment>): FeeReportPayment => ({
  id: "p", receivedAt: "2026-11-02T10:00:00Z", customerId: "c1", customerName: "Sharma Traders",
  gatewayFee: 236, gatewayFeeGst: 36, feeBearer: "customer", feeCharged: 0, billWaived: false, customerAbsorbs: false,
  ...over,
});

function openReport(data: OnlineFeeReportData) {
  state.data = data;
  render(<OnlineFeeReportButton hasFees role="owner" />);
  fireEvent.click(screen.getByRole("button", { name: /Online fee report/ }));
}

describe("OnlineFeeReportButton", () => {
  it("hidden for sales and when no payment carries a fee", () => {
    const a = render(<OnlineFeeReportButton hasFees role="sales" />);
    expect(a.container.textContent).toBe("");
    a.unmount();
    const b = render(<OnlineFeeReportButton hasFees={false} role="owner" />);
    expect(b.container.textContent).toBe("");
  });

  it("no Razorpay GSTIN → banner with the blocked GST and a Vendors button", () => {
    openReport({
      rows: [row({ id: "a" }), row({ id: "b", feeBearer: "business", customerAbsorbs: true, gatewayFee: 100, gatewayFeeGst: 15, customerName: "Gupta & Co", customerId: "c2" })],
      razorpayGstin: null,
      policyReady: true,
    });
    expect(screen.getByText("Fee GST ₹51 credit blocked — add Razorpay's GSTIN")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Vendors" }).getAttribute("href")).toBe("/accounting/vendors");
    expect(screen.getByText("We absorb for this customer")).toBeTruthy();
    expect(screen.getByText("Customer should pay — not charged yet")).toBeTruthy();
    expect(screen.getByText("Nov 2026")).toBeTruthy();
    expect(screen.getAllByText("₹336").length).toBeGreaterThan(0);
  });

  it("Razorpay GSTIN on the vendor → no banner", () => {
    openReport({ rows: [row({})], razorpayGstin: "29AAGCR4375J1ZU", policyReady: true });
    expect(screen.queryByText(/credit blocked/)).toBeNull();
  });
});
