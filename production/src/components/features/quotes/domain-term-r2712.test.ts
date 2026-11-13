/** R-2712 — a bulk line of a domain item gets the builder's "Register for N years" picker too, and
 *  changing the years on the line rescales its whole-term rate like any domain line (R-1445). */
import { describe, it, expect } from "vitest";
import { isTermLine, lineForYears } from "./domain-term";
import { buildBulkLine } from "@/lib/quotes/bulk";

const DOMAIN_ITEMS = new Set(["it-in"]);
const DOMAINS = [{ domain: "a1.in", seats: 1 }, { domain: "a2.in", seats: 2 }];

describe("R-2712 isTermLine on bulk lines", () => {
  it("a bulk line of a Domain-vendor item → yes", () => {
    expect(isTermLine(buildBulkLine({ id: "l1", item_id: "it-in", name: ".in", cost: 600 }, 800, DOMAINS), DOMAIN_ITEMS)).toBe(true);
  });
  it("a bulk line whose name says domain / registration → yes", () => {
    expect(isTermLine(buildBulkLine({ id: "l1", item_id: "it-x", name: "Domain registration .com", cost: 600 }, 800, DOMAINS), DOMAIN_ITEMS)).toBe(true);
  });
  it("a bulk Workspace line → no (seats, not a registration)", () => {
    expect(isTermLine(buildBulkLine({ id: "l1", item_id: "it-gws", name: "Google Workspace Business Starter", cost: 1800 }, 2400, DOMAINS), DOMAIN_ITEMS)).toBe(false);
  });
});

describe("R-2712 years changed on the bulk line row", () => {
  it("1 → 3 → 2 lands on 2 × the yearly figure; qty and the domains stay", () => {
    const one = { ...buildBulkLine({ id: "l1", item_id: "it-in", name: ".in", cost: 600 }, 799, DOMAINS), list_rate: 799 };
    const three = lineForYears(one, 3);
    expect([three.rate, three.cost, three.list_rate, three.years]).toEqual([2397, 1800, 2397, 3]);
    const two = lineForYears(three, 2);
    expect([two.rate, two.cost, two.list_rate, two.years]).toEqual([1598, 1200, 1598, 2]);
    expect(two.qty).toBe(3);
    expect(two.domains).toEqual(DOMAINS);
    const back = lineForYears(two, 1);
    expect([back.rate, back.cost, back.years]).toEqual([799, 600, undefined]);
  });
});
