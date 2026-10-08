import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  subscriptionHref, subscriptionStatusLabel, paymentHref, initialSubscriptionSearch,
} from "./palette-links";

describe("R-244: Ctrl+K lands on the row it named", () => {
  it("a subscription opens the list filtered by its domain, else its customer", () => {
    expect(subscriptionHref({ domain: "acme.in", customer_name: "Acme Pvt Ltd" })).toBe("/subscriptions?q=acme.in");
    expect(subscriptionHref({ domain: null, customer_name: "Acme & Sons" })).toBe("/subscriptions?q=Acme%20%26%20Sons");
    expect(subscriptionHref({ domain: "  ", customer_name: "  " })).toBe("/subscriptions");
  });

  it("a payment opens that customer's receipts when the customer is known", () => {
    expect(paymentHref({ customer_id: "c-1" })).toBe("/payments?customer=c-1");
    expect(paymentHref({ customer_id: null })).toBe("/payments");
  });

  it("the subscriptions page reads ?q= into its search box", () => {
    expect(initialSubscriptionSearch("?q=acme.in&tab=all")).toBe("acme.in");
    expect(initialSubscriptionSearch("?q=Acme%20%26%20Sons")).toBe("Acme & Sons");
    expect(initialSubscriptionSearch("")).toBe("");
  });

  it("status reads as a word, never a stored code", () => {
    expect(subscriptionStatusLabel("active")).toBe("Active");
    expect(subscriptionStatusLabel("paused")).toBe("Suspended");
    expect(subscriptionStatusLabel("pending_renewal")).toBe("Pending renewal");
    expect(subscriptionStatusLabel(null)).toBe("");
  });

  it("the palette uses these links and labels, not the bare list or raw codes", () => {
    const src = readFileSync(join(process.cwd(), "src/components/layout/command-palette.tsx"), "utf8");
    expect(src).not.toMatch(/go\("\/subscriptions"\)/);
    expect(src).not.toMatch(/go\("\/payments"\)/);
    expect(src).not.toMatch(/\[amount, p\.method,/);
    expect(src).not.toMatch(/\[s\.plan, mrr, s\.status\]/);
  });

  it("the subscriptions page pre-fills its search from ?q=", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/subscriptions/page.tsx"), "utf8");
    expect(src).toMatch(/initialSubscriptionSearch\(/);
  });
});

describe("R-244: picking a subscription while already on the page", () => {
  it("the href's search is recoverable for the same-page event", async () => {
    const { searchFromSubscriptionHref } = await import("./palette-links");
    expect(searchFromSubscriptionHref("/subscriptions?q=Acme%20%26%20Sons")).toBe("Acme & Sons");
    expect(searchFromSubscriptionHref("/subscriptions")).toBe("");
  });
});
