/**
 * R-1965 (Pardeep, 26 Oct 2026): the /buy/workspace calculator led with "₹3,823 /year incl 18% GST"
 * and "Effective ₹319/user/month incl GST" — a ₹270 plan read as ₹319. The big number is now the
 * pre-GST yearly total, the rate × users × 12 sum is spelled out with how it is billed, and GST
 * sits on its own small line with the total. Display only: the amount checkout charges is unchanged.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { priceHeadline } from "./price-headline";
import { annualTotals, tierAnnualPrice } from "./tier-price";
import { buildLinesFromCatalog, type CatalogPriceRow } from "@/app/api/public/checkout/workspace/pricing";

const row = (name: string, annual: number): CatalogPriceRow => ({
  id: name, name, msrp: annual, wholesale: null,
  prices: { annual: { msrp: annual, wholesale: 0 } },
});

const sums = (t: { annual: number; gst: number; total: number }) => ({ subtotal: t.annual, gst: t.gst, total: t.total });

describe("R-1965 price headline: pre-GST yearly total, GST on its own line", () => {
  it("Starter, 1 user: ₹3,240 /year + GST, the sum, and + ₹583 GST (18%) · Total ₹3,823", () => {
    const t = sums(annualTotals(1, 270));
    const h = priceHeadline({ rate: 270, seats: 1, billing: "annual", ...t });
    expect(h.big).toBe("₹3,240");
    expect(h.bigSuffix).toBe("/year + GST");
    expect(h.breakdown).toBe("₹270/user/month × 1 user × 12 · Billed annually (1-year commitment)");
    expect(h.gstLine).toBe("+ ₹583 GST (18%) · Total ₹3,823");
    expect(h.was).toBeNull();
  });

  it("10 users: every number moves with the seat count", () => {
    const t = sums(annualTotals(10, 270));
    const h = priceHeadline({ rate: 270, seats: 10, billing: "annual", ...t });
    expect(h.big).toBe("₹32,400");
    expect(h.breakdown).toBe("₹270/user/month × 10 users × 12 · Billed annually (1-year commitment)");
    expect(h.gstLine).toBe("+ ₹5,832 GST (18%) · Total ₹38,232");
  });

  it("monthly (flexible) billing says Billed monthly", () => {
    const t = sums(annualTotals(2, 325));
    const h = priceHeadline({ rate: 325, seats: 2, billing: "monthly", ...t });
    expect(h.breakdown).toBe("₹325/user/month × 2 users × 12 · Billed monthly");
  });

  it("site promo: struck old and new big numbers are both pre-GST; GST line uses the post-promo sums", () => {
    const before = annualTotals(1, 270);           // 3,240 pre-GST
    const subtotal = before.annual - 324;          // a 10% promo → 2,916
    const gst = Math.round(subtotal * 0.18);       // the page's heroFinalGst rounding
    const h = priceHeadline({ rate: 270, seats: 1, billing: "annual", subtotal, gst, total: subtotal + gst, wasSubtotal: before.annual });
    expect(h.big).toBe("₹2,916");
    expect(h.was).toBe("₹3,240");
    expect(h.gstLine).toBe("+ ₹525 GST (18%) · Total ₹3,441");
  });

  it("the Total on the GST line is exactly what checkout charges (server builder)", () => {
    for (const [slug, name, seats] of [
      ["starter", "Google Workspace Business Starter", 1],
      ["starter", "Google Workspace Business Starter", 10],
      ["standard", "Google Workspace Business Standard", 7],
      ["plus", "Google Workspace Business Plus", 3],
    ] as const) {
      const rate = tierAnnualPrice(slug, 1);
      const t = sums(annualTotals(seats, rate));
      const h = priceHeadline({ rate, seats, billing: "annual", ...t });
      const server = buildLinesFromCatalog(row(name, 1), slug, seats);
      expect(h.gstLine).toContain(`Total ₹${server.amount.toLocaleString("en-IN")}`);
      expect(h.big).toBe(`₹${server.subtotal.toLocaleString("en-IN")}`);
    }
  });

  it("the calculator uses the headline and no longer leads with an incl-GST price", () => {
    const src = readFileSync(join(__dirname, "buy-workspace-client.tsx"), "utf8");
    expect(src).toMatch(/priceHeadline\(/);
    expect(src).not.toMatch(/\/year incl 18% GST/);
    expect(src).not.toMatch(/Effective ₹/);
  });
});
