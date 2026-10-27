/**
 * R-2010 (27 Oct 2026, G-DPDP): at checkout the visitor's consent id (anon_id) is tied to the
 * lead and quote the order creates — one more insert-only consent_events row (source
 * "checkout") carrying the choice in force when they bought.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { consentCheckoutRow } from "./record.server";

const ANON = "3f2b6c1e-8d4a-4b7e-9a51-2c7d8e9f0a1b";

describe("R-2010 consent ↔ lead/quote at checkout", () => {
  it("builds the checkout row with lead, quote, the choice in force and a hashed IP", () => {
    const row = consentCheckoutRow({
      tenantId: "T-WEB", anonId: ANON, leadId: "L-ABC", quoteId: "Q-1", metaConsent: false,
      ip: "1.2.3.4", userAgent: "UA", secret: Buffer.alloc(32, 7).toString("base64"),
    });
    expect(row).toMatchObject({ tenant_id: "T-WEB", anon_id: ANON, lead_id: "L-ABC", quote_id: "Q-1", purpose: "meta_ads", choice: "denied", source: "checkout", user_agent: "UA" });
    expect(row!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("no anon id (old browser tab, storage blocked) → no row", () => {
    expect(consentCheckoutRow({ tenantId: "T", anonId: "not-a-uuid", leadId: "L", quoteId: "Q", metaConsent: true, ip: null, userAgent: null, secret: "" })).toBeNull();
  });

  it("the checkout route writes it after the quote is saved; the buy page sends the anon id", () => {
    const route = readFileSync("src/app/api/public/checkout/workspace/route.ts", "utf8");
    expect(route).toMatch(/recordCheckoutConsent\(admin, \{[\s\S]{0,200}?leadId, quoteId,/);
    const submit = readFileSync("src/app/(public)/buy/workspace/_parts/submit-order.ts", "utf8");
    expect(submit).toMatch(/consentAnonId: consentAnonId\(\)/);
  });
});
