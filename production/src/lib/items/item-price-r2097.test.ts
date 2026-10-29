/* R-2097 — a yearly per-seat price not divisible by 12 (₹1,000 / seat / year).
   Staging, 29 Oct 2026: saving it failed with "invalid input syntax for type integer: 83.33".
   The form kept ₹/seat/MONTH rounded to 2 decimals (83.33) and wrote that headline into
   items.msrp, an INTEGER column. Now: the tier keeps the exact monthly figure (1000 / 12), the
   integer headline columns get whole rupees, and every reader that prices a year gets the
   typed yearly price back exactly. */
import { describe, it, expect } from "vitest";
import { storedFromTyped, headlineColumns } from "./item-price";
import { catalogYearlyPrice, lineFromCatalog, catalogLineListRate } from "@/lib/quotes/catalog-line";
import { catalogueFromRows } from "@/lib/ai/sales-agent.server";

const yearlyItem = (yrPrice: number, yrCost: number) => {
  const annual = { msrp: storedFromTyped(yrPrice, "yr"), wholesale: storedFromTyped(yrCost, "yr") };
  return {
    id: "R2097", name: "Seat plan", vendor: "other" as const, kind: "main" as const,
    ...headlineColumns(annual),
    prices: { annual, billing_unit: "seat_month" as const },
  };
};

describe("R-2097 yearly per-seat price not divisible by 12", () => {
  it("₹1,000 a year is stored unrounded, so × 12 gives ₹1,000 back", () => {
    const m = storedFromTyped(1000, "yr");
    expect(m * 12).toBe(1000);
    expect(storedFromTyped(270, "mo")).toBe(270);
  });

  it("every yearly price in paise round-trips exactly (₹0.01 … ₹50,000)", () => {
    for (let paise = 1; paise <= 5_000_000; paise += 97) {
      const yr = paise / 100;
      expect(Math.round(storedFromTyped(yr, "yr") * 12 * 100)).toBe(paise);
    }
  });

  it("the integer columns get whole rupees — never 83.33 (the save error)", () => {
    const it = yearlyItem(1000, 800);
    expect(Number.isInteger(it.msrp)).toBe(true);
    expect(Number.isInteger(it.wholesale)).toBe(true);
    expect(it.msrp).toBe(83);
    expect(it.wholesale).toBe(67);
  });

  it("the catalogue prices ₹1,000 / ₹800 a year exactly; 40 seats = ₹40,000", () => {
    const it = yearlyItem(1000, 800);
    expect(catalogYearlyPrice(it)).toEqual({ rate: 1000, cost: 800 });
    const line = lineFromCatalog(it, { qty: 40 });
    expect(line.qty * line.rate).toBe(40_000);
    expect(catalogLineListRate(it, "annual_yearly")).toEqual({ rate: 1000, cost: 800 });
  });

  it("40 × ₹800 a year = ₹32,000 (not ₹32,004)", () => {
    const it = yearlyItem(800, 600);
    const line = lineFromCatalog(it, { qty: 40 });
    expect(line.qty * line.rate).toBe(32_000);
  });

  it("the AI sales agent quotes ₹1,000 a year, not 83 × 12 = ₹996", () => {
    const it = yearlyItem(1000, 800);
    const [entry] = catalogueFromRows([{ id: it.id, name: it.name, vendor: it.vendor, msrp: it.msrp, wholesale: it.wholesale, prices: it.prices as never }]);
    expect(entry.msrpPerSeatPerYear).toBe(1000);
    expect(entry.wholesalePerSeatPerYear).toBe(800);
  });
});
