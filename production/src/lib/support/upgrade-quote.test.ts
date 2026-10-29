/**
 * R-2073 — the owner's path: a Standard yearly support customer, half the term left,
 * "Upgrade plan" → a quote for ₹19,998 ex-GST with the renewal date unchanged.
 */
import { describe, it, expect } from "vitest";
import { buildSupportUpgrade, supportUpgradeFrom, type UpgradeSub } from "./upgrade-quote";
import { lineDateRange } from "@/lib/quotes/service-period";

const T = "fbb976f1909049f097260901bd144e42";
const items = [
  { id: `SUP-STANDARD-YR-${T}`,   name: "Anutech Standard Support (Yearly)",   msrp: 0, prices: { annual_total: { msrp: 9_996 } } },
  { id: `SUP-ENTERPRISE-YR-${T}`, name: "Anutech Enterprise Support (Yearly)", msrp: 0, prices: { annual_total: { msrp: 49_992 } } },
  { id: `SUP-STANDARD-MO-${T}`,   name: "Anutech Standard Support",            msrp: 999, prices: {} },
];

/* Anniversary row: started 1 Jul 2027, renews 1 Jul 2028 — a 366-day term. */
const sub: UpgradeSub = {
  id: "11111111-2222-4333-8444-555555555555",
  item_id: `SUP-STANDARD-YR-${T}`, status: "active", billing_cycle: "annual", term_months: 12,
  start_date: "2027-07-01", renewal_date: "2028-07-01", renewal_quote_id: null,
};

describe("R-2073 buildSupportUpgrade", () => {
  it("owner's example: ₹9,996 → ₹49,992 with half the term left = one ₹19,998 line, renewal date kept", () => {
    const r = buildSupportUpgrade({ sub, items, toTier: "enterprise", today: "2027-12-31" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.calc.amountExGst).toBe(19_998);
    expect(r.plan.line).toMatchObject({
      item_id: `SUP-ENTERPRISE-YR-${T}`, qty: 1, rate: 19_998, commitment: "annual_yearly",
    });
    // The line names the dates it pays for — the period printed on the quote and invoice.
    expect(lineDateRange(r.plan.line.name)).toEqual({ from: "2027-12-31", to: "2028-06-30" });
    expect(r.plan.notes).toContain("renewal date stays 1 Jul 2028");
    expect(r.plan.notes).toContain(`subscription ${sub.id}`);
  });

  it("refuses when the new tier is not in the catalogue", () => {
    const r = buildSupportUpgrade({ sub, items: items.slice(0, 1), toTier: "enterprise", today: "2027-12-31" });
    expect(r.ok).toBe(false);
  });

  it("refuses a downgrade, an open quote, and an instalment-billed plan", () => {
    const ent = { ...sub, item_id: `SUP-ENTERPRISE-YR-${T}` };
    expect(buildSupportUpgrade({ sub: ent, items, toTier: "standard", today: "2027-12-31" }))
      .toEqual({ ok: false, reason: "Downgrades take effect at renewal" });
    expect(buildSupportUpgrade({ sub: { ...sub, renewal_quote_id: "Q-1" }, items, toTier: "enterprise", today: "2027-12-31" }).ok).toBe(false);
    expect(buildSupportUpgrade({ sub: { ...sub, billing_cycle: "monthly" }, items, toTier: "enterprise", today: "2027-12-31" }).ok).toBe(false);
  });

  it("only active tier-plan support subscriptions with a higher tier offer Upgrade plan", () => {
    expect(supportUpgradeFrom(sub)).toEqual({ tier: "standard", term: "yearly" });
    expect(supportUpgradeFrom({ ...sub, item_id: `SUP-ENTERPRISE-YR-${T}` })).toBeNull();
    expect(supportUpgradeFrom({ ...sub, item_id: "GWS-STARTER" })).toBeNull();
    expect(supportUpgradeFrom({ ...sub, item_id: null })).toBeNull();
    expect(supportUpgradeFrom({ ...sub, status: "cancelled" })).toBeNull();
  });
});
