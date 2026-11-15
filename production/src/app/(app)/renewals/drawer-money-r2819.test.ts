/**
 * R-2819 — Renewals drawer: Customer pays / Our cost / Margin (drawer-money.ts).
 * Cost = the renewal quote's own catalogue pick + arithmetic (R-2736); pays = the row's amount (R-2751).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { booksRupeeLine, drawerMoney, mayShowRenewalCost, renewalCostForSub } from "./drawer-money";
import { renewalAmount } from "./queue";
import { renewalCatalogCost, type RenewalCatalogRow } from "@/lib/renewals/renewal-catalog-cost";

const row = (o: Partial<RenewalCatalogRow> & { id: string; name: string }): RenewalCatalogRow =>
  ({ vendor: "google", msrp: 0, wholesale: 0, prices: {}, is_active: true, ...o });
/* E2E Test Co's catalogue rows (R-2736's fixture). */
const GW_STD = row({ id: "E2E-GW-STD", name: "E2E Google Workspace Business Standard", msrp: 736, wholesale: 620 });
const GW_STR = row({ id: "E2E-GW-STR", name: "E2E Google Workspace Business Starter", msrp: 136, wholesale: 110 });
const DOM_IN = row({ id: "DOM-IN", name: "Domain .in", vendor: "domain", msrp: 800, wholesale: 600, prices: { billing_unit: "unit_year" } });
const CATALOG = [GW_STR, GW_STD, DOM_IN];

const SUB = { plan: "Google Workspace Business Standard", seats: 20, vendor: "google", item_id: null, term_months: 12, mrr: 17000, term_amount: null };

describe("R-2819 who sees cost", () => {
  it("owner and manager (the catalogue's roles) see it; billing / support / sales / no role do not", () => {
    expect(mayShowRenewalCost("owner")).toBe(true);
    expect(mayShowRenewalCost("manager")).toBe(true);
    for (const r of ["billing", "support", "sales", "accountant", null, undefined]) expect(mayShowRenewalCost(r)).toBe(false);
  });
});

describe("R-2819 our cost = the renewal quote's cost (R-2736, no second formula)", () => {
  it("plan with no item_id → the confident catalogue match × 12 months × 20 seats", () => {
    const c = renewalCostForSub(CATALOG, SUB);
    expect(c).toEqual(renewalCatalogCost(GW_STD, { termMonths: 12, seats: 20 }));
    expect(c.total).toBe(148800);
  });
  it("item_id wins", () => {
    expect(renewalCostForSub(CATALOG, { ...SUB, item_id: "E2E-GW-STR" }).total).toBe(110 * 12 * 20);
  });
  it("monthly term → one month; 24-month term → 24 months", () => {
    expect(renewalCostForSub(CATALOG, { ...SUB, term_months: 1 }).total).toBe(renewalCatalogCost(GW_STD, { termMonths: 1, seats: 20 }).total);
    expect(renewalCostForSub(CATALOG, { ...SUB, term_months: 24 }).total).toBe(620 * 24 * 20);
  });
  it("no match / no seats → unknown", () => {
    expect(renewalCostForSub(CATALOG, { ...SUB, plan: "Some bespoke plan" }).known).toBe(false);
    expect(renewalCostForSub(CATALOG, { ...SUB, seats: 0 }).known).toBe(false);
    expect(renewalCostForSub(CATALOG, { ...SUB, seats: null }).known).toBe(false);
  });
  it("a row with wholesale 0 → unknown, never 100% margin", () => {
    const free = row({ id: "Z", name: "Google Workspace Business Standard", msrp: 736, wholesale: 0 });
    expect(renewalCostForSub([free], SUB).known).toBe(false);
  });
  it("domain subscription → its extension's row per year × years", () => {
    const d = { plan: "Domain Registration .in", seats: 1, vendor: "domain", item_id: null, domain: "acme.in" };
    expect(renewalCostForSub(CATALOG, { ...d, term_months: 12 }).total).toBe(600);
    expect(renewalCostForSub(CATALOG, { ...d, term_months: 24 }).total).toBe(1200);
    expect(renewalCostForSub(CATALOG, { ...d, domain: "acme.co.in", term_months: 12 }).known).toBe(false);
  });
});

describe("R-2819 the three lines", () => {
  const amt = renewalAmount(SUB, null);   // ₹2,04,000/yr + GST (17,000 × 12)
  it("known: margin ₹ and % on the row's own ex-GST amount", () => {
    const m = drawerMoney(amt, renewalCostForSub(CATALOG, SUB), 12);
    expect(m).toEqual({ kind: "known", cost: "₹1,48,800/yr", margin: "₹55,200/yr", pct: 27, loss: false });
  });
  it("cost above price → a loss with a minus sign", () => {
    const cheap = renewalAmount({ ...SUB, mrr: 10000 }, null);   // ₹1,20,000/yr
    const m = drawerMoney(cheap, renewalCostForSub(CATALOG, SUB), 12);
    expect(m).toMatchObject({ kind: "known", margin: "−₹28,800/yr", loss: true, pct: -24 });
  });
  it("cost missing → costMissing with the reason; loading / unread are their own states", () => {
    expect(drawerMoney(amt, renewalCostForSub(CATALOG, { ...SUB, plan: "Bespoke" }), 12)).toMatchObject({ kind: "costMissing", reason: expect.stringMatching(/no catalogue item/) });
    expect(drawerMoney(amt, undefined, 12)).toEqual({ kind: "loading" });
    expect(drawerMoney(amt, null, 12)).toEqual({ kind: "unread" });
  });
  it("no renewal amount (domain sold with hosting) → cost shown, no margin", () => {
    const zero = renewalAmount({ ...SUB, mrr: 0 }, null);
    expect(drawerMoney(zero, renewalCostForSub(CATALOG, SUB), 12)).toEqual({ kind: "noAmount", cost: "₹1,48,800/yr" });
  });
  it("USD customer: the ₹ books line is shown; ₹ customer: none", () => {
    const usd = renewalAmount(SUB, null, { id: "Q", amount: 1, status: "paid", currency: "USD", exchange_rate: 85 });
    expect(usd.text).toMatch(/^\$/);
    expect(booksRupeeLine(usd, 12)).toBe("₹2,04,000/yr in ₹ (books)");
    expect(booksRupeeLine(amt, 12)).toBeNull();
    /* margin stays ₹ against ₹ — the books figure, never $ minus ₹ */
    expect(drawerMoney(usd, renewalCostForSub(CATALOG, SUB), 12)).toMatchObject({ margin: "₹55,200/yr", pct: 27 });
  });
});

describe("R-2819 wiring", () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  it("the catalogue is read once per tenant (not per renewal), only when enabled, with the renewal quote's columns", () => {
    const src = read("./drawer-cost-data.ts");
    expect(src).toMatch(/\.select\(RENEWAL_CATALOG_COLUMNS\)/);
    expect(src).toMatch(/queryKey: \["items", "renewal-drawer-catalog", tenantId \?\? ""\]/);
    expect(src).toMatch(/enabled: enabled && !!tenantId/);
    expect(src.match(/useQuery\(/g)).toHaveLength(1);
  });
  it("the drawer enables that read only for a role that may see cost, and only while open", () => {
    const ui = read("./renewal-drawer.tsx");
    expect(ui).toMatch(/const showCost = mayShowRenewalCost\(me\?\.role\)/);
    expect(ui).toMatch(/useRenewalDrawerCatalog\(sub\?\.tenant_id \?\? null, open && !!sub && showCost\)/);
    expect(ui).toMatch(/\{showCost && <CostFacts money=\{money\} \/>\}/);
  });
});
