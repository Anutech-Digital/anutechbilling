import { describe, it, expect } from "vitest";
import { leadPlanDisplay, readablePlan } from "./lead-plan-display";

type Row = Parameters<typeof leadPlanDisplay>[1] extends readonly (infer R)[] | null | undefined ? R : never;
const item = (name: string, msrp: number, extra: Partial<Row> = {}): Row =>
  ({ name, msrp, wholesale: Math.round(msrp * 0.8), prices: null, item_type: "subscription", ...extra }) as Row;

// Per seat per MONTH, like the catalogue.
const CATALOG: Row[] = [
  item("Google Workspace Business Starter", 270),
  item("Google Workspace Business Standard", 1080),
  item("Microsoft 365 Business Basic", 145),
  item("Setup fee", 5000, { item_type: "one_time" }),
];

describe("lead card plan + deal value (R-490 / R-456)", () => {
  it("Abhishek's website lead: slug 'google-workspace', 12 seats → catalogue name and 12 × rate", () => {
    const d = leadPlanDisplay({ plan: "google-workspace", seats: 12, value: null }, CATALOG);
    expect(d.name).toBe("Google Workspace Business Starter");
    expect(d.ratePerSeatYear).toBe(3240);
    expect(d.value).toBe(38_880);
    expect(d.estimated).toBe(true);
  });

  it("a tier slug finds its own tier", () => {
    const d = leadPlanDisplay({ plan: "google-workspace-standard", seats: 5, value: null }, CATALOG);
    expect(d.name).toBe("Google Workspace Business Standard");
    expect(d.value).toBe(5 * 12_960);
  });

  it("a value someone entered always wins over the estimate", () => {
    const d = leadPlanDisplay({ plan: "google-workspace", seats: 12, value: 50_000 }, CATALOG);
    expect(d.value).toBe(50_000);
    expect(d.estimated).toBe(false);
  });

  it("no seats → no made-up value", () => {
    const d = leadPlanDisplay({ plan: "google-workspace", seats: null, value: null }, CATALOG);
    expect(d.value).toBeNull();
    expect(d.name).toBe("Google Workspace Business Starter");
  });

  it("no catalogue (still loading / failed) → readable slug, no value", () => {
    const d = leadPlanDisplay({ plan: "google-workspace", seats: 12, value: null }, undefined);
    expect(d.name).toBe("Google Workspace");
    expect(d.value).toBeNull();
  });

  it("never prices from a one-time item", () => {
    const d = leadPlanDisplay({ plan: "Setup fee", seats: 3, value: null }, CATALOG);
    expect(d.ratePerSeatYear).toBeNull();
    expect(d.value).toBeNull();
  });
});

describe("readablePlan", () => {
  it("turns slugs into words and leaves names alone", () => {
    expect(readablePlan("google-workspace-starter")).toBe("Google Workspace Starter");
    expect(readablePlan("microsoft-365")).toBe("Microsoft 365");
    expect(readablePlan("Google Workspace Business Starter")).toBe("Google Workspace Business Starter");
    expect(readablePlan("")).toBeNull();
  });
});
