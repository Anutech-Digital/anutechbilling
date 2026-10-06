/**
 * R-270: a money report that fails to load must say so — not fall through to
 * `data ?? 0` and print ₹0, which reads as "you have nothing" (or, on Aging,
 * "No outstanding receivables. Nice." while customers owe money).
 *
 * Source scan: every accounting page that shows a loading state must also handle
 * the failed state (`isError`, or the shared <LoadError>/<LoadErrorBanner>).
 * KNOWN_GAPS are the pages not yet fixed (their own cards). The list may only
 * shrink: a page that gets fixed must be removed from it, and no new page may
 * join it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "src/app/(app)/accounting");

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...pages(full));
    else if (e.name === "page.tsx") out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const handlesFailure = (src: string) => /\bisError\b|\bLoadError(Banner)?\b/.test(src);

/** Fixed by R-270 — each must use the shared error state. */
const R270_PAGES = [
  "page.tsx",
  "aging/page.tsx",
  "balance-sheet/page.tsx",
  "itr/page.tsx",
  "ledger/page.tsx",
  "pnl/page.tsx",
  "profitability/page.tsx",
  "tds-receivable/page.tsx",
];

/** Not fixed yet — separate cards. Only ever remove from this list. */
const KNOWN_GAPS = [
  "advances/page.tsx",
  "banking/[id]/page.tsx",
  "banking/rules/page.tsx",
  "bill-payments/page.tsx",
  "business-loans/page.tsx",
  "cash-flow/page.tsx",
  "day-book/page.tsx",
  "esi-register/page.tsx",
  "gst/page.tsx",
  "loans/page.tsx",
  "payment-runs/page.tsx",
  "prepaid/page.tsx",
  "reimbursements/page.tsx",
  "salary-register/page.tsx",
  "saas-metrics/page.tsx",
  "tds-receivable/year-end/page.tsx",
  "vendors/page.tsx",
];

describe("accounting pages show an error state, not ₹0 (R-270)", () => {
  const all = pages(ROOT).map((f) => ({ file: rel(f), src: fs.readFileSync(f, "utf8") }));
  const withLoading = all.filter((p) => /\bisLoading\b/.test(p.src));

  it("finds the pages it is meant to scan", () => {
    expect(withLoading.length).toBeGreaterThan(20);
  });

  it("the R-270 reports use the shared LoadError / LoadErrorBanner", () => {
    const missing = R270_PAGES.filter((f) => {
      const p = all.find((x) => x.file === f);
      return !p || !/from "@\/components\/shared\/load-error"/.test(p.src);
    });
    expect(missing, `These reports still have no shared error state:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("no accounting page with a loading state lacks a failed state (except the known gaps)", () => {
    const offenders = withLoading
      .filter((p) => !handlesFailure(p.src) && !KNOWN_GAPS.includes(p.file))
      .map((p) => p.file);
    expect(
      offenders,
      `These pages show a skeleton while loading but print ₹0 / an empty state when the fetch fails. `
      + `Render <LoadError what="…" onRetry={() => q.refetch()} /> on isError:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the known-gaps list only shrinks: a fixed page must be taken off it", () => {
    const fixedButListed = KNOWN_GAPS.filter((f) => {
      const p = all.find((x) => x.file === f);
      return !p || handlesFailure(p.src);
    });
    expect(fixedButListed, `Remove these from KNOWN_GAPS — they now handle failure (or no longer exist):\n  ${fixedButListed.join("\n  ")}`).toEqual([]);
  });
});
