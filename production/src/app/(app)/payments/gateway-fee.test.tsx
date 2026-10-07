// @vitest-environment jsdom
//
// R-045 slice 2 — Fee / Net under a payment's amount, and who sees "Book Razorpay fees".
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FeeNetLine, BookGatewayFeesButton } from "./gateway-fee";

afterEach(cleanup);

const withQc = (ui: React.ReactElement) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

describe("FeeNetLine", () => {
  it("shows Fee and Net (amount − fee) when the fee is known", () => {
    render(<FeeNetLine payment={{ amount: 1180, gateway_fee: 28, gateway_fee_gst: 4 }} />);
    const line = screen.getByText(/Fee/);
    expect(line.textContent).toMatch(/Fee ₹28 · Net ₹1,152/);
    expect(line.getAttribute("title")).toMatch(/GST ₹4/);
  });

  it("shows nothing when the fee is unknown", () => {
    const { container } = render(<FeeNetLine payment={{ amount: 1180, gateway_fee: null }} />);
    expect(container.textContent).toBe("");
  });
});

describe("BookGatewayFeesButton", () => {
  const pays = [{ amount: 1180, gateway_fee: 28, gateway_fee_gst: 4 }];

  it.each(["owner", "manager", "billing", "accountant"])("%s sees it when a payment has a fee", (role) => {
    render(withQc(<BookGatewayFeesButton payments={pays} role={role} />));
    expect(screen.getByRole("button", { name: /Book Razorpay fees/ })).toBeTruthy();
  });

  it("hidden for sales, and when no payment carries a fee", () => {
    const a = render(withQc(<BookGatewayFeesButton payments={pays} role="sales" />));
    expect(a.container.textContent).toBe("");
    a.unmount();
    const b = render(withQc(<BookGatewayFeesButton payments={[{ amount: 500 }]} role="owner" />));
    expect(b.container.textContent).toBe("");
  });
});
