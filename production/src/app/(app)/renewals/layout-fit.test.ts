/**
 * R-1720 — on a ~1280px laptop the Renewals desktop table was wider than its card, so the Action
 * column sat behind a horizontal scroll. R-2403 — a fixed-layout table with a column budget
 * (queue.ts QUEUE_TABLE_COLS).
 *
 * R-2759 (R-2739b, changed expectation): user audit 14 Nov measured the table needing 1,634px in a
 * 1,599px box at 1920, and at 1280 the page showed the CARD list (a 1280 laptop's inner width is
 * 1264–1276, under the xl switch). Now: the table from a 1260px window, eight columns
 * (☐ · Customer · Product & period · Due · Amount · Status · Last invoice · Action), every cell at
 * most two lines (row-cells.tsx). jsdom has no layout, so this proves the structure; the real width
 * check is the card spec e2e/cards/R-2759.spec.ts (1280 and 1568, scrollWidth ≤ innerWidth).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QUEUE_TABLE_COLS, QUEUE_TABLE_BUDGET_PX, QUEUE_FLEX_MIN_PX, QUEUE_TABLE_MIN_VIEWPORT_PX } from "./queue";

const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
const cells = readFileSync("src/app/(app)/renewals/row-cells.tsx", "utf8");

describe("R-1720 / R-2403 / R-2759 — Renewals table fits its card from 1260", () => {
  it("the desktop table shows from a 1260px window; the card list covers everything below", () => {
    expect(QUEUE_TABLE_MIN_VIEWPORT_PX).toBe(1260);
    expect(page).toContain('<div className="hidden min-[1260px]:block" data-testid="renewals-table">');
    expect(page).toMatch(/<ul className="min-\[1260px\]:hidden[^"]*md:grid-cols-2/);
    expect(page).not.toMatch(/"hidden xl:block"|"xl:hidden/);
  });

  it("column budget: fixed columns + flexible minimums ≤ the ~936px card (974 measured at 1280, minus a Windows scrollbar and 20px), Action inside it", () => {
    const fixed = QUEUE_TABLE_COLS.reduce((s, c) => s + (c.width ?? 0), 0);
    const flex = QUEUE_TABLE_COLS.filter((c) => c.width == null);
    expect(flex.map((c) => c.key)).toEqual(["customer", "product"]);
    expect(QUEUE_TABLE_BUDGET_PX).toBeLessThanOrEqual(936);
    expect(fixed + flex.length * QUEUE_FLEX_MIN_PX).toBeLessThanOrEqual(QUEUE_TABLE_BUDGET_PX);
    expect(QUEUE_TABLE_COLS.map((c) => c.key)).toEqual(["select", "customer", "product", "due", "amount", "status", "invoice", "actions"]);
    expect(QUEUE_TABLE_COLS.map((c) => c.label)).toEqual(["", "Customer", "Product & period", "Due", "Amount", "Status", "Last invoice", "Action"]);
  });

  it("the table is fixed-layout, driven by that budget; the header row comes from the same list; no min-width", () => {
    expect(page).toMatch(/<table className="w-full table-fixed text-sm">\s*<colgroup>\s*\{QUEUE_TABLE_COLS\.map/);
    expect(page).not.toMatch(/<table className="[^"]*min-w-/);
    const head = page.slice(page.indexOf("<thead>"), page.indexOf("</thead>"));
    expect(head).toMatch(/QUEUE_TABLE_COLS\.map\(\(c\) => c\.key === "select"/);
  });

  it("two lines per cell: names / ids / periods truncate with a tooltip; money and status never truncate", () => {
    expect(cells).toMatch(/className="block truncate font-semibold text-ink hover:underline" title=\{nameTitle\}/);
    expect(cells).toMatch(/truncate text-ink" title=\{line1\}/);
    /* the invoice state (money + status) wraps, never cut */
    expect(cells).toMatch(/className=\{cn\("break-words tabular-nums", TONE\[state\.tone\]\)\} data-testid="renewal-last-invoice-status"/);
    /* the stage chip may wrap in the table (Badge is whitespace-nowrap by default); its period is in
       Product & period and its day count / amount is line 2 (compactStage) */
    expect(page).toContain('className={compact ? "max-w-full whitespace-normal text-left" : undefined}');
    expect(page).toContain("<StageChip stage={stage} compact />");
    expect(page).toContain("const c = compact ? compactStage(stage)");
    /* the amount is never cut (it may wrap) */
    expect(page).toContain('<p className="break-words font-medium tabular-nums text-ink">{amount.text}</p>');
  });

  it("the table row carries no Last paid / emails sent / follow-up / vendor-hold / prior-due lines (flags + drawer)", () => {
    const table = page.slice(page.indexOf('data-testid="renewals-table"'), page.indexOf("</table>"));
    for (const gone of ["lastPaidFor(", "reminder_count", "<FollowupLine", "<VendorHoldBadge", "priorDue", "docsFor(", "sentDue("]) {
      expect(table).not.toContain(gone);
    }
    expect(table).toContain("<LastInvoiceCell ");
  });

  it("R-2422: Action is ONE button + ⋯ on one line", () => {
    const actions = QUEUE_TABLE_COLS.find((c) => c.key === "actions")!;
    expect(actions.width).toBeLessThanOrEqual(184);
    expect(page).not.toContain("extra={");
    expect(page).not.toMatch(/<AiDraftButton|<VoiceNoteButton/);
    const uses = page.match(/<RenewalActions [^>]*\/>/g) ?? [];
    expect(uses).toHaveLength(2);
    for (const u of uses) expect(u).toMatch(/onFollowup=\{followupFor\(sub\)\} messaging/);
  });

  it("the card layout keeps payment frequency + Last paid; one batched Last paid read", () => {
    expect((page.match(/<AmountCell amount=\{amount\} frequency=\{frequency\}/g) ?? []).length).toBe(1);
    expect(page).toContain("term={nextTermWords(sub)} termShort={nextTermShort(sub)} frequency={frequency}");
    expect((page.match(/useRenewalLastPaid\(/g) ?? []).length).toBe(1);
    expect(page).toContain("useRenewalLastPaid(listed)");
  });
});
