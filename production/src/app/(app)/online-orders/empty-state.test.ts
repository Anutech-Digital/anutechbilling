import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ordersEmptyState } from "./empty-state";

const base = { search: "", focusLabel: "", totalOrders: 8 };

describe("R-350 ordersEmptyState — each tab says what is empty", () => {
  it("Trials tab with 8 orders elsewhere says no trials, not 'No orders yet'", () => {
    const e = ordersEmptyState({ ...base, tab: "trial" });
    expect(e.title).toBe("No trials running");
    expect(e.body).toMatch(/trial/i);
    expect(e.title).not.toMatch(/No orders yet/);
  });

  it("Paid tab says no paid orders yet", () => {
    expect(ordersEmptyState({ ...base, tab: "paid" }).title).toBe("No paid orders yet");
  });

  it("Issues tab keeps the all-clear message", () => {
    expect(ordersEmptyState({ ...base, tab: "issues" }).title).toBe("No issues — all clear!");
  });

  it("'No orders yet' only on All when there really are no orders", () => {
    expect(ordersEmptyState({ ...base, tab: "all", totalOrders: 0 }).title).toBe("No orders yet");
    expect(ordersEmptyState({ ...base, tab: "all", totalOrders: 8 }).title).not.toBe("No orders yet");
  });

  it("search and KPI focus win over the tab message", () => {
    expect(ordersEmptyState({ ...base, tab: "trial", search: "acme" }).title).toBe("No orders match your search");
    expect(ordersEmptyState({ ...base, tab: "all", focusLabel: "Provisioning" }).title).toContain("Provisioning");
  });

  it("no tab ever falls back to 'No orders yet' while orders exist", () => {
    for (const tab of ["all", "paid", "trial", "issues"]) {
      expect(ordersEmptyState({ ...base, tab }).title).not.toBe("No orders yet");
    }
  });
});

describe("R-350 Online Orders page wiring + phone card", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "page.tsx"), "utf8");

  it("page uses the per-tab empty helper, not a hard-coded 'No orders yet'", () => {
    expect(src).toMatch(/ordersEmptyState\(/);
    expect(src).not.toMatch(/:\s*"No orders yet"/);
  });

  it("phone card status line wraps (2 lines) instead of truncating", () => {
    expect(src).toMatch(/line-clamp-2[^"]*">\s*\{o\.nextAction\}/);
    expect(src).not.toMatch(/truncate max-w-\[60%\][^"]*">\s*\{o\.nextAction\}/);
  });

  it("INV link on the phone card has a >=40px tap area", () => {
    expect(src).toMatch(/min-h-\[40px\][^"]*"\s*title="Open GST invoice"/);
  });
});
