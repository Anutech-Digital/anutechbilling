// R-1654 (23 Oct 2026): on a 375px phone the GST invoice / quote / receipt previews cut the
// Amount column off. The document had p-10 (80px of a ~343px sheet), and the line-items table
// was a fixed 384px of w-8/20/16/24/28 columns inside overflow-hidden, so Amount (₹) sat past
// the right edge, unreachable. Totals and the Amount-due box were a fixed w-80.
//
// Fix is layout only: p-4 on a phone (sm:p-10 / print:p-0 keep the A4 look), column widths
// only from sm: up, the table box scrolls instead of clipping, totals w-full on a phone.
// jsdom has no layout engine, so this guards the classes; the 375px check was done in the
// browser (scrollWidth <= clientWidth, Amount header inside the dialog). The PDFs are separate
// react-pdf templates (lib/pdf) and are untouched.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "src/components/features/quotes");
const FILES = ["tax-invoice-dialog.tsx", "quote-preview-dialog.tsx", "receipt-voucher-dialog.tsx"];

function documentSource(file: string): string {
  const src = readFileSync(join(dir, file), "utf8");
  const start = src.indexOf('className="bg-paper ');
  expect(start, `${file}: document wrapper not found`).toBeGreaterThan(-1);
  return src.slice(start);
}

describe.each(FILES)("%s document at phone width", (file) => {
  it("pads p-4 on a phone and keeps p-10 from sm: up and p-0 in print", () => {
    const doc = documentSource(file);
    const cls = doc.slice(0, doc.indexOf('"', 'className="'.length + 1));
    expect(cls).toMatch(/\bp-4\b/);
    expect(cls).toMatch(/\bsm:p-10\b/);
    expect(cls).toMatch(/\bprint:p-0\b/);
    expect(cls).not.toMatch(/(^|\s)p-10\b/);
  });

  it("table header cells have no fixed width below sm:", () => {
    const ths = documentSource(file).match(/<th className="[^"]*"/g) ?? [];
    expect(ths.length).toBeGreaterThan(0);
    for (const th of ths) expect(th, th).not.toMatch(/(?<![:\w-])w-(8|16|20|24|28|32|36)\b/);
  });

  it("no fixed w-80 block (totals / amount due) below sm:", () => {
    expect(documentSource(file)).not.toMatch(/(?<![:\w-])w-80\b/);
  });

  it("the toolbar row wraps (a one-line 459px toolbar widened the whole sheet)", () => {
    const src = readFileSync(join(dir, file), "utf8");
    const at = src.indexOf("sticky top-0 z-10 print:hidden");
    const row = src.slice(src.lastIndexOf("<div", at), at);
    expect(row).toMatch(/\bflex-wrap\b/);
  });

  it("the bordered line-items box scrolls rather than clipping", () => {
    expect(documentSource(file)).not.toMatch(/border-2 border-ink rounded-md overflow-hidden/);
  });
});
