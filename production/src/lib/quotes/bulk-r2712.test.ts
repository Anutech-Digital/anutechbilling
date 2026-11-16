/**
 * R-2712 (Pratik, 16 Oct): "Bulk / many domains" had no "more than 1 year" and no start date — the
 * client had paid 3 years of domain registration. The bulk line now carries `years` and
 * `start_date`, shaped like a normal multi-year domain line (R-156 / R-1445): its rate is the
 * price for the WHOLE term, so qty × rate bills the N years once.
 */
import { describe, it, expect } from "vitest";
import { buildBulkLine, isDomainPlan } from "./bulk";
import { provisioningProducts } from "@/lib/provisioning/products";

const PLAN = { id: "l1", item_id: "it-in", name: "Domain .in", cost: 600 };
const THREE = [{ domain: "a1.in", seats: 1 }, { domain: "a2.in", seats: 1 }, { domain: "a3.in", seats: 1 }];

describe("R-2712 buildBulkLine — years + start date", () => {
  it("owner example: 3 domains × ₹800 a year × 3 years from 1 Sep 2026 → ₹7,200 billed once", () => {
    const line = buildBulkLine(PLAN, 800, THREE, "annual_yearly", { years: 3, startDate: "2026-09-01" });
    expect(line.qty).toBe(3);
    expect(line.rate).toBe(2400);            // the whole term, per seat
    expect(line.qty * line.rate).toBe(7200);
    expect(line.cost).toBe(1800);
    expect("list_rate" in line).toBe(false); // the builder freezes list = rate when it adds the line
    expect(line.years).toBe(3);
    expect(line.start_date).toBe("2026-09-01");
    expect(line.bulk).toBe(true);
    expect(line.commitment).toBe("annual_yearly");
    expect(line.domains).toHaveLength(3);
  });

  it("1 year (or nothing asked) → the line it always was: yearly rate, no `years`, no start_date", () => {
    expect(buildBulkLine(PLAN, 800, THREE)).toEqual(buildBulkLine(PLAN, 800, THREE, "annual_yearly", { years: 1 }));
    const line = buildBulkLine(PLAN, 800, THREE);
    expect(line.rate).toBe(800);
    expect(line.cost).toBe(600);
    expect("years" in line).toBe(false);
    expect("start_date" in line).toBe(false);
    expect("list_rate" in line).toBe(false);
  });

  it("years must be a whole number 1–10 — anything else is 1 year, as the database reads it", () => {
    const y = (years: number) => buildBulkLine(PLAN, 800, THREE, "annual_yearly", { years });
    for (const bad of [0, -2, Number.NaN, 2.9, 11, Number.POSITIVE_INFINITY]) {
      expect(y(bad).rate).toBe(800);
      expect(y(bad).cost).toBe(600);
      expect(y(bad).years).toBeUndefined();
    }
    expect([y(2).years, y(2).rate]).toEqual([2, 1600]);
    expect([y(10).years, y(10).rate]).toEqual([10, 8000]);
  });

  it("a past start date is kept (the client already paid); a blank or impossible one is left out", () => {
    const s = (startDate: string) => buildBulkLine(PLAN, 800, THREE, "annual_yearly", { years: 3, startDate });
    expect(s("2025-04-01").start_date).toBe("2025-04-01");
    expect(s("2028-02-29").start_date).toBe("2028-02-29");
    expect("start_date" in s("")).toBe(false);
    expect("start_date" in s("2026-02-30")).toBe(false);
    expect("start_date" in s("01/09/2026")).toBe(false);
  });

  it("a monthly bulk line never takes years (its rate is one month)", () => {
    const line = buildBulkLine(PLAN, 100, THREE, "monthly", { years: 3, startDate: "2026-09-01" });
    expect(line.rate).toBe(100);
    expect(line.years).toBeUndefined();
    expect(line.start_date).toBe("2026-09-01");
  });
});

describe("R-2712 isDomainPlan — which plans get the Register for picker", () => {
  it("a Domain-vendor item, or a name that says domain / registration", () => {
    expect(isDomainPlan({ vendor: "domain", name: ".in" })).toBe(true);
    expect(isDomainPlan({ vendor: "other", name: "Domain registration .com" })).toBe(true);
    expect(isDomainPlan({ vendor: "google", name: "Google Workspace Business Starter" })).toBe(false);
    expect(isDomainPlan({ vendor: "other", name: "Email on your domains pack" })).toBe(false);
    expect(isDomainPlan(null)).toBe(false);
  });
});

describe("R-2712 registrar: a bulk line never queues a per-domain registration", () => {
  it("3 years on a bulk line are not sent to the registrar — the line names no single domain", () => {
    const line = buildBulkLine(PLAN, 800, THREE, "annual_yearly", { years: 3, startDate: "2026-09-01" });
    const products = provisioningProducts({
      lineItems: [line], vendor: "domain", domain: null, seats: 3, domainItemIds: new Set(["it-in"]),
    });
    expect(products.some((p) => (p.years ?? 1) > 1)).toBe(false);
    expect(products.map((p) => p.domain)).not.toContain("a1.in");
  });
});
