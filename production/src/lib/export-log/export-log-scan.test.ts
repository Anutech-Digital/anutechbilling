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
 *
 * R-2678 (11 Nov 2026): R-2665's test fixture (lib/testing/fixtures/hdfc-card-statement.ts) builds a
 * made-up .xls with XLSX.write() and turned this scan — and CI — red for two pushes. A test-only
 * helper goes in TEST_ONLY below; the last test proves no app file imports it, so a real export
 * cannot hide there. This file is on the push guard list now (scripts/ops/push-guard-suites.mjs)
 * and reads through the shared source cache (R-2564 / R-2649).
 */
import { describe, expect, it } from "vitest";
import { join, relative, sep } from "node:path";
import { listSourceFiles } from "@/lib/testing/walk-source"; // R-2649: one walk, no stat per entry
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared fresh read cache

const SRC = join(__dirname, "..", "..");

const TRIGGER = /\.download\s*=|\bdownload=\{|XLSX\.(?:writeFile|write)\(|\bwindow\.print\(\)/;

/** Test-only helpers under lib/testing: they build a file in memory for a test — no browser, no tenant data. */
const TEST_ONLY: Record<string, string> = {
  "lib/testing/fixtures/hdfc-card-statement.ts": "R-2665 test fixture: a made-up HDFC card .xls built in memory (XLSX.write gives bytes) for the statement-import tests",
};

/** True when `body` imports (or requires) the module whose file name, without extension, is `base`. */
function importsModule(body: string, base: string): boolean {
  const quoted = body.match(/["'`][^"'`\n]+["'`]/g) ?? [];
  return quoted.some((q) => {
    const spec = q.slice(1, -1).replace(/\.tsx?$/, "");
    return spec === base || spec.endsWith(`/${base}`);
  });
}

const ALLOW: Record<string, string> = {
  ...TEST_ONLY,
  // the shared helpers — they call logExport for every caller
  "lib/csv.ts": "downloadCSV logs (download-logs.test.ts)",
  "lib/reports/print.ts": "printReport logs (download-logs.test.ts)",
  "lib/exports/download-server-export.ts": "R-1007: the server route api/exports/[kind] logs (log_export) before it sends the file",
  // one business document the user is looking at, not a bulk export
  "lib/pdf/index.tsx": "single quote / invoice / receipt / payslip PDF",
  "components/features/quotes/tax-invoice-dialog.tsx": "single invoice PDF",
  "components/features/subscriptions/invoice-peek-dialog.tsx": "single invoice PDF",
  "components/features/quotes/quote-preview-dialog.tsx": "prints the one quote on screen",
  "app/(public)/quote/[id]/accept/quote-accept-view.tsx": "public quote page, the customer prints their own quote",
  "site/components/quote/QuoteBuilder.tsx": "public website quote builder, no company session",
  "components/features/documents/doc-viewer-dialog.tsx": "opens one uploaded attachment",
  "app/(app)/support/page.tsx": "opens one ticket attachment image",
  // empty sample templates for the importers — no data in them
  "components/features/customers/import-customers-dialog.tsx": "sample CSV template, no data",
  "components/features/leads/import-csv-dialog.tsx": "sample CSV template, no data",
  "components/features/coldcall/cold-call-ui.tsx": "Cold Calling sample CSV (constant SAMPLE_CSV), no tenant data — R-1776",
  "components/features/invoices/import-zoho-invoices-dialog.tsx": "sample CSV template (constant SAMPLE_ZOHO_INVOICE_CSV), no tenant data",
  // (R-1795, 23 Oct: the four Billing screens — customers, invoices, payments, reconcile-google —
  // left this list; they call downloadCSV now, which logs.)
};

// Every non-test .ts/.tsx under src/ (Prisma's generated client skipped — not our code, R-2564).
const files = listSourceFiles(SRC, (name) => /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name))
  .map((p) => ({ rel: relative(SRC, p).split(sep).join("/"), body: readSource(p) }));
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

  it("R-2678: a test-only helper on the allowlist is imported by tests only, never by app code", () => {
    expect(Object.keys(TEST_ONLY).length).toBeGreaterThan(0);
    for (const rel of Object.keys(TEST_ONLY)) {
      expect(rel, "TEST_ONLY is for src/lib/testing only — an app file calls logExport").toMatch(/^lib\/testing\//);
      const base = rel.replace(/^.*\//, "").replace(/\.tsx?$/, "");
      // `files` holds no *.test.ts(x), so every hit is app code pulling the fixture in.
      const importers = files.filter((f) => f.rel !== rel && importsModule(f.body, base)).map((f) => f.rel);
      expect(importers, `${rel} is a test fixture — app code must not import it`).toEqual([]);
    }
  });

  it("R-2678: the importer check is not blind", () => {
    expect(importsModule(`import { hdfcCardXls } from "@/lib/testing/fixtures/hdfc-card-statement";`, "hdfc-card-statement")).toBe(true);
    expect(importsModule(`const m = await import('./hdfc-card-statement.ts');`, "hdfc-card-statement")).toBe(true);
    expect(importsModule(`import { x } from "@/lib/banking/statement-hdfc-card";`, "hdfc-card-statement")).toBe(false);
    // the real importer the app must never have: prove the scan sees a known import of a real module
    const csvUsers = files.filter((f) => importsModule(f.body, "csv")).length;
    expect(csvUsers).toBeGreaterThan(5);
  });
});
