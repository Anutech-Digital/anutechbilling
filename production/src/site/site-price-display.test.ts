/**
 * R-1465 (16 Oct 2026, Pawan's staging report): the public site printed hosting at ₹99.98,
 * ₹374.40 and ₹187.20 a month, and the quote builder showed paise on some lines (₹599.88) and
 * not on others. Rule now: every price on the public site is WHOLE RUPEES through one
 * formatter (`rupee`, site/lib/money.ts), and a hosting figure that is charged is shown as the
 * very number checkout charges.
 *
 * Display only — the catalogue (LANDING_PLANS) and what checkout charges are unchanged; the
 * "charges unchanged" block below pins them.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { rupee } from "@/site/lib/money";
import { quoteInr, quoteLineAmount, QUOTE_PRODUCTS } from "@/site/lib/data/quote-catalog";
import { HOSTING_TIERS, HOSTING_FROM_MO, hostingCardPrices } from "@/site/lib/data/hosting-landing-v2";
import { LANDING_PLANS } from "@/site/lib/data/hosting-landing";
import { buildRateCard } from "@/site/lib/rate-card";
import { hostingRate, hostingPriceTable } from "@/lib/checkout/hosting-prices";
import { paidHostingLine } from "@/site/lib/hosting-cart-line";

const tier = (name: string) => HOSTING_TIERS.find((t) => t.name === name)!;

describe("R-1465 one whole-rupee formatter on the site", () => {
  it("the quote builder prints whole rupees (₹50, not ₹49.99)", () => {
    expect(quoteInr(49.99)).toBe("₹50");
    expect(quoteInr(374.4)).toBe("₹374");
    expect(quoteInr(599.88)).toBe("₹600");
    for (const n of [0, 79, 1080, 2246.4, 123456.5]) expect(quoteInr(n)).toBe(rupee(n));
  });

  it("/rates hosting rows carry no paise", () => {
    const rows = buildRateCard({ tlds: [], hosting: HOSTING_TIERS, editions: [], mailRates: {}, certs: [] })
      .find((s) => s.id === "hosting")!.rows;
    for (const r of rows) for (const c of r.cells) expect(c, r.name).not.toMatch(/\.\d/);
    expect(rows.find((r) => r.name === "Starter")!.cells).toEqual(["₹100", "₹50", "₹600"]);
    expect(rows.find((r) => r.name === "Plus")!.cells).toEqual(["₹374", "₹187", "₹2,246"]);
  });

  it("the hosting 'from' price is whole rupees", () => {
    expect(HOSTING_FROM_MO).toBe("₹50");
  });

  it("hosting plan cards: per-month, billed and pay-today in whole rupees", () => {
    expect(hostingCardPrices(tier("Starter"), false)).toEqual({ perMonth: "₹100", billed: "₹100", payToday: "₹118" });
    expect(hostingCardPrices(tier("Starter"), true)).toEqual({ perMonth: "₹50", billed: "₹600", payToday: "₹708" });
    expect(hostingCardPrices(tier("Plus"), false)).toEqual({ perMonth: "₹374", billed: "₹374", payToday: "₹441" });
  });

  it("no site source formats rupees with paise", () => {
    const roots = [join(__dirname), join(__dirname, "..", "app", "(marketing)")];
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(f) || /\.test\.tsx?$/.test(f)) continue;
        const src = readFileSync(p, "utf8");
        if (/minimumFractionDigits:\s*[^0]|toFixed\(2\)/.test(src)) hits.push(`${p}: paise formatter`);
        // "₹6.3L" / "₹69.4K" (compact demo figures) are not paise.
        if (/["'`][^"'`\n]*₹\d[\d,]*\.\d+(?![\dKL])/.test(src)) hits.push(`${p}: paise in a price string`);
      }
    };
    for (const r of roots) walk(r);
    expect(hits).toEqual([]);
  });
});

describe("R-1465 charges unchanged — display follows the charge, never the other way", () => {
  it("catalogue rates are the same as before", () => {
    expect(LANDING_PLANS.map((p) => p.price)).toEqual([49.99, 125, 187.2]);
  });

  it("checkout's hosting rates are the same as before", () => {
    expect(["starter", "standard", "plus"].map((t) => [hostingRate(t, true), hostingRate(t, false)])).toEqual([
      [600, 100], [1500, 250], [2246, 374],
    ]);
    expect(hostingPriceTable().map((p) => [p.yearly.inclGst, p.monthly.inclGst])).toEqual([
      [708, 118], [1770, 295], [2650, 441],
    ]);
  });

  it("the cart line still carries the charged whole-rupee rate", () => {
    for (const t of HOSTING_TIERS) for (const yearly of [true, false]) {
      expect(paidHostingLine(t, yearly).unitPrice).toBe(hostingRate(t.name, yearly));
    }
  });

  it("each plan card shows exactly what checkout charges", () => {
    for (const p of hostingPriceTable()) for (const yearly of [true, false]) {
      const shown = hostingCardPrices(tier(p.name), yearly);
      const charged = yearly ? p.yearly : p.monthly;
      expect(shown.billed, p.name).toBe(rupee(charged.exGst));
      expect(shown.payToday, p.name).toBe(rupee(charged.inclGst));
    }
  });

  it("a hosting line on /quote totals what checkout charges for it", () => {
    for (const t of HOSTING_TIERS) {
      const q = QUOTE_PRODUCTS.find((p) => p.label === `Web hosting — ${t.name}`)!;
      expect(quoteLineAmount(q.annual, 1, 12), t.name).toBe(hostingRate(t.name, true));
      expect(quoteLineAmount(q.monthly!, 1, 1), t.name).toBe(hostingRate(t.name, false));
    }
  });
});
