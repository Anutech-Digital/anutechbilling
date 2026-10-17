/**
 * R-1483 (+ R-1482, R-1484) — the "Renews ₹X/yr" line on the website quote page (/quote).
 *
 * Pawan, staging 17 Oct 2026, Flexible monthly: GW Business Starter × 3 + Hosting Starter × 7
 * showed "Payable ₹1,977" but "Renews ₹23,716/yr" — ₹1,977 × 12 is ₹23,724. The year was
 * rebuilt from ONE year-long line (hosting ₹99.98 × 7 × 12 rounded once, GST rounded once),
 * while the customer is really billed twelve monthly invoices, each rounded on its own.
 * R-1482: hosting ₹49.99 × 7 sites × 12 rounded once = ₹4,199, while checkout charges a site
 * ₹600 a year (hostingRate) — 7 sites = ₹4,200. R-1484: a domain registration "renewed" at
 * its registration price; it renews at the extension's renewal price.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QUOTE_PRODUCTS, QUOTE_TLDS, quoteLineAmount, quoteRenewal, quoteUnitAmount } from "./quote-catalog";
import { hostingRate, hostingPriceTable } from "@/lib/checkout/hosting-prices";
import { gstBreakup } from "@/lib/quotes/amounts";

const prod = (name: string) => QUOTE_PRODUCTS.find((p) => p.name === name)!;
const gw = prod("GW Business Starter");
const host = prod("Hosting Starter");
const reg = prod("Domain registration");
const dotIn = QUOTE_TLDS.find((t) => t.tld === ".in")!;

describe("R-1483: the renewal line agrees with the payable it sits under", () => {
  it("Flexible monthly — ₹1,977 a month renews at ₹1,977 × 12 = ₹23,724 a year", () => {
    const lines = [
      { cycle: gw.cycle, qty: 3, rate: gw.monthly!, renewRate: gw.monthly! },
      { cycle: host.cycle, qty: 7, rate: host.monthly!, renewRate: host.monthly! },
    ];
    const monthSubtotal = lines.reduce((n, l) => n + quoteLineAmount(l.rate, l.qty, 1), 0);
    expect(gstBreakup(monthSubtotal).total).toBe(1977); // the payable on the page
    const r = quoteRenewal(lines, "monthly");
    expect(r.perMonth).toBe(1977);
    expect(r.perYear).toBe(23724);
    expect(r.perYear).toBe(r.perMonth! * 12);
  });

  it("Flexible monthly with a yearly item — months × 12 plus the yearly item once", () => {
    const lines = [
      { cycle: gw.cycle, qty: 3, rate: gw.monthly!, renewRate: gw.monthly! },
      { cycle: reg.cycle, qty: 1, rate: dotIn.reg, renewRate: dotIn.renew },
    ];
    const r = quoteRenewal(lines, "monthly");
    expect(r.perMonth).toBe(gstBreakup(975).total);
    expect(r.yearlyOnce).toBe(gstBreakup(dotIn.renew).total);
    expect(r.perYear).toBe(r.perMonth! * 12 + r.yearlyOnce);
  });
});

describe("R-1482: a hosting line is per-site × sites, as checkout charges it", () => {
  it("7 Starter sites a year = 7 × ₹600 = ₹4,200 (was ₹4,199)", () => {
    expect(quoteUnitAmount(host.annual, 12)).toBe(600);
    expect(quoteLineAmount(host.annual, 7, 12)).toBe(4200);
    expect(quoteLineAmount(host.annual, 7, 12)).toBe(7 * hostingRate("Starter", true)!);
  });

  it("every tier, both cycles, any count: line = checkout's per-site rate × sites", () => {
    for (const p of QUOTE_PRODUCTS.filter((x) => x.vendor === "Web hosting")) {
      const tier = p.name.replace("Hosting ", "");
      for (const qty of [1, 2, 3, 7, 10]) {
        expect(quoteLineAmount(p.annual, qty, 12), `${tier} ×${qty}`).toBe(hostingRate(tier, true)! * qty);
        expect(quoteLineAmount(p.monthly!, qty, 1), `${tier} ×${qty}`).toBe(hostingRate(tier, false)! * qty);
      }
    }
  });
});

describe("R-1484: a domain renews at the extension's renewal price", () => {
  it(".in registration ₹499 renews at ₹799 (annual commitment)", () => {
    const r = quoteRenewal([{ cycle: reg.cycle, qty: 1, rate: dotIn.reg, renewRate: dotIn.renew }], "annual");
    expect(r.perYear).toBe(gstBreakup(799).total);
    expect(r.perMonth).toBeNull();
  });

  it("annual commitment: monthly-cycle lines ×12 per unit, yearly items at renewal rate, one GST", () => {
    const r = quoteRenewal([
      { cycle: gw.cycle, qty: 3, rate: gw.annual, renewRate: gw.annual },
      { cycle: host.cycle, qty: 7, rate: host.annual, renewRate: host.annual },
      { cycle: reg.cycle, qty: 1, rate: dotIn.reg, renewRate: dotIn.renew },
    ], "annual");
    expect(r.perYear).toBe(gstBreakup(270 * 12 * 3 + 600 * 7 + 799).total);
  });
});

describe("/quote uses these helpers", () => {
  it("the renewal line and the unit shown come from quoteRenewal / quoteUnitAmount", () => {
    const src = readFileSync(resolve(__dirname, "../../components/quote/QuoteBuilder.tsx"), "utf8");
    expect(src).toContain("quoteRenewal(");
    expect(src).toContain("quoteUnitAmount(");
    expect(src).not.toMatch(/Renews \{inr\(renewal\)\}/);
  });
});

describe("charge path unchanged — display only", () => {
  it("checkout's hosting prices are the same figures as before this card", () => {
    expect(hostingPriceTable().map((p) => [p.id, p.yearly.exGst, p.yearly.inclGst, p.monthly.exGst, p.monthly.inclGst])).toEqual([
      ["starter", 600, 708, 100, 118],
      ["standard", 1500, 1770, 250, 295],
      ["plus", 2246, 2650, 374, 441],
    ]);
  });
});
