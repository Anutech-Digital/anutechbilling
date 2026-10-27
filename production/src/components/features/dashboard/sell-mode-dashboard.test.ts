import { describe, expect, it } from "vitest";
import {
  defaultCatalogType, firstProductStep, leadsWithProjects, panelAvailable, summarizeOpenProjects,
} from "./sell-mode-dashboard";

describe("R-1862 — dashboard by 'What do you sell?'", () => {
  it("one-time with no subscriptions leads with projects; a subscription brings MRR back", () => {
    expect(leadsWithProjects("one_time", false)).toBe(true);
    expect(leadsWithProjects("one_time", undefined)).toBe(true);
    expect(leadsWithProjects("one_time", true)).toBe(false);
  });

  it("Both and Subscriptions stay exactly as before", () => {
    for (const has of [true, false, undefined]) {
      expect(leadsWithProjects("both", has)).toBe(false);
      expect(leadsWithProjects("subscriptions", has)).toBe(false);
    }
  });

  it("Renewals and Trials panels leave the layout only for projects-first", () => {
    expect(panelAvailable("renewals", true)).toBe(false);
    expect(panelAvailable("trials", true)).toBe(false);
    expect(panelAvailable("chase", true)).toBe(true);
    expect(panelAvailable("renewals", false)).toBe(true);
  });

  it("Open projects counts only active project sales, whole rupees", () => {
    expect(summarizeOpenProjects([
      { status: "active", total_amount: 118000 },
      { status: "active", total_amount: 59000.4 },
      { status: "quoted", total_amount: 50000 },
      { status: "completed", total_amount: 90000 },
      { status: "cancelled", total_amount: 10000 },
      { status: "draft", total_amount: null },
    ])).toEqual({ count: 2, value: 177000 });
    expect(summarizeOpenProjects([])).toEqual({ count: 0, value: 0 });
  });

  it("first product step opens the One-time products tab for a one-time business", () => {
    expect(firstProductStep("one_time")).toMatchObject({ href: "/items/products", cta: "Add one-time item" });
    expect(firstProductStep("both")).toMatchObject({ href: "/items", label: "Load your price list" });
    expect(firstProductStep("subscriptions").href).toBe("/items");
  });

  it("/items without a tab opens the tab for the answer; an explicit tab always wins", () => {
    expect(defaultCatalogType("/items", "one_time")).toBe("one_time");
    expect(defaultCatalogType("/items", "both")).toBe("subscription");
    expect(defaultCatalogType("/items/subscriptions", "one_time")).toBe("subscription");
    expect(defaultCatalogType("/items/products", "subscriptions")).toBe("one_time");
  });
});
