/**
 * R-388 — line cost: unknown vs zero, the late-catalogue backfill, and the approval rule.
 *
 * Live finding (7 Oct, Kapoor test): /quotes/new?leadId=… for "Google Workspace Standard
 * 25 seats" filled cost ₹7,440 on first load; after a reload the cost was 0 → margin 98%
 * instead of ₹1,41,796. And a quote carrying the company-wide support plan (our own
 * service, cost 0) went to the owner with "no vendor cost".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lineCostUnknown, anyCostUnknown, fillUnknownCosts, isOwnServiceLine } from "./line-cost";
import { matchCatalogItemForPlan } from "./lead-plan-match";
import { lineEconomics } from "./approval-economics";
import { requiredApproval } from "./approval";
import { configureQuote } from "./configure";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

const SUPPORT_ID = "SUP-STANDARD-YR-fbb976f190904f1097260901bd144e42";

const gw = (over: Partial<QuoteLineItem> = {}): QuoteLineItem => ({
  id: "l1", item_id: "gw-std", name: "Google Workspace Standard", qty: 25,
  rate: 12_960, list_rate: 12_960, cost: 7_440, commitment: "annual_yearly", ...over,
});
const support = (over: Partial<QuoteLineItem> = {}): QuoteLineItem => ({
  id: "l2", item_id: SUPPORT_ID, name: "Standard Support (Yearly)", qty: 1,
  rate: 24_000, list_rate: 24_000, cost: 0, commitment: "annual_yearly", ...over,
});

describe("lineCostUnknown — unknown vs zero", () => {
  it("null / undefined cost on a sold line is UNKNOWN", () => {
    expect(lineCostUnknown({ cost: null, rate: 100 })).toBe(true);
    expect(lineCostUnknown({ cost: undefined, rate: 100 })).toBe(true);
  });
  it("₹0 cost on a vendor product is still unknown (that is how a missing cost is stored)", () => {
    expect(lineCostUnknown(gw({ cost: 0 }))).toBe(true);
  });
  it("₹0 cost on our own support plan is KNOWN", () => {
    expect(isOwnServiceLine(support())).toBe(true);
    expect(lineCostUnknown(support())).toBe(false);
  });
  it("a free line (rate 0) is never unknown; a real cost is known", () => {
    expect(lineCostUnknown({ cost: 0, rate: 0 })).toBe(false);
    expect(lineCostUnknown(gw())).toBe(false);
  });
  it("anyCostUnknown over a quote", () => {
    expect(anyCostUnknown([gw(), support()])).toBe(false);
    expect(anyCostUnknown([gw({ cost: 0 }), support()])).toBe(true);
  });
});

describe("approval rule (saved quote) — support line is known cost 0", () => {
  it("GW + support plan: no 'no vendor cost' reason, margin is computed", () => {
    const e = lineEconomics([gw(), support()]);
    expect(e.costUnknown).toBe(false);
    const r = requiredApproval(e);
    expect(r.reasons.some((x) => /no vendor cost/.test(x))).toBe(false);
    expect(r.marginBps).not.toBeNull();
    expect(r.tier).toBe("none");
  });
  it("a genuinely unknown vendor cost STILL needs the owner", () => {
    const r = requiredApproval(lineEconomics([gw({ cost: 0 }), support()]));
    expect(r.tier).toBe("owner");
    expect(r.reasons.some((x) => /no vendor cost/.test(x))).toBe(true);
  });
  it("support plan alone needs nobody", () => {
    expect(requiredApproval(lineEconomics([support()])).tier).toBe("none");
  });
  it("customer configurator agrees with the saved-quote rule", () => {
    const withSupport = configureQuote([gw(), support()], [], []);
    expect(withSupport.economics.costUnknown).toBe(false);
    const unknown = configureQuote([gw({ cost: 0 }), support()], [], []);
    expect(unknown.economics.costUnknown).toBe(true);
  });
});

describe("fillUnknownCosts — the catalogue arrives AFTER the lead prefill", () => {
  const catalog = [
    { id: "gw-std", name: "Google Workspace Standard", wholesale: 620 },
    { id: "gw-start", name: "Google Workspace Business Starter", wholesale: 255 },
  ];
  const fromCatalog = (l: QuoteLineItem) => {
    const it = (l.item_id ? catalog.find((c) => c.id === l.item_id) : undefined)
      ?? matchCatalogItemForPlan(catalog, l.name);
    return it ? { cost: it.wholesale * 12, item_id: it.id } : null;
  };

  it("reload race: prefill ran on an empty catalogue (cost 0, pending) → filled to ₹7,440 when it arrives", () => {
    /* Step 1: prefill against [] → the plan-map fallback, no item_id, cost unknown. */
    const pending = new Set(["l1"]);
    const prefilled = [gw({ item_id: undefined, name: "google-workspace-standard", cost: 0 })];
    expect(lineCostUnknown(prefilled[0])).toBe(true);

    /* Step 2: the catalogue answers. */
    const { lines, filled } = fillUnknownCosts(prefilled, (l) => pending.has(l.id), fromCatalog);
    expect(filled).toHaveLength(1);
    expect(lines[0].cost).toBe(7_440);
    expect(lines[0].item_id).toBe("gw-std");
    /* Margin is the real one now: 25 × (12,960 − 7,440) = ₹1,38,000, not "everything". */
    const e = lineEconomics(lines);
    expect(e.totalCost).toBe(186_000);
    expect(e.costUnknown).toBe(false);
  });

  it("null / undefined cost counts as pending too", () => {
    const lines = [{ id: "x", item_id: "gw-std", name: "Google Workspace Standard", rate: 12_960, cost: null as number | null }];
    const out = fillUnknownCosts(lines, (l) => l.cost == null, (l) => {
      const it = catalog.find((c) => c.id === l.item_id);
      return it ? { cost: it.wholesale * 12 } : null;
    });
    expect(out.lines[0].cost).toBe(7_440);
  });

  it("NEVER overwrites a cost the user typed (not pending)", () => {
    const typed = [gw({ cost: 5_000 })];
    const out = fillUnknownCosts(typed, () => false, fromCatalog);
    expect(out.lines).toBe(typed);
    expect(out.lines[0].cost).toBe(5_000);
  });

  it("a catalogue that cannot answer (no row / wholesale 0) leaves it unknown, not a fake ₹0", () => {
    const prefilled = [gw({ item_id: undefined, name: "Some Unknown Plan", cost: 0 })];
    const out = fillUnknownCosts(prefilled, () => true, (l) => {
      const it = l.name.includes("Unknown") ? { cost: 0 } : null;
      return it;
    });
    expect(out.filled).toHaveLength(0);
    expect(out.lines).toBe(prefilled);
    expect(lineCostUnknown(out.lines[0])).toBe(true);
  });

  it("returns the same array when nothing changed (safe in a setState updater)", () => {
    const ls = [gw()];
    expect(fillUnknownCosts(ls, () => false, fromCatalog).lines).toBe(ls);
  });
});

