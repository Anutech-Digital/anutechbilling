/**
 * R-1805 (24 Oct 2026, found by the R-1654 worker): on a 375px phone the invoiced quote page
 * measured 459px wide. The strip under an invoiced quote put "Record balance payment",
 * "Send receipt" and "View invoice INV-ADPL-2026-27-0018" in a `flex gap-2` row, and every
 * Button is `whitespace-nowrap` — so the row could neither wrap nor shrink and pushed the
 * whole page sideways. Pinned: the row wraps, and the long "View invoice <number>" button may
 * break its text (height grows instead of width).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src/app/(app)/quotes/[id]/page.tsx"), "utf8");
const at = src.indexOf("View invoice {quote.invoice_id}");
const strip = src.slice(src.lastIndexOf('quote.payment_status === "invoiced" && quote.invoice_id', at), at);

describe("invoiced quote: the View invoice strip fits a phone (R-1805)", () => {
  it("found the strip", () => {
    expect(at).toBeGreaterThan(0);
    expect(strip.length).toBeGreaterThan(0);
  });
  it("the buttons row wraps instead of widening the page", () => {
    const rows = [...strip.matchAll(/<div className="([^"]*\bflex\b[^"]*)">/g)].map((m) => m[1]);
    const buttonRow = rows[rows.length - 1];
    expect(buttonRow).toMatch(/\bflex-wrap\b/);
    expect(buttonRow).toMatch(/\bmin-w-0\b/);
  });
  it("the View invoice button may break its text and never exceeds the row", () => {
    const btn = strip.slice(strip.lastIndexOf("<Button"));
    expect(btn).toMatch(/\basChild\b/);
    expect(btn).toMatch(/className="[^"]*\bwhitespace-normal\b[^"]*"/);
    expect(btn).toMatch(/className="[^"]*\bmax-w-full\b[^"]*"/);
    expect(btn).toMatch(/className="[^"]*\bh-auto\b[^"]*"/);
  });
});
