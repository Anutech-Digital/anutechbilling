/** R-316 — the MRR history card's on-screen text is English (no Hinglish UI copy). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("Reports MRR history copy", () => {
  it("says when the first snapshot is taken, in English", () => {
    expect(src).toContain("The first snapshot is taken on the 1st of next month.");
    expect(src).not.toContain("Pehla snapshot");
  });
  it("short-history note is English", () => {
    expect(src).toContain("History starts in {trendData[0].month}.");
    expect(src).not.toContain("se shuru hui hai");
  });
});