describe("matchCatalogItemForPlan", () => {
  const cat = [
    { name: "Google Workspace Business Starter" },
    { name: "Google Workspace Standard" },
    { name: null },
  ];
  it("matches a buy-page slug, a substring and a tier keyword", () => {
    expect(matchCatalogItemForPlan(cat, "google-workspace-standard")?.name).toBe("Google Workspace Standard");
    expect(matchCatalogItemForPlan(cat, "Business Starter")?.name).toBe("Google Workspace Business Starter");
    expect(matchCatalogItemForPlan(cat, "gw-standard-annual")?.name).toBe("Google Workspace Standard");
  });
  it("no plan / no match → undefined; a nameless row never matches everything", () => {
    expect(matchCatalogItemForPlan(cat, null)).toBeUndefined();
    expect(matchCatalogItemForPlan(cat, "Zoho Mail")).toBeUndefined();
  });
});

describe("quote builder wiring (R-388)", () => {
  const src = readFileSync(join(__dirname, "../../components/features/quotes/quote-builder.tsx"), "utf8");
  it("the lead prefill waits for the catalogue QUERY, not for a value that is [] while loading", () => {
    expect(src).toMatch(/isPending:\s*catalogPending\s*}\s*=\s*useItems\(\)/);
    expect(src).toMatch(/if \(catalogPending\) return;/);
    expect(src).not.toMatch(/if \(!catalog\) return;/);
  });
  it("a prefilled line with no cost is marked pending and backfilled when the catalogue arrives", () => {
    expect(src).toMatch(/if \((?:priced\.)?cost <= 0\) costPendingRef\.current\.add\(lineId\)/);
    expect(src).toMatch(/fillUnknownCosts\(/);
  });
  it("a typed cost is protected from catalogue reloads", () => {
    expect(src).toMatch(/costTypedRef\.current\.add\(id\)/);
    expect(src).toMatch(/costTypedRef\.current\.has\(l\.id\)/);
  });
  it("uses the shared unknown-cost rule", () => {
    expect(src).toMatch(/const costUnknown\s+= lineCostUnknown;/);
  });
});
