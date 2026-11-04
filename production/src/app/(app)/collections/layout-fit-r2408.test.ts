/**
 * R-2408 — the Payment Follow-up table fits a 1280 laptop with the sidebar open, the Action
 * column inside the card, and rows stay one line high (audit #1: 4 stacked buttons made each row
 * ~110px, 16 rows = 8 screens). jsdom has no layout, so this proves the structure — same pattern
 * as renewals/layout-fit.test.ts (R-2403) and subscriptions/table-fit-r2263.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKLIST_COLS, WORKLIST_FLEX_MIN_PX, WORKLIST_TABLE_BUDGET_PX, worklistCols } from "./worklist";

const page = readFileSync("src/app/(app)/collections/page.tsx", "utf8");
const cells = readFileSync("src/app/(app)/collections/owed-cells.tsx", "utf8");
const actions = readFileSync("src/app/(app)/collections/row-actions.tsx", "utf8");

describe("R-2408 — Payment Follow-up table fits its card at 1280", () => {
  it("column budget: fixed columns + flexible minimums ≤ 944px, Action inside it — R-2413 tick-box column included", () => {
    const fixed = WORKLIST_COLS.reduce((s, c) => s + (c.width ?? 0), 0);
    const flex = WORKLIST_COLS.filter((c) => c.width == null);
    expect(WORKLIST_TABLE_BUDGET_PX).toBeLessThanOrEqual(944);
    expect(flex.map((c) => c.key)).toEqual(["customer", "owed"]);
    expect(fixed + flex.length * WORKLIST_FLEX_MIN_PX).toBeLessThanOrEqual(WORKLIST_TABLE_BUDGET_PX);
    expect(WORKLIST_COLS.map((c) => c.key)).toEqual(["select", "customer", "owed", "amount", "late", "promise", "next", "owner", "action"]);
    /* The flexible floor stays wide enough for a customer name (it truncates with a title past that). */
    expect(WORKLIST_FLEX_MIN_PX).toBeGreaterThanOrEqual(136);
    /* The tick box (16px) + its 12px left / 4px right padding fit the select column exactly. */
    expect(WORKLIST_COLS[0].width).toBe(32);
    expect(page).toMatch(/className="pl-3 pr-1 py-2"><RowTick /);
  });

  it("people who may not bulk-act get no tick-box column (the budget only shrinks)", () => {
    expect(worklistCols(false).map((c) => c.key)).not.toContain("select");
    expect(worklistCols(true)).toBe(WORKLIST_COLS);
    expect(page).toMatch(/const cols = worklistCols\(canBulk\);/);
  });

  it("the table is fixed-layout, driven by that budget, one <th> per column, no min-width", () => {
    expect(page).toMatch(/<table className="w-full table-fixed text-sm">\s*<colgroup>\s*\{cols\.map/);
    expect(page).not.toMatch(/<table className="[^"]*min-w-/);
    expect(page).toMatch(/<thead[\s\S]*?cols\.map\(\(c\) => \(c\.key === "select"[\s\S]*?<th\b[\s\S]*?<th key=\{c\.key\}/);
  });

  it("rows stay one line: truncated name / note / owner, the owed cell shows one line until opened", () => {
    const body = page.slice(page.indexOf("<tbody"), page.indexOf("</tbody>"));
    expect(body).toMatch(/font-medium text-ink truncate/);
    expect(body).toMatch(/text-2xs text-ink-3 truncate/);
    expect(body).not.toMatch(/line-clamp-2/);
    expect(body).toMatch(/<td className="px-3 py-2"><RowActions /);
    expect(cells).toMatch(/className="font-mono text-xs truncate"/);
    expect(cells).toMatch(/\+\$\{lines - 1\} more/);
  });

  it("the action cell is one button + an icon menu side by side (no stack of four)", () => {
    expect(actions).toMatch(/className=\{`flex items-center gap-1\.5/);
    expect((actions.match(/<Button\b/g) ?? []).length).toBe(2);   // Follow-up OR Record payment
    expect(actions).toMatch(/h-8 w-8/);
  });

  it("≥12 rows per screen at 1280×800: compact row padding (py-2) everywhere in the body", () => {
    const body = page.slice(page.indexOf("<tbody"), page.indexOf("</tbody>"));
    expect(body).not.toMatch(/py-3/);
    /* R-2413: the tick-box cell is pl-3 pr-1 py-2 (same row height), every other cell px-3 py-2. */
    expect((body.match(/px-3 py-2/g) ?? []).length).toBe(WORKLIST_COLS.length - 1);
    expect((body.match(/pl-3 pr-1 py-2/g) ?? []).length).toBe(1);
  });
});
