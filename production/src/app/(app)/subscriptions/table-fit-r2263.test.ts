/**
 * R-2263 (Design D3) — on a 1280px laptop with the sidebar open the Subscriptions desktop
 * table needed ~1,435px but its card had ~944px, so Renewal, Status and the row action sat
 * behind a horizontal scroll (design audit 31 Oct, row 3).
 *
 * jsdom has no layout, so this proves the STRUCTURE that makes it fit (same pattern as
 * quotes/table-fit-r2264.test.ts):
 *  - a fixed layout with a column budget whose fixed columns + a readable minimum for the
 *    two flexible columns (Customer, Plan) stays within 944px;
 *  - Renewal and Status are in that budget; Started, Vendor, Seats and MRR no longer have
 *    columns of their own (Started under the renewal date, Vendor a short badge with an
 *    accessible name, Seats + MRR one cell) — and every one of those sorts is still there;
 *  - the row action is one ⋮ menu (a named button) that still offers Renew where the row
 *    button used to be, plus Open details / Manage seats / Correct details.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SUBS_TABLE_COLS,
  SUBS_TABLE_BUDGET_PX,
  SUBS_FLEX_MIN_PX,
  vendorShort,
} from "@/components/features/subscriptions/subs-table-cols";

const page = readFileSync("src/app/(app)/subscriptions/page.tsx", "utf8");

/** The main desktop table block: from its marker comment to the trials table. */
function desktopTable(): string {
  const start = page.indexOf("{/* Desktop table — viewports >= 1280px */}");
  const end = page.indexOf("{/* Trials tab", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
}

function headerRow(): string {
  const t = desktopTable();
  return t.slice(t.indexOf("<thead"), t.indexOf("</thead>"));
}

describe("R-2263 — Subscriptions table fits a 1280 laptop", () => {
  it("column budget: fixed columns + flexible minimums ≤ 944px, Renewal + Status inside it", () => {
    const fixed = SUBS_TABLE_COLS.reduce((s, c) => s + (c.width ?? 0), 0);
    const flex = SUBS_TABLE_COLS.filter((c) => c.width == null);
    expect(flex.map((c) => c.key)).toEqual(["customer", "plan"]);
    expect(SUBS_TABLE_BUDGET_PX).toBeLessThanOrEqual(944);
    expect(fixed + flex.length * SUBS_FLEX_MIN_PX).toBeLessThanOrEqual(SUBS_TABLE_BUDGET_PX);
    expect(SUBS_TABLE_COLS.map((c) => c.key)).toEqual([
      "select", "customer", "plan", "seats_mrr", "margin", "renewal", "status", "actions",
    ]);
  });

  it("the table uses a fixed layout driven by that budget (no auto widths)", () => {
    const t = desktopTable();
    expect(t).toMatch(/<table className="w-full table-fixed"/);
    expect(t).toMatch(/<table className="w-full table-fixed">\s*<SubsColGroup \/>/);
    const cg = page.slice(page.indexOf("function SubsColGroup()"), page.indexOf("export default function SubscriptionsPage"));
    expect(cg).toContain("<colgroup>");
    expect(cg).toContain("SUBS_TABLE_COLS.map");
    // No minimum width on the table itself that would force it past the budget.
    expect(t).not.toMatch(/<table className="[^"]*min-w-/);
  });

  it("header: Started, Vendor, Seats and MRR have no column of their own — all sorts kept", () => {
    const h = headerRow();
    // One <th> per budget column.
    expect((h.match(/<th\b/g) ?? []).length + (h.match(/<SortHeader\b/g) ?? []).length + (h.match(/<SortHeader2\b/g) ?? []).length)
      .toBe(SUBS_TABLE_COLS.length);
    expect(h).not.toMatch(/<SortHeader label="Started"/);
    expect(h).not.toMatch(/<SortHeader label="Vendor"/);
    expect(h).not.toMatch(/<SortHeader\s+label="Seats"/);
    expect(h).not.toMatch(/<SortHeader label="MRR"/);
    // Every sort the old header offered is still one click away.
    for (const col of ["customer", "plan", "vendor", "seats", "mrr", "margin", "started", "renewal", "status"]) {
      expect(h).toMatch(new RegExp(`col(?:2)?="${col}"`));
    }
  });

  it("Renewal cell: renewal date first, Started as a small second line", () => {
    const t = desktopTable();
    const cell = t.slice(t.indexOf('data-col="renewal"'), t.indexOf('data-col="status"'));
    expect(cell.indexOf("s.renewal_date")).toBeGreaterThan(-1);
    expect(cell.indexOf("Started")).toBeGreaterThan(cell.indexOf("s.renewal_date"));
    expect(cell).toContain("s.start_date");
  });

  it("Vendor is a short badge with an accessible name; Seats + MRR share one cell", () => {
    const t = desktopTable();
    expect(t).toMatch(/role="img"\s+aria-label=\{`Vendor: \$\{vs\.name\}`\}/);
    const cell = t.slice(t.indexOf('data-col="seats_mrr"'), t.indexOf('data-col="margin"'));
    expect(cell).toContain("rupee(s.mrr)");
    expect(cell).toContain("s.vendor_seats");
    expect(cell).toContain("s.seats");
    expect(vendorShort("google")).toEqual({ short: "G", name: "Google", kind: "info" });
    expect(vendorShort("microsoft").name).toBe("Microsoft");
    expect(vendorShort(null).name).toBe("No vendor");
  });

  it("the row action is one ⋮ menu with a name, offering every action the row had", () => {
    const t = desktopTable();
    const cell = t.slice(t.indexOf('data-col="actions"'), t.indexOf("</tr>", t.indexOf('data-col="actions"')));
    // No loose buttons on the row any more.
    expect(cell).not.toMatch(/<Button\b/);
    expect(cell).toContain("<DropdownMenu modal={false}>");
    expect(cell).toMatch(/aria-label=\{`Actions for \$\{s\.plan\} — \$\{cleanDisplayName\(s\.customer_name\)\}`\}/);
    const menu = cell.slice(cell.indexOf("<DropdownMenuContent"), cell.indexOf("</DropdownMenuContent>"));
    // Renew — the row button before R-2263 — still only on expired / urgent rows.
    expect(menu).toMatch(/\(s\.status === "expired" \|\| isUrgent\) && \(/);
    expect(menu).toContain('router.push("/renewals" as never)');
    for (const label of ["Open details", "Renew", "Manage seats", "Correct details"]) {
      expect(menu).toContain(`>${label}<`);
    }
    expect(menu).toContain("setScheduleSub(s)");
    expect(menu).toContain("openAddSeats(s)");
    expect(menu).toContain("setEditSub(s)");
  });

  it("keeps R-1481's sticky header and the phone card list", () => {
    const t = desktopTable();
    expect(t).toMatch(/<thead className="sticky top-0 z-10 bg-paper-2/);
    expect(page).toContain('<Card flush className="hidden xl:block">');
  });
});
