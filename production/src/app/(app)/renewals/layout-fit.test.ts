/**
 * R-1720 — on a ~1280px laptop the Renewals desktop table (9 columns + a row of 4 action
 * buttons) was wider than its card, so the Action column sat behind a horizontal scroll
 * ("Send re…" cut off). The full table now starts at 2xl (1536px), where it fits; below
 * that the card list (every action visible) is used — two cards per row from xl.
 * The action buttons wrap instead of forcing the row wider.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");

describe("R-1720 — Renewals table fits its card", () => {
  it("the desktop table only shows at 2xl; the card list covers everything below", () => {
    expect(page).toContain('<div className="hidden 2xl:block">');
    expect(page).not.toContain('<div className="hidden xl:block">');
    expect(page).toMatch(/<ul className="2xl:hidden[^"]*xl:grid-cols-2/);
  });
  it("action buttons wrap rather than widen the row (table and card)", () => {
    /* R-2401: the buttons are the shared RenewalActions (page + component are checked). */
    const shared = readFileSync("src/components/features/renewals/renewal-actions.tsx", "utf8");
    const actionRows = (page + shared).match(/className=(?:"|\{cn\(")flex (?:flex-wrap )?items-center gap-1\.5[^"]*"/g) ?? [];
    expect(actionRows.length).toBeGreaterThanOrEqual(1);
    for (const r of actionRows) expect(r).toContain("flex-wrap");
    expect(page).toMatch(/className="pt-2 border-t[^"]*">\s*<RenewalActions/);
  });
});
