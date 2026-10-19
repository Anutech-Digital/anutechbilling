import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { matchCatalogItemForPlan } from "./lead-plan-match";
import { leadPlanDisplay } from "@/lib/leads/lead-plan-display";

/* R-1667: staging 19 Oct — /quotes/new?leadId=…&plan=Google+Workspace+Standard&seats=10 put
   "Google Voice Standard @ ₹9,600/seat/yr" on the quote, and the lead card said the same.
   The tier-keyword fallback took the FIRST row containing "standard". The catalogue order
   below is the one that bit: Voice comes before Workspace. */
const CATALOG = [
  { name: "Google Voice Standard" },
  { name: "Google Voice Premier" },
  { name: "Google Workspace Business Starter" },
  { name: "Google Workspace Business Standard" },
  { name: "Google Workspace Business Plus" },
  { name: "Microsoft 365 Business Standard" },
  { name: "Zoho Workplace Standard" },
];

describe("matchCatalogItemForPlan — product family first, then tier (R-1667)", () => {
  it("'Google Workspace Standard' → Workspace Business Standard, never Voice", () => {
    expect(matchCatalogItemForPlan(CATALOG, "Google Workspace Standard")?.name).toBe("Google Workspace Business Standard");
    expect(matchCatalogItemForPlan(CATALOG, "google-workspace-standard")?.name).toBe("Google Workspace Business Standard");
    expect(matchCatalogItemForPlan(CATALOG, "Google Workspace Plus")?.name).toBe("Google Workspace Business Plus");
  });

  it("'Google Voice Standard' → Voice Standard", () => {
    expect(matchCatalogItemForPlan(CATALOG, "Google Voice Standard")?.name).toBe("Google Voice Standard");
    expect(matchCatalogItemForPlan(CATALOG, "google-voice-standard")?.name).toBe("Google Voice Standard");
  });

  it("other families keep their own tier", () => {
    expect(matchCatalogItemForPlan(CATALOG, "m365-business-standard")?.name).toBe("Microsoft 365 Business Standard");
    expect(matchCatalogItemForPlan(CATALOG, "Microsoft 365 Standard")?.name).toBe("Microsoft 365 Business Standard");
    expect(matchCatalogItemForPlan(CATALOG, "gw-standard-annual")?.name).toBe("Google Workspace Business Standard");
  });

  it("no confident match → undefined (never a guess by tier word alone)", () => {
    // A tier word with no family: four different products carry it.
    expect(matchCatalogItemForPlan(CATALOG, "Standard")).toBeUndefined();
    // A family the catalogue does not have, with a tier the catalogue does have.
    expect(matchCatalogItemForPlan(CATALOG, "Google Workspace Enterprise")).toBeUndefined();
    expect(matchCatalogItemForPlan(CATALOG, "Dropbox Standard")).toBeUndefined();
    // Workspace Standard when only Voice carries "standard".
    expect(matchCatalogItemForPlan([{ name: "Google Voice Standard" }], "Google Workspace Standard")).toBeUndefined();
  });

  it("the lead card names the same row the quote uses", () => {
    const rows = CATALOG.map((c) => ({ ...c, msrp: 1080, wholesale: 900, prices: null, item_type: "subscription" }));
    expect(leadPlanDisplay({ plan: "Google Workspace Standard", seats: 10, value: null }, rows as never).name)
      .toBe("Google Workspace Business Standard");
    expect(leadPlanDisplay({ plan: "Standard", seats: 10, value: null }, rows as never)).toMatchObject({
      name: "Standard",
      ratePerSeatYear: null,
    });
  });
});

describe("quote builder wiring (R-1667)", () => {
  const src = readFileSync(join(__dirname, "../../components/features/quotes/quote-builder.tsx"), "utf8");
  it("the plan-map fallback uses the same matcher, not its own substring guess", () => {
    expect(src).not.toMatch(/kl\.includes\(lpLower\)/);
    expect(src).toMatch(/matchCatalogItemForPlan\(\s*Object\.keys\(PLAN_PRICE_PER_SEAT_PM\)/);
  });
  it("no match → the line stays empty and a warning says so", () => {
    expect(src).toMatch(/did not match one catalogue item — line left empty/);
  });
});
