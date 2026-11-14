/**
 * R-2755 (Pardeep 14 Nov: "renewals list me subscription ke saath domain name bhi show ho, jaruri hai"):
 *  1. every Renewals row — table, card and the row drawer's header — shows the subscription's own
 *     domain (subscriptions.domain, already in the page's `select("*")` read — no new fetch); no
 *     domain → nothing (no "—");
 *  2. a search / filter that empties the open tab says where the matches are: "1 match in 8–30 — show"
 *     (a button that opens that tab).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { subscriptionDomain } from "./row-cells";
import { matchesElsewhere, QUEUE_TAB_LABEL } from "./queue";

const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
const cells = readFileSync("src/app/(app)/renewals/row-cells.tsx", "utf8");
const drawer = readFileSync("src/app/(app)/renewals/renewal-drawer.tsx", "utf8");

describe("R-2755 the row's domain", () => {
  it("the stored domain, trimmed; empty / missing → null (nothing shown)", () => {
    expect(subscriptionDomain({ domain: "  scnkochi.in " })).toBe("scnkochi.in");
    expect(subscriptionDomain({ domain: "" })).toBeNull();
    expect(subscriptionDomain({ domain: "   " })).toBeNull();
    expect(subscriptionDomain({ domain: null })).toBeNull();
    expect(subscriptionDomain({})).toBeNull();
  });

  it("the table's Product cell, the card and the drawer header all read the same helper", () => {
    expect(page).toMatch(/<ProductCell [^>]*domain=\{subscriptionDomain\(sub\)\}/);
    expect(page).toMatch(/data-testid="renewal-card-domain"/);
    expect(drawer).toContain("subscriptionDomain(sub)");
    expect(drawer).not.toMatch(/sub\.vendor\.slice\(1\) : null, sub\.domain\]/);
  });

  it("the domain truncates with its full text on hover; the period gives way, never the money / status", () => {
    expect(cells).toMatch(/data-testid="renewal-row-domain"[^>]*title=\{domain\}|title=\{domain\}[^>]*data-testid="renewal-row-domain"/);
    /* one line: the period wraps out of sight (it is in the tooltip; the Due column shows its start) */
    expect(cells).toMatch(/className="mt-0\.5 flex max-h-\[1lh\] flex-wrap gap-x-1 overflow-hidden text-2xs"/);
  });
});

describe("R-2755 matches on other tabs", () => {
  const counts = { overdue: 0, due7: 0, d30: 1, d60: 0, d90: 0, later: 3 };

  it("lists the other tabs with matches, in tab order, with the tab's own label", () => {
    expect(matchesElsewhere("overdue", counts)).toEqual([
      { tab: "d30", label: QUEUE_TAB_LABEL.d30, count: 1, words: "1 match in 8–30" },
      { tab: "later", label: QUEUE_TAB_LABEL.later, count: 3, words: "3 matches in Later (91+ days)" },
    ]);
  });

  it("never the open tab itself; nothing anywhere → empty", () => {
    expect(matchesElsewhere("d30", counts).map((m) => m.tab)).toEqual(["later"]);
    expect(matchesElsewhere("overdue", { overdue: 0, due7: 0, d30: 0, d60: 0, d90: 0, later: 0 })).toEqual([]);
  });

  it("the empty tab shows each as a button that opens that tab (only when a search / filter is on)", () => {
    expect(page).toContain('data-testid="renewals-matches-elsewhere"');
    expect(page).toMatch(/elsewhere=\{tile \|\| !\(filtered \|\| search\.trim\(\)\) \? \[\] : matchesElsewhere\(bucketTab, /);
    expect(page).toMatch(/onClick=\{\(\) => onOpenTab\(m\.tab\)\}/);
  });
});
