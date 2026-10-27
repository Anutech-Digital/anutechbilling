/**
 * R-1981 (26 Oct 2026, G-ADS audit): the website checkout writes lead sources that were
 * not in LEAD_SOURCES — buy-workspace-direct(-sim), buy-cart-direct(-sim),
 * buy-workspace-trial, buy-workspace … — so the Source filter on Sales & Pipeline listed
 * each raw code as its own option and reports split one channel into five.
 *
 * Fix: they map at READ time to three listed sources (no data repair):
 *   Website order · Website order (test) · Website trial; the buy-page enquiry
 *   ("buy-workspace") joins "Buy Workspace page". The saved value is never rewritten —
 *   Online Orders (lib/online-orders/sources.ts) still reads the raw `buy-*` code.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  LEAD_SOURCES, canonicalSource, sourceFilterOptions, sourceLabel, sourceOptions, sourceForSave,
} from "./lead-sources";

const SRC = path.join(__dirname, "..", "..");

describe("website checkout sources map to one listed source each (R-1981)", () => {
  it("orders → Website order; test-mode orders → Website order (test)", () => {
    expect(canonicalSource("buy-workspace-direct")).toBe("website-order");
    expect(canonicalSource("buy-cart-direct")).toBe("website-order");
    expect(canonicalSource("buy-workspace-direct-sim")).toBe("website-order-test");
    expect(canonicalSource("buy-cart-direct-sim")).toBe("website-order-test");
    expect(sourceLabel("buy-workspace-direct")).toBe("Website order");
    expect(sourceLabel("buy-cart-direct-sim")).toBe("Website order (test)");
  });

  it("trials → Website trial; the buy-page enquiry → Buy Workspace page", () => {
    for (const v of ["buy-workspace-trial", "website-trial", "buy-hosting-trial"]) {
      expect(canonicalSource(v)).toBe("website-trial");
      expect(sourceLabel(v)).toBe("Website trial");
    }
    expect(canonicalSource("buy-workspace")).toBe("buy-workspace-v2");
  });

  it("the Source filter shows ONE 'Website order' option with the summed count", () => {
    const opts = sourceFilterOptions({ "buy-workspace-direct": 2, "buy-cart-direct": 1, "buy-workspace-trial": 4, "meta-ads": 5 });
    const order = opts.filter((o) => o.label === "Website order");
    expect(order).toEqual([{ value: "website-order", label: "Website order", count: 3 }]);
    expect(opts.find((o) => o.value === "website-trial")?.count).toBe(4);
    expect(opts.some((o) => o.value.startsWith("buy-"))).toBe(false);
  });

  it("every source a website route writes is a listed source after mapping", () => {
    const writers = [
      "app/api/public/checkout/workspace/route.ts",
      "app/api/public/enquiry/workspace/route.ts",
      "app/api/public/trial/workspace/route.ts",
      "lib/checkout/cart-checkout.ts",
      "lib/hosting/start-trial.ts",
    ];
    const keys = new Set(LEAD_SOURCES.map((s) => s.value));
    const found = new Set<string>();
    for (const f of writers) {
      const text = fs.readFileSync(path.join(SRC, f), "utf8");
      for (const m of text.matchAll(/"((?:buy-[a-z0-9-]+)|website-trial)"/g)) found.add(m[1]);
    }
    expect(found.size).toBeGreaterThanOrEqual(6);
    for (const v of found) expect(keys.has(canonicalSource(v)), `${v} → ${canonicalSource(v)}`).toBe(true);
  });
});

describe("Add / Edit lead — website sources are not hand-picked, and never rewritten", () => {
  it("the Add lead dropdown does not offer Website order / trial", () => {
    const vals = sourceOptions(null).map((s) => s.value);
    for (const v of ["website-order", "website-order-test", "website-trial"]) expect(vals).not.toContain(v);
    expect(vals).toContain("meta-ads");
  });

  it("editing a website order shows 'Website order' once", () => {
    const opts = sourceOptions("buy-workspace-direct");
    expect(opts.filter((s) => s.label === "Website order")).toHaveLength(1);
    expect(opts.some((s) => s.value === "buy-workspace-direct")).toBe(false);
  });

  it("saving an edit keeps the saved raw code when the source was not changed", () => {
    expect(sourceForSave("website-order", "buy-workspace-direct")).toBe("buy-workspace-direct");
    expect(sourceForSave("website-trial", "buy-hosting-trial")).toBe("buy-hosting-trial");
    expect(sourceForSave("meta-ads", "buy-workspace-direct")).toBe("meta-ads");
    expect(sourceForSave("manual", null)).toBe("manual");
    expect(sourceForSave("manual", "Added manually")).toBe("Added manually");
  });
});

describe("wiring: the lead form saves through sourceForSave", () => {
  it("an edit keeps the raw source (add-lead-form.tsx)", () => {
    const form = fs.readFileSync(path.join(SRC, "components/features/leads/add-lead-form.tsx"), "utf8");
    expect(form).toMatch(/source:\s+isEditing \? sourceForSave\(data\.source, editingLead\?\.source\) : data\.source/);
  });
});
