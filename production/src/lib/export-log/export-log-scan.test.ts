/**
 * R-1006 scan — a NEW export without logging fails here.
 *
 * Every file under src/ that hands the browser a file (`a.download = …`, `download={…}`, an
 * XLSX writer) or prints a report (`window.print()`) must call `logExport(` itself. Most export
 * buttons need nothing: they call `downloadCSV` from lib/csv or `printReport` from
 * lib/reports/print, and those two log for every caller (download-logs.test.ts proves it).
 *
 * The allowlist is for downloads that are NOT a data export, each with its reason — and for the
 * screens whose owner has to add the call (CLAUDE.local.md: that area is changed by its owner;
 * the request is in docs/CROSS-TEAM-REQUESTS.md). Do not add a data export here — call
 * logExport instead.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(__dirname, "..", "..");

const TRIGGER = /\.download\s*=|\bdownload=\{|XLSX\.(?:writeFile|write)\(|\bwindow\.print\(\)/;

const ALLOW: Record<string, string> = {
  // the shared helpers — they call logExport for every caller
  "lib/csv.ts": "downloadCSV logs (download-logs.test.ts)",
  "lib/reports/print.ts": "printReport logs (download-logs.test.ts)",
  // one business document the user is looking at, not a bulk export
  "lib/pdf/index.tsx": "single quote / invoice / receipt / payslip PDF",
  "components/features/quotes/tax-invoice-dialog.tsx": "single invoice PDF",
  "components/features/quotes/quote-preview-dialog.tsx": "prints the one quote on screen",
  "app/(public)/quote/[id]/accept/quote-accept-view.tsx": "public quote page, the customer prints their own quote",
  "site/components/quote/QuoteBuilder.tsx": "public website quote builder, no company session",
  "components/features/documents/doc-viewer-dialog.tsx": "opens one uploaded attachment",
  "app/(app)/support/page.tsx": "opens one ticket attachment image",
  // empty sample templates for the importers — no data in them
  "components/features/customers/import-customers-dialog.tsx": "sample CSV template, no data",
  "components/features/leads/import-csv-dialog.tsx": "sample CSV template, no data",
  // OWNER TO ADD logExport (docs/CROSS-TEAM-REQUESTS.md, R-1006) — remove the line once done
  "app/(app)/customers/page.tsx": "R-1006 pending: Billing (Abhishek) — CSV built by hand at the bulk export",
  "app/(app)/invoices/page.tsx": "R-1006 pending: Billing (Abhishek) — selected-invoices CSV",
  "app/(app)/payments/page.tsx": "R-1006 pending: Billing (Abhishek) — payments CSV",
  "components/features/subscriptions/reconcile-google-dialog.tsx": "R-1006 pending: Billing (Abhishek) — reconcile bucket CSV",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((p) => ({ rel: relative(SRC, p).split(sep).join("/"), body: readFileSync(p, "utf8") }));
const triggering = files.filter((f) => TRIGGER.test(f.body));

describe("R-1006: every export is logged", () => {
  it("finds the export sites (the scan is not blind)", () => {
    expect(triggering.length).toBeGreaterThan(15);
    for (const known of ["app/(app)/accounting/esi-register/page.tsx", "lib/queries/backups.ts", "lib/csv.ts"]) {
      expect(triggering.map((f) => f.rel)).toContain(known);
    }
  });

  it("each file that downloads or prints data calls logExport", () => {
    const missing = triggering
      .filter((f) => !(f.rel in ALLOW))
      .filter((f) => !/\blogExport\(/.test(f.body))
      .map((f) => f.rel);
    expect(missing, "add `void logExport({ what, rowCount, format })` next to the download (src/lib/export-log)").toEqual([]);
  });

  it("the shared helpers really call logExport", () => {
    for (const rel of ["lib/csv.ts", "lib/reports/print.ts"]) {
      expect(files.find((f) => f.rel === rel)?.body).toMatch(/\blogExport\(/);
    }
  });

  it("allowlist has no stale entries", () => {
    const stale = Object.keys(ALLOW).filter((rel) => {
      const f = files.find((x) => x.rel === rel);
      return !f || !TRIGGER.test(f.body) || (ALLOW[rel].startsWith("R-1006 pending") && /\blogExport\(/.test(f.body));
    });
    expect(stale, "remove these from ALLOW").toEqual([]);
  });
});
