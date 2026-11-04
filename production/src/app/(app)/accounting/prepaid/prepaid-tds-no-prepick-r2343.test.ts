/**
 * R-2343 (1 Nov 2026, owner + CA rule from R-2338): the app never pre-picks a TDS section the
 * owner did not set. Prepaid → Book vendor invoice used to open on 194C for every vendor; now it
 * opens on "No TDS" unless the vendor has a saved Default TDS section (Vendors page), which it
 * pre-picks (old plain "194J" reads as 194J(b), like everywhere else).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vendorTdsPrefill } from "@/lib/accounting/tds-rates";

const page = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("R-2343 Prepaid — no TDS section unless the vendor has a default", () => {
  it("a vendor with no default (or no vendor in the master) → No TDS", () => {
    expect(vendorTdsPrefill(null)).toBe("");
    expect(vendorTdsPrefill(undefined)).toBe("");
    expect(vendorTdsPrefill("  ")).toBe("");
  });

  it("a vendor whose saved default is 194C → 194C; old plain 194J → 194J(b) professional", () => {
    expect(vendorTdsPrefill("194C")).toBe("194C");
    expect(vendorTdsPrefill("194ja")).toBe("194JA");
    expect(vendorTdsPrefill("194J")).toBe("194JB");
  });

  it("the Book vendor invoice dialog no longer starts on 194C", () => {
    expect(page).not.toMatch(/useState<string>\("194C"\)/);
    expect(page).toMatch(/const \[tdsSection, setTdsSection\] = React\.useState<string>\(""\)/);
  });

  it("it pre-picks the vendor's saved default until the operator picks a section", () => {
    expect(page).toMatch(/default_tds_section\?: string \| null \} \| null\)\?\.default_tds_section/);
    expect(page).toMatch(/setTdsSection\(vendorTdsPrefill\(vendorTdsDefault\)\)/);
    expect(page).toMatch(/if \(!tdsPicked\) setTdsSection\(/);
    expect(page).toMatch(/setTdsPicked\(true\)/);
  });
});
