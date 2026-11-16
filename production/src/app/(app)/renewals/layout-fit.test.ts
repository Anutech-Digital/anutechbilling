/**
 * R-1720 — on a ~1280px laptop the Renewals desktop table was wider than its card, so the Action
 * column sat behind a horizontal scroll. R-2403 — a fixed-layout table with a column budget
 * (queue.ts QUEUE_TABLE_COLS).
 *
 * R-2759 (R-2739b, changed expectation): user audit 14 Nov measured the table needing 1,634px in a
 * 1,599px box at 1920, and at 1280 the page showed the CARD list (a 1280 laptop's inner width is
 * 1264–1276, under the xl switch). Now: the table from a 1260px window, eight columns
 * (☐ · Customer · Product & period · Due · Amount · Status · Last bill · Action), every cell at
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
    /* R-2764 (changed expectation): ONE layout is mounted — matchMedia at QUEUE_TABLE_MIN_VIEWPORT_PX picks the
       table or the cards (both in the DOM with one CSS-hidden doubled every row's buttons — 14 Nov freeze). */
    expect(page).toContain("const TABLE_QUERY = `(min-width: ${QUEUE_TABLE_MIN_VIEWPORT_PX}px)`;");
    expect(page).toMatch(/\{table && \(\s*<div data-testid="renewals-table">/);
    expect(page).toMatch(/\{!table && \(\s*<ul className="[^"]*md:grid-cols-2[^"]*" data-testid="renewals-cards">/);
    expect(page).not.toMatch(/"hidden xl:block"|"xl:hidden/);
  });

  /* R-2854 (changed expectation — Chrome human test 16 Nov + Pardeep's quote line): the R-2821 "Customer and Product ≥ 200px
     each" gave way at 1260–1280 — Last bill needs 128px for a whole invoice number, Amount 100px for "₹63,855/mo" on one
     line — so Customer is 152px (names still wrap to two lines) and Product, the one flexible column, ≥ 188px. From wider
     windows every column grows (row-r2854.test.tsx). */
  it("column budget at 1260: the fixed columns + Product's minimum ≤ the ~968px card, Action inside it", () => {
    const fixed = QUEUE_TABLE_COLS.reduce((s, c) => s + (c.width ?? 0), 0);
    const flex = QUEUE_TABLE_COLS.filter((c) => c.width == null);
    expect(flex.map((c) => c.key)).toEqual(["product"]);
    /* R-2821: page side padding 32 → 16px below 2xl gives the card 32px more (936 → 968) */
    expect(QUEUE_TABLE_BUDGET_PX).toBeLessThanOrEqual(968);
    expect(QUEUE_FLEX_MIN_PX).toBeGreaterThanOrEqual(188);
    expect(QUEUE_TABLE_COLS.find((c) => c.key === "customer")!.width).toBeGreaterThanOrEqual(152);
    expect(fixed + flex.length * QUEUE_FLEX_MIN_PX).toBeLessThanOrEqual(QUEUE_TABLE_BUDGET_PX);
    expect(QUEUE_TABLE_COLS.map((c) => c.key)).toEqual(["select", "customer", "product", "due", "amount", "status", "invoice", "actions"]);
    /* R-2840 (changed expectation): "Last invoice" → "Last bill" (the invoice + its last payment) */
    expect(QUEUE_TABLE_COLS.map((c) => c.label)).toEqual(["", "Customer", "Product & period", "Due", "Amount", "Status", "Last bill", "Action"]);
  });

  it("the table is fixed-layout, driven by that budget; the header row comes from the same list; no min-width", () => {
    expect(page).toMatch(/<table className="w-full table-fixed text-sm">\s*<colgroup>\s*\{QUEUE_TABLE_COLS\.map/);
    /* R-2854: each <col> takes its width from queueColCss (grows with the window) */
    expect(page).toContain("<col key={c.key} style={{ width: queueColCss(c) }} />");
    expect(page).not.toMatch(/<table className="[^"]*min-w-/);
    const head = page.slice(page.indexOf("<thead>"), page.indexOf("</thead>"));
    expect(head).toMatch(/QUEUE_TABLE_COLS\.map\(\(c\) => c\.key === "select"/);
  });

  it("two lines per cell: names / ids / periods truncate with a tooltip; money and status never truncate", () => {
    /* R-2821: the customer name wraps to two lines; R-2880: the product line is ONE line (truncate) so a row is at most 3 text lines — R-2759 / R-2854 (the full text stays the tooltip) */
    expect(cells).toMatch(/className="line-clamp-2 break-words font-semibold text-ink hover:underline" title=\{nameTitle\}/);
    expect(cells).toContain('<span className="block truncate">{line1}</span>');
    expect(cells).toMatch(/className="block w-full min-w-0 truncate rounded-sm text-left underline-offset-2/);
    /* the invoice state (money + status) wraps, never cut */
    expect(cells).toMatch(/className=\{cn\("min-w-0 break-words tabular-nums", TONE\[state\.tone\]\)\} data-testid="renewal-last-invoice-status"/);
    /* the stage chip may wrap in the table (Badge is whitespace-nowrap by default); its period is in
       Product & period and its day count / amount is line 2 (compactStage) */
    expect(page).toContain('className={compact ? "max-w-full whitespace-normal text-left" : undefined}');
    expect(page).toContain("<StageChip stage={stage} size=\"sm\" compact canQuotes={canQuotes} />");
    expect(page).toContain("const c = compact ? compactStage(stage)");
    /* R-2854 (changed expectation): the amount is ONE line, never broken mid-word (AmountTableCell — "₹63,855/m" + "o" on staging) */
    expect(page).toContain("<AmountTableCell text={amount.text} gst={amount.gst} title={amount.quoteNote ?");
  });

  it("R-2840: Last bill line 3 = the last payment from the SAME Last paid read (no new query); it wraps, never cut", () => {
    const table = page.slice(page.indexOf('data-testid="renewals-table"'), page.indexOf("</table>"));
    expect(table).toContain("const paid = lastPaid.data?.get(sub.id);");
    /* R-2854 (changed expectation): the cell takes the Last paid read itself (paid={{…}}) and decides which lines show
       ("Paid" once); no quote note in the table cell any more (the quote is Product's quote line) */
    expect(table).toMatch(/<LastInvoiceCell [^>]*\s+paid=\{\{ paid, loading: lastPaid\.loading \|\| docsState\.loading/);
    const cell = cells.slice(cells.indexOf("export function LastInvoiceCell"), cells.indexOf("export function lastPaidRowFacts"));
    expect(cell).toContain("<LastPaidRowLine paid={paid.paid} docs={docs}");
    expect(cell).not.toMatch(/rowQuoteNote|renewal-row-quote-note/);
    expect(table).toContain("quoteLine={<RenewalQuoteLine docs={item.docs} stage={stage}");
    /* never "No payment yet" while either read is loading (R-2752: no false "never paid") */
    /* both reads: a USD payment needs its invoice (fx) — no ₹ → $ jump */
    expect(table).toContain("loading: lastPaid.loading || docsState.loading");
    expect(cells).toMatch(/className=\{cn\("min-w-0 break-words text-2xs leading-4 tabular-nums"/);
    expect((page.match(/useRenewalLastPaid\(/g) ?? []).length).toBe(1);
  });

  it("the table row carries no Last paid (card) / emails sent / follow-up / vendor-hold / prior-due lines (flags + drawer)", () => {
    const table = page.slice(page.indexOf('data-testid="renewals-table"'), page.indexOf("</table>"));
    for (const gone of ["lastPaidFor(", "reminder_count", "<FollowupLine", "<VendorHoldBadge", "priorTermDueText(", "docsFor(", "sentDue("]) {
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
