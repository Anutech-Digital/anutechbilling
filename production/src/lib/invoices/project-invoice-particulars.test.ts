/**
 * R-010 — the document side: a project invoice's particulars must reach the screen and
 * the PDF, and the SAC printed must be the line's own.
 *
 * The database half (the line is written, and old invoices are backfilled) is proved in
 * supabase/tests/project_invoice_line_items.test.sql. What is left is an ABSENCE and a
 * literal — a screen that never read `invoice.line_items`, and `998313` typed into three
 * documents by hand — and neither is visible to a test of a function (L85). So these are
 * source scans.
 *
 * Every file is read with comments stripped, because the prose explaining a removed
 * literal must not satisfy a scan looking for it (L46). That has caught me three times
 * in this repo, once on a security test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SAAS_HSN } from "@/lib/gst/hsn";

const strip = (f: string) =>
  readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|\s)\/\/[^\n]*/gm, "$1");

const PAGE   = "src/app/(app)/invoices/invoice-detail.tsx"; // R-086: the invoice detail, now its own page
const DIALOG = "src/components/features/quotes/tax-invoice-dialog.tsx";
const PDF    = "src/lib/pdf/InvoicePDF.tsx";

describe("the invoice screen reads the invoice's own lines", () => {
  it("falls back from the quote to invoice.line_items", () => {
    /* A project-milestone invoice is raised from a milestone and has no quote; a
       subscription instalment leaves quote_id null deliberately (build-props would
       otherwise print the whole quote's total on one instalment). Both write their own
       line_items, and reading only the quote is why both printed nothing. */
    expect(strip(PAGE)).toContain("quote?.line_items ?? invoice.line_items ?? []");
  });
});

describe("the SAC on a line is the line's own", () => {
  it.each([[DIALOG, "tax invoice dialog"], [PDF, "invoice PDF"]])("%s (%s)", (file) => {
    const src = strip(file);
    expect(src).toContain("li.hsn ?? SAAS_HSN");
    /* No hand-typed copy left anywhere in the file — not in the table, not in the
       footer. lib/gst/hsn.ts exists precisely because this value was written out in
       three places, and these documents were two of them. */
    expect(src, `${file} still hardcodes a SAC`).not.toContain(SAAS_HSN);
    expect(src, `${file} hardcodes the project SAC`).not.toContain("998314");
  });

  it("the PDF footer summarises the codes actually on the invoice", () => {
    const src = strip(PDF);
    expect(src).toContain("sacSummary");
    /* The old footer also mis-described the code: lib/gst/hsn.ts records that 998313 is
       IT consulting and support, NOT software licensing, and that this string is what
       goes into GSTR-1 Table 12 as the Description. */
    expect(src).not.toMatch(/Software licensing/i);
  });
});

describe("an invoice with no description says what that means", () => {
  it.each([[DIALOG, "dialog"], [PDF, "PDF"]])("%s (%s)", (file) => {
    const src = strip(file);
    /* The old copy blamed "the parent quote", which a project invoice does not have —
       so it named a cause that could not be acted on, and gave no next step (§24). */
    expect(src).not.toMatch(/No line items recorded on the parent quote/);
    expect(src).toMatch(/Rule 46/);
    expect(src).toMatch(/credit note/i);
  });
});
