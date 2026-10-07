/**
 * R-207: the catalog a new tenant gets (DEFAULT_CATALOG) must carry the Google
 * Workspace LIST price (Starter 270 / Standard 1,080 / Plus 1,380 per seat-month),
 * read from lib/pricing/workspace.ts — not an old 136/736 promo copy.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { DEFAULT_CATALOG } from "./items";
import { TIER_FALLBACK_MONTHLY } from "@/lib/pricing/workspace";

const GW_MAIN = [
  { id: "GW-STR", list: 270, tier: "starter" },
  { id: "GW-STD", list: 1080, tier: "standard" },
  { id: "GW-PLS", list: 1380, tier: "plus" },
] as const;

describe("DEFAULT_CATALOG Google Workspace main rows (R-207)", () => {
  for (const { id, list, tier } of GW_MAIN) {
    it(`${id} msrp and annual msrp are the list price ${list}`, () => {
      const row = DEFAULT_CATALOG.find((r) => r.id === id);
      expect(row).toBeDefined();
      expect(row?.msrp).toBe(list);
      expect(row?.prices.annual?.msrp).toBe(list);
      expect(row?.msrp).toBe(TIER_FALLBACK_MONTHLY[tier]);
    });
  }

  it("no GW main row is priced below list", () => {
    for (const { id, list } of GW_MAIN) {
      const row = DEFAULT_CATALOG.find((r) => r.id === id);
      expect(row?.msrp ?? 0).toBeGreaterThanOrEqual(list);
      expect(row?.prices.annual?.msrp ?? 0).toBeGreaterThanOrEqual(list);
    }
  });
});
