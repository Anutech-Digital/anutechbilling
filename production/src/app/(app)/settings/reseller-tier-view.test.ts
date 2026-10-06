import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { resellerTierView } from "./reseller-tier-view";

const base = { name: "Sharma Cloud", tier: "reseller" as const, parent_tenant_id: null, parent_name: null, parent_gstin: null };

describe("resellerTierView (R-251)", () => {
  it("new independent signup: nothing to show", () => {
    expect(resellerTierView(base)).toBeNull();
    expect(resellerTierView(null)).toBeNull();
  });
  it("reseller with a parent shows THAT parent, from data", () => {
    const v = resellerTierView({ ...base, parent_tenant_id: "p1", parent_name: "Acme Distribution", parent_gstin: "07AAACA1234A1Z5" });
    expect(v?.badge).toBe("Reseller");
    expect(v?.rows).toEqual([
      { label: "Parent distributor", value: "Acme Distribution" },
      { label: "Parent GSTIN", value: "07AAACA1234A1Z5" },
      { label: "This account", value: "Sharma Cloud" },
    ]);
  });
  it("distributor names itself", () => {
    const v = resellerTierView({ ...base, tier: "distributor" });
    expect(v?.isDistributor).toBe(true);
    expect(v?.rows).toEqual([{ label: "Distributor", value: "Sharma Cloud" }]);
  });
  it("never prints our own companies for someone else", () => {
    const v = resellerTierView({ ...base, parent_tenant_id: "p1", parent_name: "Acme" });
    expect(JSON.stringify(v)).not.toMatch(/Anutech|Excel Tech/);
  });
});

describe("settings page wiring (R-251)", () => {
  const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
  it("no hard-coded Anutech / Excel hierarchy", () => {
    expect(src).not.toMatch(/Anutech Digital \(anutech\.in\)/);
    expect(src).not.toMatch(/Excel Technologies \(exceltechnologies\.in\)/);
    expect(src).toMatch(/resellerTierView\(/);
  });
  it("no toast-only 'Microsoft Partner' Setup placeholder", () => {
    expect(src).not.toMatch(/Microsoft Partner/);
    expect(src).not.toMatch(/Setting up \$\{it\.name\}/);
  });
});
