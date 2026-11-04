/**
 * R-2264 (Design D4) — on a 1280px laptop with the sidebar open the Quotes desktop table
 * needed 1,089px but its card had ~944–959px, so the Actions column ("Generate invoice")
 * sat behind a horizontal scroll. The Quote column took 175px for a 5-character chip
 * while Customer and Plan wrapped onto 2–3 lines (avg row 103px).
 *
 * jsdom has no layout, so this proves the STRUCTURE that makes it fit:
 *  - a fixed layout with a column budget whose fixed columns + a readable minimum for the
 *    two flexible columns (Customer, Plan) stays within 944px;
 *  - Customer and Plan are one line (truncate) with the full text in a title tooltip;
 *  - each row shows at most ONE action button next to the ⋯ menu, and none of them is
 *    primary (one primary per view — the page's "New quote");
 *  - every action is still reachable from the ⋯ menu.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  QUOTES_TABLE_COLS,
  QUOTES_TABLE_BUDGET_PX,
  QUOTES_FLEX_MIN_PX,
} from "@/components/features/quotes/quotes-table-cols";

const page = readFileSync("src/app/(app)/quotes/page.tsx", "utf8");

/** The desktop table block: from its marker comment to the table footer. */
function desktopTable(): string {
  const start = page.indexOf("{/* Desktop table — large viewports");
  const end = page.indexOf("{/* Table footer", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
}

/** The Actions cell of the desktop table (up to the ⋯ menu). */
function actionsCell(): string {
  const t = desktopTable();
  const start = t.indexOf('data-col="actions"');
  const end = t.indexOf("<DropdownMenu>", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return t.slice(start, end);
}

describe("R-2264 — Quotes table fits a 1280 laptop", () => {
  it("column budget: Quote ≈100px, fixed columns + flexible minimums ≤ 944px", () => {
    const quote = QUOTES_TABLE_COLS.find((c) => c.key === "quote");
    expect(quote?.width).toBeLessThanOrEqual(104);
    const fixed = QUOTES_TABLE_COLS.reduce((s, c) => s + (c.width ?? 0), 0);
    const flex = QUOTES_TABLE_COLS.filter((c) => c.width == null);
    expect(flex.map((c) => c.key)).toEqual(["customer", "plan"]);
    expect(QUOTES_TABLE_BUDGET_PX).toBeLessThanOrEqual(944);
    expect(fixed + flex.length * QUOTES_FLEX_MIN_PX).toBeLessThanOrEqual(QUOTES_TABLE_BUDGET_PX);
    // Order matches the header row.
    expect(QUOTES_TABLE_COLS.map((c) => c.key)).toEqual([
      "quote", "customer", "plan", "amount", "margin", "status", "validity", "actions",
    ]);
  });

  it("the table uses a fixed layout driven by that budget (no auto widths)", () => {
    const t = desktopTable();
    expect(t).toMatch(/<table className="w-full table-fixed"/);
    expect(t).toContain("<colgroup>");
    expect(t).toContain("QUOTES_TABLE_COLS.map");
  });

  it("Customer and Plan are one line with the full text on hover", () => {
    const t = desktopTable();
    expect(t).toMatch(/className="[^"]*\btruncate\b[^"]*" title=\{cleanDisplayName\(partyOf\(q\)\)\}/);
    expect(t).toMatch(/className="[^"]*\btruncate\b[^"]*" title=\{q\.plan \?\? undefined\}/);
    expect(t).not.toContain("break-words max-w-[220px]");
    expect(t).not.toContain("break-words max-w-[240px]");
  });

  it("each row shows at most one action button, and none is primary", () => {
    const cell = actionsCell();
    expect(cell).not.toContain('variant="primary"');
    // The sent/viewed branch used to show WhatsApp AND Open side by side.
    expect(cell).not.toMatch(/>Open<\/Link>/);
    expect(cell).not.toContain('<div className="flex gap-1">');
    // The one button never forces the column wider: it shrinks and truncates.
    expect(cell).toContain("min-w-0");
  });

  it("every action stays reachable from the ⋯ menu", () => {
    const t = desktopTable();
    const menu = t.slice(t.indexOf("<DropdownMenuContent"), t.indexOf("</DropdownMenuContent>"));
    for (const label of [
      "View PDF preview",
      "Copy quote link",
      "Send / nudge on WhatsApp",
      "Open / edit",
      "Send / nudge",
      "Convert to invoice",
      "Duplicate &amp; revise",
      "Delete",
    ]) {
      expect(menu).toContain(label);
    }
    // Keyboard / screen reader: the ⋯ trigger is a real button with a name.
    expect(t).toMatch(/aria-label=\{`Actions for quote \$\{q\.id\}`\}/);
  });
});
