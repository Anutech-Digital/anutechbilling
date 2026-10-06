/** R-201: demo data — only on staging/local, every row clearly named, a spread worth testing. */
import { describe, it, expect } from "vitest";
import { demoDataAllowed, demoRows, DEMO_PREFIX } from "./demo-data";

describe("demoDataAllowed", () => {
  it("is staging and local only — a production build (\"\") or anything else is refused", () => {
    expect(demoDataAllowed("staging")).toBe(true);
    expect(demoDataAllowed("local")).toBe(true);
    expect(demoDataAllowed("")).toBe(false);
    expect(demoDataAllowed(undefined)).toBe(false);
    expect(demoDataAllowed("production")).toBe(false);
  });
});

describe("demoRows", () => {
  const { customers, leads } = demoRows("2026-10-06", 1);
  it("names every row DEMO · so clear finds exactly them", () => {
    for (const c of customers) expect(c.name.startsWith(DEMO_PREFIX)).toBe(true);
    for (const l of leads) expect(l.company.startsWith(DEMO_PREFIX)).toBe(true);
  });
  it("covers the GST cases: in-state, other state, no GSTIN, no state, export", () => {
    expect(customers.some((c) => c.state_code === "07" && c.gstin)).toBe(true);
    expect(customers.some((c) => c.state_code && !c.gstin)).toBe(true);
    expect(customers.some((c) => c.country === "India" && !c.state_code)).toBe(true);
    expect(customers.some((c) => c.country !== "India")).toBe(true);
  });
  it("has a deal in every stage, never a ₹0 value, unique ids", () => {
    expect(new Set(leads.map((l) => l.stage))).toEqual(new Set(["new", "contact", "demo", "trial", "quote", "won", "lost"]));
    for (const l of leads) expect(l.value === null || l.value > 0).toBe(true);
    expect(new Set(leads.map((l) => l.id)).size).toBe(leads.length);
  });
});
