// @vitest-environment jsdom
//
// R-1679 (staging 19 Oct, Q-5F40-27-0096 "Valid until 18 Oct"): the customer page of an expired
// quote showed "Accept this quote · ₹38,232". Now: no Accept, an honest line, and "Request a
// fresh quote" that tells sales.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { QuoteAcceptView, type PublicQuote } from "./quote-accept-view";

vi.mock("@/lib/notifications/quote-expired.server", () => ({}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const quote = {
  id: "Q-5F40-27-0096", status: "expired", customer_name: "T-6 Customer",
  subtotal: 32_400, discount_pct: 0, tax_rate: 18, amount: 38_232, expires_date: "2026-10-18",
  notes: null, billing_cycle: "yearly", currency: "INR", exchange_rate: 1,
} as unknown as PublicQuote;

function show() {
  render(<QuoteAcceptView quote={quote} lineItems={[]} token="tok-1" tenantName="Anutech" tenantGstin={null}
    tenantEmail={null} tenantPhone="+91 98100 00000" tenantAddress={null} />);
}

describe("R-1679: the customer page of an expired quote", () => {
  it("shows no Accept button and says when it ran out", () => {
    show();
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
    expect(screen.getByText("This quote has expired")).toBeTruthy();
    expect(document.body.textContent).toMatch(/was valid until/);
  });

  it("'Request a fresh quote' works without a reseller email — it tells sales through the app", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, message: "Thank you — Anutech has been told and will send you a fresh quote." }) });
    vi.stubGlobal("fetch", fetchMock);
    show();
    fireEvent.click(screen.getByRole("button", { name: /request a fresh quote/i }));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/has been told/));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/public/quote/Q-5F40-27-0096/request-fresh?t=tok-1");
  });
});
