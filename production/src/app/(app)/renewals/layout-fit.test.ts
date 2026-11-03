/**
 * R-1720 — on a ~1280px laptop the Renewals desktop table (9 columns + a row of 4 action
 * buttons) was wider than its card, so the Action column sat behind a horizontal scroll
 * ("Send re…" cut off). The action buttons wrap instead of forcing the row wider.
 *
 * R-2403 (changed expectation): the queue table now shows from xl (1280px) — the card asked for
 * a table on desktop, phones keep cards. It fits because it is 7 columns on a fixed layout with a
 * column budget (queue.ts QUEUE_TABLE_COLS) inside the ~944px card a 1280 laptop gives it with
 * the sidebar open (measured for /subscriptions, R-2263), Actions always in it. jsdom has no
 * layout, so this proves the structure (same pattern as subscriptions/table-fit-r2263.test.ts).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QUEUE_TABLE_COLS, QUEUE_TABLE_BUDGET_PX, QUEUE_FLEX_MIN_PX } from "./queue";

const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");

describe("R-1720 / R-2403 — Renewals table fits its card at 1280", () => {
  it("the desktop table shows from xl (1280px); the card list covers everything below", () => {
    expect(page).toContain('<div className="hidden xl:block">');
    expect(page).not.toContain('<div className="hidden 2xl:block">');
    expect(page).toMatch(/<ul className="xl:hidden[^"]*md:grid-cols-2/);
  });

  it("column budget: fixed columns + flexible minimums ≤ 944px, Actions inside it", () => {
    const fixed = QUEUE_TABLE_COLS.reduce((s, c) => s + (c.width ?? 0), 0);
    const flex = QUEUE_TABLE_COLS.filter((c) => c.width == null);
    expect(flex.map((c) => c.key)).toEqual(["customer", "product"]);
    expect(QUEUE_TABLE_BUDGET_PX).toBeLessThanOrEqual(944);
    expect(fixed + flex.length * QUEUE_FLEX_MIN_PX).toBeLessThanOrEqual(QUEUE_TABLE_BUDGET_PX);
    expect(QUEUE_TABLE_COLS.map((c) => c.key)).toEqual(["select", "customer", "product", "date", "amount", "status", "actions"]);
  });

  it("the table is fixed-layout, driven by that budget, with one <th> per column and no min-width", () => {
    expect(page).toMatch(/<table className="w-full table-fixed text-sm">\s*<colgroup>\s*\{QUEUE_TABLE_COLS\.map/);
    expect(page).not.toMatch(/<table className="[^"]*min-w-/);
    const head = page.slice(page.indexOf("<thead>"), page.indexOf("</thead>"));
    expect((head.match(/<th\b/g) ?? []).length).toBe(QUEUE_TABLE_COLS.length);
    for (const h of [">Customer<", ">Product<", ">Renewal date<", ">Renewal amount<", ">Status<", ">Actions<"]) expect(head).toContain(h);
    expect(head).not.toContain(">Monthly<");
  });

  it("action buttons wrap rather than widen the row (table and card)", () => {
    /* R-2401: the buttons are the shared RenewalActions (page + component are checked). */
    const shared = readFileSync("src/components/features/renewals/renewal-actions.tsx", "utf8");
    const actionRows = (page + shared).match(/className=(?:"|\{cn\(")flex (?:flex-wrap )?items-center gap-1\.5[^"]*"/g) ?? [];
    expect(actionRows.length).toBeGreaterThanOrEqual(1);
    for (const r of actionRows) expect(r).toContain("flex-wrap");
    expect(page).toMatch(/className="pt-2 border-t[^"]*">\s*<RenewalActions/);
  });

  it("R-2422: Actions is one next-step button + ⋯ (no stacked extras), so the column is narrower", () => {
    const actions = QUEUE_TABLE_COLS.find((c) => c.key === "actions")!;
    expect(actions.width).toBeLessThanOrEqual(224);
    expect(page).not.toContain("extra={");
    expect(page).not.toMatch(/<AiDraftButton|<VoiceNoteButton/);
    const uses = page.match(/<RenewalActions [^>]*\/>/g) ?? [];
    expect(uses).toHaveLength(2);
    for (const u of uses) expect(u).toMatch(/onFollowup=\{followupFor\(sub\)\} messaging/);
    const shared = readFileSync("src/components/features/renewals/renewal-actions.tsx", "utf8");
    expect(shared).toContain("const menuLabel = `More renewal actions for ${name}");
    expect(shared).toContain("aria-label={menuLabel}");
  });

  it("R-2422: every row (table and card) shows its payment frequency and Last paid", () => {
    expect((page.match(/<AmountCell amount=\{amount\} frequency=\{frequency\}/g) ?? []).length).toBe(2);
    /* Last paid sits under the customer (contact line) on both layouts. */
    expect((page.match(/<ContactLine contact=\{contact\} \/>\s*\{lastPaidFor\(sub, "mt-0\.5"\)\}/g) ?? []).length).toBe(2);
    /* One batched read for the whole listed queue (tab / tile switches do not read again), never one per row. */
    expect((page.match(/useRenewalLastPaid\(/g) ?? []).length).toBe(1);
    expect(page).toContain("useRenewalLastPaid(listed)");
  });
});
