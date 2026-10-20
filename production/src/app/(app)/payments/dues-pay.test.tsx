// @vitest-environment jsdom
//
// R-1697 — Subscription dues: the button records money RECEIVED from the customer
// ("Record payment", never "Pay"), and every row gets it — rows without a customer quote
// route to the subscription's own (or renewal) quote, the same record_payment path the
// quote page uses; a row no existing path can settle shows the button disabled with why.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { DuesPayButton, duesPaymentRoute, DUES_PAY_LABEL, DUES_PAY_HINT } from "./dues-pay";

afterEach(cleanup);

const row = (over: Partial<{ subscription_id: string; customer_name: string; quote_id: string | null }> = {}) => ({
  subscription_id: "sub-1",
  customer_name: "Loudleaf",
  quote_id: null as string | null,
  ...over,
});

describe("duesPaymentRoute", () => {
  it("a row with a customer quote keeps opening that quote (unchanged)", () => {
    expect(duesPaymentRoute(row({ quote_id: "Q-1" }), undefined)).toEqual({ kind: "quote", quoteId: "Q-1" });
  });

  it("no customer quote → the subscription's own unpaid quote", () => {
    const links = { quoteId: "Q-OWN", quoteStatus: "awaiting", renewalQuoteId: null, renewalQuoteStatus: null };
    expect(duesPaymentRoute(row(), links)).toEqual({ kind: "quote", quoteId: "Q-OWN" });
  });

  it("an open renewal quote comes first — that is what the balance is for", () => {
    const links = { quoteId: "Q-OWN", quoteStatus: "awaiting", renewalQuoteId: "Q-REN", renewalQuoteStatus: "none" };
    expect(duesPaymentRoute(row({ quote_id: "Q-OTHER" }), links)).toEqual({ kind: "quote", quoteId: "Q-REN" });
  });

  it("the subscription's own quote beats another quote of the same customer", () => {
    const links = { quoteId: "Q-OWN", quoteStatus: "partial", renewalQuoteId: null, renewalQuoteStatus: null };
    expect(duesPaymentRoute(row({ quote_id: "Q-OTHER" }), links)).toEqual({ kind: "quote", quoteId: "Q-OWN" });
  });

  it("no quote at all (import / Correct details) → blocked with a reason and a link", () => {
    const links = { quoteId: null, quoteStatus: null, renewalQuoteId: null, renewalQuoteStatus: null };
    const r = duesPaymentRoute(row(), links);
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.reason).toMatch(/has no quote/i);
    expect(r.fixHref).toBe("/subscriptions?q=Loudleaf");
  });

  it("own quote already fully received → blocked (recording would only make advance credit)", () => {
    const links = { quoteId: "Q-OWN", quoteStatus: "received", renewalQuoteId: null, renewalQuoteStatus: null };
    const r = duesPaymentRoute(row(), links);
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.reason).toMatch(/Q-OWN/);
  });

  it("links still loading and no customer quote → waits", () => {
    expect(duesPaymentRoute(row(), undefined)).toEqual({ kind: "loading" });
  });
});

describe("DuesPayButton", () => {
  it("says Record payment with the received-money hint, never Pay", () => {
    render(<DuesPayButton route={{ kind: "quote", quoteId: "Q-1" }} onRecord={() => {}} />);
    const btn = screen.getByRole("button", { name: /Record payment/ });
    expect(btn.textContent).toContain(DUES_PAY_LABEL);
    expect(btn.getAttribute("title")).toBe(DUES_PAY_HINT);
    expect(DUES_PAY_HINT).toBe("Customer ne paisa diya — yahan darj karo");
    expect(screen.queryByRole("button", { name: /^Pay$/ })).toBeNull();
  });

  it("a row without a customer quote opens the subscription's own quote payment", () => {
    const onRecord = vi.fn();
    const links = { quoteId: "Q-OWN", quoteStatus: "awaiting", renewalQuoteId: null, renewalQuoteStatus: null };
    render(<DuesPayButton route={duesPaymentRoute(row(), links)} onRecord={onRecord} />);
    fireEvent.click(screen.getByRole("button", { name: /Record payment/ }));
    expect(onRecord).toHaveBeenCalledWith("Q-OWN");
  });

  it("blocked: disabled button, the reason in words, and a link to fix it", () => {
    const onRecord = vi.fn();
    const links = { quoteId: null, quoteStatus: null, renewalQuoteId: null, renewalQuoteStatus: null };
    render(<DuesPayButton route={duesPaymentRoute(row(), links)} onRecord={onRecord} />);
    const btn = screen.getByRole("button", { name: /Record payment/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onRecord).not.toHaveBeenCalled();
    expect(screen.getByText(/has no quote/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: /Subscriptions/ });
    expect(link.getAttribute("href")).toBe("/subscriptions?q=Loudleaf");
  });
});

describe("payments page wiring", () => {
  const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

  it("no 'Pay' label left for this action", () => {
    expect(src).not.toMatch(/>\s*Pay\s*</);
    expect(DUES_PAY_LABEL).toBe("Record payment");
  });

  it("both the phone list and the desktop table use DuesPayButton, not a quote-only button", () => {
    expect((src.match(/<DuesPayButton/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/o\.quote_id && canWrite/);
    expect(src).not.toMatch(/onRecordPayment=\{o\.quote_id/);
  });
});
