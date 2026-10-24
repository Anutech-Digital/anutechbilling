import { describe, it, expect } from "vitest";
import { buildCustomerQuoteHtml, buildSalesAcknowledgementHtml } from "./quote-template";

/* R-734: names come from enquiry/checkout forms — a visitor-typed "<a href=…>" must reach the
   inbox as text, never as a live link sent from our domain. */
const EVIL = `<a href="https://evil.example">Click</a>`;
const ESCAPED = "&lt;a href=&quot;https://evil.example&quot;&gt;Click&lt;/a&gt;";

describe("R-734 — quote emails escape every interpolated value", () => {
  it("customer quote: customer, tenant, item name, phone, label, expiry are text", () => {
    const html = buildCustomerQuoteHtml({
      quoteId: `Q-1${EVIL}`, customerName: EVIL, tenantName: EVIL, tenantPhone: EVIL,
      totalAmount: 1000, expiresDate: EVIL, acceptUrl: "https://app.example/q/1?a=1&b=2",
      lineItems: [{ name: EVIL, qty: 1, rate: 1000, notes: [EVIL] }], documentLabel: EVIL,
    });
    expect(html).not.toContain(EVIL);
    expect(html).toContain(ESCAPED);
    expect(html).toContain('href="https://app.example/q/1?a=1&amp;b=2"');
  });

  it("customer quote: a javascript: accept URL is never made a link", () => {
    const html = buildCustomerQuoteHtml({
      quoteId: "Q-1", customerName: "A", tenantName: "B", totalAmount: 1, acceptUrl: "javascript:alert(1)",
    });
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("sales acknowledgement: customer and tenant names are text", () => {
    const html = buildSalesAcknowledgementHtml({
      quoteId: "Q-1", customerName: EVIL, tenantName: EVIL, totalAmount: 1, acceptedAt: EVIL,
    });
    expect(html).not.toContain(EVIL);
    expect(html).toContain(ESCAPED);
  });
});
