/**
 * R-1633: a GST Tax Invoice is never issued by a bare click. Every screen that issues one in a
 * single tap goes through ConfirmIssueDialog first (number, customer, GSTIN, amount with GST,
 * date). Source scan — the call sites below were each a one-click issue before R-1633 (the
 * invoices list since 23 Aug 2026).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

const PAGES = [
  { file: "src/app/(app)/quotes/[id]/page.tsx", call: String.raw`generateInvoice\.mutate\(` },
  { file: "src/app/(app)/projects/[id]/page.tsx", call: String.raw`(raise\.mutateAsync\(|handleRaise\()` },
  { file: "src/app/(app)/invoices/page.tsx", call: String.raw`generateInvoice\.mutate\(` },
];

describe("R-1633 — every one-click Tax Invoice asks first", () => {
  for (const { file, call } of PAGES) {
    it(`${file} renders ConfirmIssueDialog`, () => {
      expect(read(file)).toMatch(/<ConfirmIssueDialog\b/);
    });

    it(`${file} never issues straight from a button's onClick`, () => {
      /* onClick={() => generateInvoice.mutate(…)} — the shape every one of them had. */
      expect(read(file)).not.toMatch(new RegExp(String.raw`onClick=\{\(\)\s*=>\s*` + call));
    });
  }
});
