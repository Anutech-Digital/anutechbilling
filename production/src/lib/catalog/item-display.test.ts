import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { displaySku, avgMarginPerSeat } from "./item-display";
import { catalogCostCoverage } from "./cost-coverage";

describe("displaySku (R-472)", () => {
  it("hides the tenant uuid tail", () => {
    expect(displaySku("SUP-STANDARD-YR-d0000000000040008000000000000001")).toBe("SUP-STANDARD-YR");
    expect(displaySku("GWS-STARTER-fbb976f1-9090-4f10-9726-0901bd144e42")).toBe("GWS-STARTER");
  });
  it("leaves a normal id alone", () => {
    expect(displaySku("GWS-BUSINESS-STARTER")).toBe("GWS-BUSINESS-STARTER");
    expect(displaySku("SKU-ABC123")).toBe("SKU-ABC123");
  });
});

describe("avgMarginPerSeat", () => {
  it("averages the same rows as Avg margin % — support is not counted as ₹0", () => {
    const rows = [
      { vendor: "google", msrp: 240, wholesale: 80, margin_pct: 67 },
      { vendor: "support", msrp: 0, wholesale: 0, margin_pct: 0 },
    ];
    const { priced } = catalogCostCoverage(rows);
    expect(avgMarginPerSeat(priced)).toBe(160);
    expect(avgMarginPerSeat([])).toBe(0);
  });
});

describe("/items page wiring", () => {
  const page = readFileSync(join(process.cwd(), "src", "app", "(app)", "items", "page.tsx"), "utf8");
  it("no developer note shown to the tenant", () => {
    expect(page).not.toMatch(/next sprint/);
  });
  it("shows the short SKU and averages ₹/seat over priced rows", () => {
    expect(page).toMatch(/displaySku\(it\.id\)/);
    expect(page).toMatch(/avgMarginPerSeat\(priced\)/);
  });
  it("the price column does not promise /seat/mo for a yearly row", () => {
    expect(page).not.toMatch(/MSRP <span className="font-normal text-ink-3 normal-case">\(\/seat\/mo\)<\/span>/);
  });
});
