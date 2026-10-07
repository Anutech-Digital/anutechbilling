/**
 * R-342 — the lead drawer lives in the URL (?lead=<id>, its tab in ?ltab=), so Back reopens it.
 *
 * ─── THE BUG ────────────────────────────────────────────────────────────────
 * Browser check 7 Oct (R-341): /leads?lead=L-… → Activity → click a quote → Back = /leads with
 * the drawer CLOSED. Two causes, both needed for the fix:
 *   1. The deep-link handler stripped ?lead= the moment the drawer opened, and a row click
 *      never wrote it — so the /leads history entry never said which lead was open.
 *   2. Every "leave the drawer for another page" button called onClose() before
 *      router.push(). onClose is the real close and clears ?lead, so even with (1) fixed the
 *      entry Back returns to had already lost the lead.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 * - Opening a lead writes ?lead (useUrlState, R-272 — replaceState, no history entry per open).
 * - Closing clears ?lead and ?ltab; nothing strips ?lead while the drawer is open.
 * - The drawer's tab is useUrlChoice("ltab"), so Back lands on the same tab.
 * - Leaving for another page pushes WITHOUT onClose(); the page unmounts on its own.
 *
 * jsdom cannot drive the App Router's history, so — like board-reachable.test.ts — this
 * checks the source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURES = join(HERE, "..", "..", "..", "components", "features", "leads");
const page = readFileSync(join(HERE, "page.tsx"), "utf8");
const sheet = readFileSync(join(FEATURES, "lead-detail-sheet.tsx"), "utf8");
const footer = readFileSync(join(FEATURES, "lead-detail-footer.tsx"), "utf8");
const details = readFileSync(join(FEATURES, "lead-detail-details-tab.tsx"), "utf8");

/** Code only — comments may quote the old pattern while explaining it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("R-342: the lead drawer is in the URL", () => {
  it("the page holds ?lead and ?ltab with useUrlState", () => {
    expect(code(page)).toMatch(/useUrlState\(\s*"lead"\s*\)/);
    expect(code(page)).toMatch(/useUrlState\(\s*"ltab"\s*\)/);
  });

  it("opening a lead writes ?lead", () => {
    const open = code(page).match(/const openLead = React\.useCallback\(([\s\S]*?)\}, \[/);
    expect(open?.[1]).toMatch(/setLeadInUrl\(\s*l\.id\s*\)/);
  });

  it("the deep-link handler no longer strips ?lead once the drawer is open", () => {
    const handler = code(page).match(/setSelected\(match\);([\s\S]*?)\}, \[deepLinkToPage/);
    expect(handler, "deep-link handler not found").toBeTruthy();
    expect(handler![1]).not.toMatch(/router\.replace\(/);
  });

  it("closing the drawer clears ?lead and ?ltab", () => {
    const close = code(page).match(/const closeLead = React\.useCallback\(([\s\S]*?)\}, \[/);
    expect(close?.[1]).toMatch(/setLeadInUrl\(\s*""\s*\)/);
    expect(close?.[1]).toMatch(/setLeadTabInUrl\(\s*""\s*\)/);
    expect(code(page)).toMatch(/onClose=\{closeLead\}/);
  });

  it("the drawer's tab comes from ?ltab", () => {
    expect(code(sheet)).toMatch(/useUrlChoice[\s\S]{0,80}\(\s*"ltab"/);
  });

  it("leaving for another page never closes the drawer first (that would clear ?lead)", () => {
    for (const [name, src] of [["sheet", sheet], ["footer", footer], ["details tab", details]] as const) {
      const leaves = code(src).match(/onClose\(\);\s*router\.push\(`\/(quotes|projects|subscriptions)|onClose\(\);\s*router\.push\(\s*(t\.href|"\/subscriptions"|subscriptionFromLeadHref)/g);
      expect(leaves, `${name} closes before navigating`).toBeNull();
    }
  });
});
