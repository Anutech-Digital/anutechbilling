/**
 * R-734 (23 Oct 2026): every CSV export escapes through lib/csv.ts `csvEscape`.
 *
 * A home-made `"…".replace(/"/g, '""')` quotes commas but lets a cell starting with `=`, `+`,
 * `@` or `-cmd` through, so a customer named `=HYPERLINK(…)` runs as a formula on the CA's
 * laptop. `csvEscape` neutralises those (deFormula). This scan fails when a new file grows its
 * own CSV quoting. KNOWN is the measured remainder — it may only shrink.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");
const LOCAL_CSV_QUOTE = /replace\(\/"\/g,\s*'""'\)/;

/** Not CSV, or the shared helper itself. */
const NOT_CSV = new Set([
  "lib/csv.ts",                 // the one shared escaper
  "server/postgrest/build.ts",  // SQL identifier quoting, not a spreadsheet cell
]);

/** Files outside R-734's scope that still quote by hand. Remove a line when its file moves to csvEscape. */
const KNOWN = new Set([
  "components/features/coldcall/cold-call-ui.tsx",
  "components/features/coldcall/contact-dialogs.tsx",
  "lib/banking/statement-parse.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const offenders = walk(ROOT)
  .filter((p) => LOCAL_CSV_QUOTE.test(readFileSync(p, "utf8")))
  .map((p) => relative(ROOT, p).replace(/\\/g, "/"))
  .filter((p) => !NOT_CSV.has(p));

describe("R-734 — CSV exports use the shared csvEscape (formula-safe)", () => {
  it("no file outside KNOWN quotes CSV cells by hand", () => {
    expect(offenders.filter((p) => !KNOWN.has(p))).toEqual([]);
  });

  it("KNOWN has no stale lines (a fixed file must leave the list)", () => {
    expect([...KNOWN].filter((p) => !offenders.includes(p))).toEqual([]);
  });

  it("the R-734 exports keep their export log (R-1006) and use csvEscape", () => {
    for (const p of [
      "app/(app)/accounting/esi-register/page.tsx",
      "app/(app)/accounting/salary-register/page.tsx",
      "app/(app)/accounting/expenses/page.tsx",
      "app/(app)/accounting/gst/download-csv.ts",
      "app/(app)/accounting/tds-receivable/year-end/page.tsx",
      "app/(app)/reports/purchases/page.tsx",
    ]) {
      const s = readFileSync(join(ROOT, p), "utf8");
      expect(s, p).toMatch(/logExport\(/);
      expect(s, p).toMatch(/csvEscape/);
    }
  });
});
