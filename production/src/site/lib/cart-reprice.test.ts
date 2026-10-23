/**
 * R-1797 — a saved cart is re-priced from the price book (GET /api/public/catalog) when the
 * cart page and checkout open, and the checkout's "Buy Starter instead" line takes the book's
 * price. CATALOG_FROM_DB off (source "code") → nothing changes, exactly as before.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cartPricesFromCatalog, priceChangeNotice, repriceCartLines, tierWithPrices, type CartPrices } from "./cart-reprice";
import { paidHostingLine } from "./hosting-cart-line";
import { HOSTING_TIERS } from "./data/hosting-landing-v2";
import { MAILBOX_YR } from "./data/domains-landing";
import type { CartLine } from "./money";

const starter = HOSTING_TIERS.find((t) => t.name === "Starter")!;
const item = (sku: string, exGst: number) => ({ sku, exGst });
const catalogBody = (source: "code" | "catalog", over: Record<string, number> = {}) => ({
  gstRate: 18,
  source,
  items: [
    item("HOST-STARTER-YR", over["HOST-STARTER-YR"] ?? 600),
    item("HOST-STARTER-MO", over["HOST-STARTER-MO"] ?? 100),
    item("HOST-STANDARD-YR", 1500),
    item("HOST-STANDARD-MO", 250),
    item("MAIL-ANUTECH-YR", over["MAIL-ANUTECH-YR"] ?? 948),
    item("SSL-POSITIVE-YR", 899),
  ],
});

const starterLine = (yearly = true): CartLine => ({ key: "h1", qty: 1, ...paidHostingLine(starter, yearly) });
const mailboxLine = (qty: number, unitPrice = MAILBOX_YR): CartLine => ({
  key: "m1", label: "Mailbox", detail: "Anutech Mail · billed yearly", unitPrice, qty, unit: "year", cycle: "yearly", sku: "mailbox:anutech",
});
const domainLine: CartLine = { key: "d1", label: "acme.in", detail: "Domain registration · 1 year", unitPrice: 749, qty: 1, unit: "year", cycle: "yearly", sku: "domain:in", domain: "acme.in" };

describe("cartPricesFromCatalog", () => {
  it("flag off (source code) → null: the cart is left exactly as it is today", () => {
    expect(cartPricesFromCatalog(catalogBody("code", { "HOST-STARTER-YR": 610 }))).toBeNull();
  });

  it("flag on → hosting per tier and cycle, and the mailbox", () => {
    const p = cartPricesFromCatalog(catalogBody("catalog", { "HOST-STARTER-YR": 610 }))!;
    expect(p.hosting.starter).toEqual({ yearly: 610, monthly: 100 });
    expect(p.mailboxYearly).toBe(948);
  });

  it("junk, ₹0 and negative prices are ignored — never ₹0 in the cart", () => {
    const p = cartPricesFromCatalog({ source: "catalog", items: [item("HOST-STARTER-YR", 0), item("HOST-STARTER-MO", -5), item("MAIL-ANUTECH-YR", Number.NaN), { sku: 5 }] })!;
    expect(p.hosting.starter).toBeUndefined();
    expect(p.mailboxYearly).toBeNull();
    expect(cartPricesFromCatalog(null)).toBeNull();
    expect(cartPricesFromCatalog("oops")).toBeNull();
  });
});

describe("repriceCartLines (gap 2: a cart saved before a price change)", () => {
  const prices = cartPricesFromCatalog(catalogBody("catalog", { "HOST-STARTER-YR": 610, "MAIL-ANUTECH-YR": 999 }))!;

  it("a Starter line saved at ₹600 becomes ₹610, and the change is reported", () => {
    const r = repriceCartLines([starterLine(), mailboxLine(3), domainLine], prices);
    expect(r.lines[0].unitPrice).toBe(610);
    expect(r.lines[1].unitPrice).toBe(999);
    expect(r.lines[2]).toBe(domainLine); // domains are priced live, not by the book
    expect(r.changes).toEqual([
      { key: "h1", label: "Starter hosting", from: 600, to: 610, unit: "year" },
      { key: "m1", label: "Mailbox", from: 948, to: 999, unit: "year" },
    ]);
  });

  it("a monthly line takes the monthly price", () => {
    const p: CartPrices = { hosting: { starter: { yearly: 600, monthly: 120 } }, mailboxYearly: null };
    expect(repriceCartLines([starterLine(false)], p).lines[0].unitPrice).toBe(120);
  });

  it("nothing changed → the same array, no changes (no re-render loop)", () => {
    const lines = [starterLine(), mailboxLine(1)];
    const same = cartPricesFromCatalog(catalogBody("catalog"))!;
    const r = repriceCartLines(lines, same);
    expect(r.lines).toBe(lines);
    expect(r.changes).toEqual([]);
  });

  it("a SKU the book does not price keeps its line price (never ₹0)", () => {
    const r = repriceCartLines([starterLine(), mailboxLine(1)], { hosting: {}, mailboxYearly: null });
    expect(r.lines[0].unitPrice).toBe(600);
    expect(r.lines[1].unitPrice).toBe(MAILBOX_YR);
  });

  it("the notice is one line: what changed, from and to", () => {
    expect(priceChangeNotice([])).toBeNull();
    expect(priceChangeNotice([{ key: "h1", label: "Starter hosting", from: 600, to: 610, unit: "year" }])).toBe(
      "Price changed: Starter hosting ₹600 → ₹610. The total below is what you will pay.",
    );
    expect(priceChangeNotice([
      { key: "h1", label: "Starter hosting", from: 600, to: 610, unit: "year" },
      { key: "m1", label: "Mailbox", from: 948, to: 999, unit: "year" },
    ])).toBe("Prices changed: Starter hosting ₹600 → ₹610, Mailbox ₹948 → ₹999. The total below is what you will pay.");
  });
});

describe("tierWithPrices (gap 1: checkout's 'Buy Starter instead')", () => {
  it("flag on, Starter at ₹610 → the line is ₹610, not the code ₹600", () => {
    const prices = cartPricesFromCatalog(catalogBody("catalog", { "HOST-STARTER-YR": 610 }))!;
    expect(paidHostingLine(tierWithPrices(starter, prices), true).unitPrice).toBe(610);
    expect(paidHostingLine(tierWithPrices(starter, prices), false).unitPrice).toBe(100);
  });

  it("no book (flag off or not read yet) → the code tier, unchanged", () => {
    expect(tierWithPrices(starter, null)).toBe(starter);
  });

  it("the checkout page builds that line from the book, and the cart page + checkout show the notice", () => {
    const root = join(__dirname, "..", "..", "app", "(marketing)");
    const checkout = readFileSync(join(root, "checkout", "page.tsx"), "utf8");
    expect(checkout).toMatch(/tierWithPrices\(codeTier, cart\.prices\)/);
    expect(checkout).toMatch(/<PriceChangeNotice changes=\{cart\.priceChanges\} \/>/);
    expect(readFileSync(join(root, "cart", "page.tsx"), "utf8")).toMatch(/<PriceChangeNotice changes=\{cart\.priceChanges\} \/>/);
  });
});
