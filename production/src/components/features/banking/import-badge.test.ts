/* R-1692 — the Parse summary badge agrees with the warning and the Import button. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { importBadge, linesLabel } from "./import-badge";

describe("import badge (R-1692)", () => {
  it("the same statement pasted again: 6 parsed, 0 new → '0 new to import', not '6 ready'", () => {
    expect(importBadge({ parsedCount: 6, freshCount: 0 })).toEqual({ text: "0 new to import", kind: "muted" });
  });
  it("some new lines → counts only the new ones", () => {
    expect(importBadge({ parsedCount: 6, freshCount: 2 })).toEqual({ text: "2 new to import", kind: "success" });
  });
  it("'1 line', never '1 lines'", () => {
    expect(linesLabel(1)).toBe("1 line");
    expect(linesLabel(0)).toBe("0 lines");
    expect(linesLabel(6)).toBe("6 lines");
  });
  it("nothing parsed → couldn't parse", () => {
    expect(importBadge({ parsedCount: 0, freshCount: 0 }).kind).toBe("danger");
  });
  it("the dialog's badge reads the fresh count, not every parsed row", () => {
    const src = fs.readFileSync(path.join(__dirname, "import-statement-dialog.tsx"), "utf8");
    expect(src).not.toMatch(/parsed\.rows\.length\}\s*ready to import/);
    expect(src).toMatch(/importBadge\(\{\s*parsedCount: parsed\.rows\.length,\s*freshCount\s*\}\)/);
  });
});
