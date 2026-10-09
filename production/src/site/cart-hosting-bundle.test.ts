/**
 * The ₹0-domain bundle follows the cart's contents (9 Oct 2026), exactly as the server applies
 * it. Found by the 9 Oct re-test: a 3-year .in added on its own, then two yearly Standard plans —
 * the cart said ₹6,594, checkout charged ₹5,576 and told the customer a registry price had moved.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyHostingBundle, cartTotals, hasYearlyHostingLine, type CartLine } from "@/site/lib/money";
import { bundledDomainRate } from "@/lib/checkout/cart-checkout";
import { MAILBOX_YR } from "@/site/lib/data/domains-landing";

const PRICES = { "1": 863, "2": 1726, "3": 2588, "5": 4314 };
const domain = (over: Partial<CartLine> = {}): CartLine => ({
  key: "d", label: "shop.in", detail: "Registration, 3 years", unitPrice: 2588, qty: 1, unit: "year", cycle: "yearly",
  sku: "domain:in", domain: "shop.in", years: 3, yearPrices: PRICES, ...over,
});
const plan = (cycle: CartLine["cycle"] = "yearly", sku = "hosting:standard"): CartLine => ({
  key: `h-${cycle}-${sku}`, label: "Standard hosting", detail: "", unitPrice: 1500, qty: 1, unit: "year", cycle, sku,
});
const mailbox = (): CartLine => ({ key: "m", label: "Mailbox on shop.in", detail: "Anutech Mail · billed yearly", unitPrice: MAILBOX_YR, qty: 1, unit: "year", cycle: "yearly", sku: "mailbox:anutech" });

describe("applyHostingBundle", () => {
  it("a domain added on its own gets its first year free once a yearly plan is in the cart", () => {
    const out = applyHostingBundle([plan(), plan(), domain()]);
    const d = out[2];
    expect(d.unitPrice).toBe(1725); // 2588 − 863, years 2 and 3 paid
    expect(d.bundleFree).toBe(true);
    expect(d.detail).toMatch(/first year free with yearly hosting/);
    // The case the re-test found: what the cart says is what checkout charges.
    expect(Math.round(cartTotals(out, 0).payable)).toBe(5576); // shown and charged rounded
  });

  it("the same number the server charges, for every term", () => {
    for (const years of [1, 2, 3, 5]) {
      const d = applyHostingBundle([plan(), domain({ years })])[1];
      expect(d.unitPrice).toBe(bundledDomainRate(PRICES[String(years) as "1"], PRICES["1"]));
    }
  });

  it("removing the plan charges the domain in full again, and the note goes", () => {
    const bundled = applyHostingBundle([plan(), domain({ years: 1, unitPrice: 863 })])[1];
    expect(bundled.unitPrice).toBe(0);
    const alone = applyHostingBundle([bundled])[0];
    expect(alone.unitPrice).toBe(863);
    expect(alone.bundleFree).toBeUndefined();
    expect(alone.detail).not.toMatch(/free/);
  });

  it("a monthly plan or a free trial does not bundle — only a yearly hosting plan", () => {
    expect(applyHostingBundle([plan("monthly"), domain()])[1].unitPrice).toBe(2588);
    expect(applyHostingBundle([plan("yearly", "hosting-trial:starter"), domain()])[1].unitPrice).toBe(2588);
    expect(hasYearlyHostingLine([plan("monthly")])).toBe(false);
  });

  it("the mailbox is ₹0 with a yearly plan and full price without", () => {
    expect(applyHostingBundle([plan(), mailbox()])[1].unitPrice).toBe(0);
    expect(applyHostingBundle([applyHostingBundle([plan(), mailbox()])[1]])[0].unitPrice).toBe(MAILBOX_YR);
  });

  it("an old 1-year line without term prices keeps its own price, and is left alone when unknown", () => {
    const old = domain({ years: undefined, yearPrices: undefined, unitPrice: 999 });
    expect(applyHostingBundle([plan(), old])[1].unitPrice).toBe(0);
    expect(applyHostingBundle([old])[0].unitPrice).toBe(999);
    const unknown = domain({ years: 3, yearPrices: { "1": 863 } });
    expect(applyHostingBundle([plan(), unknown])[1]).toBe(unknown);
  });

  it("changes nothing when there is nothing to change (same objects back)", () => {
    const lines = [plan(), domain({ years: 1, unitPrice: 0, bundleFree: true, detail: "Registration, 1 year · first year free with yearly hosting" })];
    const out = applyHostingBundle(lines);
    expect(out[1]).toBe(lines[1]);
  });
});

describe("wiring", () => {
  it("every cart change and the load go through the bundle before being saved", () => {
    const src = readFileSync(join(process.cwd(), "src/site/components/cart/CartProvider.tsx"), "utf8");
    expect(src).toContain("setLines(applyHostingBundle(load()))");
    expect(src.match(/save\(next\)/g)).toBeNull();
    expect((src.match(/save\(done\)/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});
