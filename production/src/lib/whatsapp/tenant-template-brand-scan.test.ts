/**
 * R-1924 (G-ONBOARD OB-3): tenant-facing message templates never carry Anutech's own
 * name, bank or UPI. A new company's customer must never be asked to pay Anutech.
 *
 * Scans every non-test source file whose path says "template", plus the template
 * builders/previews named below, for an "anutech" or "ICICI" literal (any case).
 * The sender's details come from the logged-in tenant (useCurrentUser) instead.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");
const BRAND = /anutech|icici/i;

/** Template builders and previews whose file name does not say "template". */
const NAMED = [
  "components/shared/whatsapp-action-dialog.tsx",
  "lib/whatsapp/action-templates.ts",
  "components/features/campaigns/campaign-composer-dialog.tsx",
  "app/(app)/marketing/whatsapp/page.tsx",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");
const templateFiles = walk(ROOT).map(rel).filter((p) => /template/i.test(p));
const scanned = [...new Set([...templateFiles, ...NAMED])];

describe("R-1924 — no Anutech name / ICICI bank in tenant-facing templates", () => {
  it("every NAMED file still exists (a moved file must be re-listed)", () => {
    expect(NAMED.filter((p) => !existsSync(join(ROOT, p)))).toEqual([]);
  });

  it("scans the template files it is meant to", () => {
    expect(scanned).toEqual(expect.arrayContaining(["lib/queries/campaign-templates.ts", ...NAMED]));
  });

  it("no scanned file has an anutech / ICICI literal", () => {
    const offenders = scanned.flatMap((p) =>
      readFileSync(join(ROOT, p), "utf8").split("\n")
        .map((line, i) => (BRAND.test(line) ? `${p}:${i + 1}: ${line.trim()}` : null))
        .filter((x): x is string => x !== null));
    expect(offenders).toEqual([]);
  });
});
