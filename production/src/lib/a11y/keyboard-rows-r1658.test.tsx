// @vitest-environment jsdom
/**
 * R-1658 (24 Oct 2026) — clickable table rows must open from the keyboard (WCAG 2.1.1).
 *
 * The shared DataTable (bills, leads …) and six pages had `<tr onClick>` with no tabIndex and no
 * key handler: Tab skipped the row and a keyboard user could not open a bill, PO, expense, TDS
 * line, bill payment or item. Now every such row spreads rowActivation() (lib/a11y/clickable-row):
 * tabIndex 0, Enter/Space open it, an inset focus ring, native `row` role kept.
 *
 *  1. DataTable: Tab reaches the row; Enter and Space call onRowClick; Enter on the checkbox
 *     inside the row does not.
 *  2. The card's files hold no `<tr onClick>` without a key handler (element walk, not a
 *     line grep — accessibility-review §0b).
 *  3. App-wide ratchet: the count of such rows may only go down.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/components/providers/confirm-provider", () => ({ useAskText: () => async () => null }));

import { DataTable, type DataTableColumn } from "@/components/ui/data-table";

afterEach(cleanup);

type Row = { id: string };
const columns: DataTableColumn<Row>[] = [{ id: "id", header: "Bill", cell: (r) => r.id }];

describe("R-1658 — DataTable rows open from the keyboard", () => {
  function setup(selectable = false) {
    const onRowClick = vi.fn();
    render(
      <DataTable<Row>
        rows={[{ id: "B-1" }, { id: "B-2" }]}
        columns={columns}
        getRowId={(r) => r.id}
        noun="bill"
        mobileCard={(r) => <span>{r.id}</span>}
        onRowClick={onRowClick}
        {...(selectable ? { selected: new Set<string>(), onSelectedChange: vi.fn() } : {})}
      />,
    );
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    return { onRowClick, rows };
  }

  it("the row is in the tab order, keeps its row role and shows a focus ring", () => {
    const { rows } = setup();
    expect(rows[0].tagName).toBe("TR");
    expect(rows[0].tabIndex).toBe(0);
    expect(rows[0].className).toMatch(/focus-visible:outline/);
    rows[0].focus();
    expect(document.activeElement).toBe(rows[0]);
  });

  it("Enter and Space open the row, like a click", () => {
    const { rows, onRowClick } = setup();
    fireEvent.keyDown(rows[0], { key: "Enter" });
    fireEvent.keyDown(rows[1], { key: " " });
    fireEvent.keyDown(rows[1], { key: "a" });
    expect(onRowClick.mock.calls.map((c) => c[0].id)).toEqual(["B-1", "B-2"]);
    fireEvent.click(rows[0]);
    expect(onRowClick).toHaveBeenCalledTimes(3);
  });

  it("Enter on the checkbox inside a row does not open the row", () => {
    const { rows, onRowClick } = setup(true);
    const box = within(rows[0]).getByRole("checkbox");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("a table without onRowClick has no tab stop on its rows", () => {
    render(
      <DataTable<Row> rows={[{ id: "B-1" }]} columns={columns} getRowId={(r) => r.id} noun="bill"
        mobileCard={(r) => <span>{r.id}</span>} />,
    );
    const row = within(screen.getByRole("table")).getAllByRole("row")[1];
    expect(row.hasAttribute("tabindex")).toBe(false);
  });
});

/* ── source scan ─────────────────────────────────────────────────────────── */

/** Opening tag text from `i` ("<tr") to its `>`, skipping {…} and quoted strings. */
function openTag(src: string, i: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let k = i + 1; k < src.length; k++) {
    const ch = src[k];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (depth === 0 && (ch === '"' || ch === "'")) { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return src.slice(i, k + 1);
  }
  return src.slice(i);
}

/** Lines of `<tr … onClick …>` that have neither onKeyDown nor a rowActivation spread. */
function mouseOnlyRows(src: string): number[] {
  const out: number[] = [];
  const re = /<tr\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tag = openTag(src, m.index);
    if (/\bonClick=/.test(tag) && !/\bonKeyDown=|rowActivation\(/.test(tag)) {
      out.push(src.slice(0, m.index).split("\n").length);
    }
  }
  return out;
}

const SRC = join(process.cwd(), "src");
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" ? [] : tsxFiles(p);
    return n.endsWith(".tsx") && !n.includes(".test.") ? [p] : [];
  });
}

const CARD_FILES = [
  "components/ui/data-table.tsx",
  "app/(app)/purchase-orders/page.tsx",
  "app/(app)/accounting/expenses/page.tsx",
  "app/(app)/accounting/tds-receivable/page.tsx",
  "app/(app)/accounting/bill-payments/page.tsx",
  "app/(app)/items/page.tsx",
];

/** Measured 24 Oct 2026 after R-1658: 16 → 9. Left: cash-flow, customers/groups/[id] and
 *  reports/purchases (R-1134 put a real link/button inside those rows, the row click is a mouse
 *  extra), online-orders, quotes, subscriptions (its row was in another worker's lock — follow-up
 *  card), the two contacts import dialogs and customer-record-table. Fix one → lower this. */
const BASELINE = 9;

describe("R-1658 — no mouse-only <tr onClick>", () => {
  it("the detector sees a multi-line tag with an arrow function, and accepts the fix", () => {
    expect(mouseOnlyRows(`<tr\n key={a}\n onClick={() => go(">")}\n className="x">`)).toEqual([1]);
    expect(mouseOnlyRows(`<tr {...rowActivation(() => go(r))} className="x">`)).toEqual([]);
    expect(mouseOnlyRows(`<tr onClick={f} onKeyDown={k}>`)).toEqual([]);
    expect(mouseOnlyRows(`<tr className="x">`)).toEqual([]);
  });

  it.each(CARD_FILES)("src/%s has none", (f) => {
    expect(mouseOnlyRows(readFileSync(join(SRC, f), "utf8"))).toEqual([]);
  });

  it(`app-wide: at most ${BASELINE}`, () => {
    const files = tsxFiles(SRC);
    expect(files.length).toBeGreaterThan(200); // denominator — an empty walk must not pass
    const hits = files.flatMap((f) => mouseOnlyRows(readFileSync(f, "utf8")).map((l) => `${f.slice(SRC.length + 1).replace(/\\/g, "/")}:${l}`));
    expect(hits.length, hits.join("\n")).toBeLessThanOrEqual(BASELINE);
  });
});
