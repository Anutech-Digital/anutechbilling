/**
 * R-303 (7 Oct 2026) — screen-reader names on Setup, Settings, Scorecard, Performance and the
 * accounting Vendors / Reimbursements / Loans / Ledger pages.
 *
 * Same counter as a11y-ratchet.test.tsx (`node scripts/a11y-count.mjs --json`). These eight
 * pages held 64 of the app's untied labels / unnamed inputs; they stay at ZERO here so a new
 * one is caught on the page it lands on, not only as a nudge in the app-wide total.
 * (Kept in its own file: R-302 was extending the shared ratchet the same night.)
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

type Hit = { file: string; kind: string; lines: number[] };
type Report = { detail: Record<string, Hit[]> };

const report = (): Report =>
  JSON.parse(execFileSync(process.execPath, [join(process.cwd(), "scripts", "a11y-count.mjs"), "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })) as Report;

const ZERO_FILES = [
  "app/(app)/setup/page.tsx",
  "app/(app)/settings/page.tsx",
  "app/(app)/scorecard/page.tsx",
  "app/(app)/performance/page.tsx",
  "app/(app)/accounting/vendors/page.tsx",
  "app/(app)/accounting/reimbursements/page.tsx",
  "app/(app)/accounting/loans/page.tsx",
  "app/(app)/accounting/ledger/page.tsx",
];

describe("R-303 — these pages have no untied label and no unnamed input", () => {
  const r = report();
  const all = Object.values(r.detail).flat();

  it("the counter sees the pages at all (denominator first)", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it.each(ZERO_FILES)("%s", (file) => {
    const hits = all
      .filter((h) => h.file.split("\\").join("/").endsWith(file))
      .filter((h) => h.kind === "label-no-for" || h.kind === "input-no-name")
      .map((h) => `${h.kind}:${h.lines.join(",")}`);
    expect(hits).toEqual([]);
  });
});
