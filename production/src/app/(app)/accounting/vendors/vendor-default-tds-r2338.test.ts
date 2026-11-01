// R-2338 (owner + CA, 1 Nov 2026): the vendor's "Default TDS section" is set by the owner on the
// Add / Edit vendor dialog — "No TDS" by default, the three 194J choices offered, and the save
// sends it (an unchanged old "194J" is not rewritten). Wiring check on the page's source, the way
// vendor-dialog-size.test.ts reads it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const page = readFileSync(path.resolve(__dirname, "page.tsx"), "utf8");
const queries = readFileSync(path.resolve(__dirname, "../../../../lib/queries/vendors.ts"), "utf8");

describe("R-2338 vendor dialog — Default TDS section", () => {
  it("has the field, 'No TDS' when the vendor has none, options from the one picker list", () => {
    expect(page).toMatch(/label="Default TDS section"/);
    expect(page).toMatch(/<SelectItem value="none">No TDS<\/SelectItem>\s*\{TDS_PICK_SECTIONS\.map\(\(s\) => <SelectItem key=\{s\} value=\{s\}>\{tdsSectionOption\(s\)\}<\/SelectItem>\)\}/);
    expect(page).toMatch(/React\.useState\(normalizeTdsSection\(savedTds\)\)/);
  });

  it("Save sends it only when changed (an old plain 194J stays as stored)", () => {
    expect(page).toMatch(/defaultTdsSection: tdsSection === normalizeTdsSection\(savedTds\) \? undefined : tdsSection \|\| null/);
    expect(queries).toMatch(/default_tds_section: input\.defaultTdsSection\?\.trim\(\)\.toUpperCase\(\) \|\| null/);
  });
});
