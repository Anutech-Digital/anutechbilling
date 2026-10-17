import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Lead } from "@/lib/supabase/database.types";
import { everythingCountForPage, LEADS_PAGE_STAGES, navBadgeCount, pageStages } from "./page-scope";
import { DEALS_PAGE_STAGES } from "./deal-rules";

/* R-1475 (Pawan, staging 16 Oct): "sidebar shows Deals 4 but the page says 'All deals 7';
   Sales & Pipeline shows 3 but the page says 'All leads 4'". The sidebar badge counted
   New + Contacted (Sales) and Quote / Demo / Trial (Deals), junk included; the pages open on
   "All leads" (New, Contacted, Lost — no junk) and "All deals" (Quote … Won, Lost — no junk).
   A badge must equal the count the page it opens shows first (R-118: tile == list). */

type Row = { stage: Lead["stage"]; is_junk: boolean };

/* lead_counts().folders over the same rows — the rule each page's "All" sums (page-scope.ts). */
function folders(rows: readonly Row[], isDealsPage: boolean) {
  const shown = rows.filter((r) => !r.is_junk && pageStages(isDealsPage).includes(r.stage));
  const n = (s: Lead["stage"][]) => shown.filter((r) => s.includes(r.stage)).length;
  return {
    inbox: n(["new"]), talks: n(["contact"]), quoted: n(["quote"]), proving: n(["demo", "trial"]),
    won: n(["won"]), lost: n(["lost"]), hot: 0, followup: 0,
  };
}

/* Pawan's staging picture: 3 open leads + 1 lost, 4 open deals + 2 won, plus junk. */
const ROWS: Row[] = [
  { stage: "new", is_junk: false }, { stage: "new", is_junk: false }, { stage: "contact", is_junk: false },
  { stage: "lost", is_junk: false },
  { stage: "quote", is_junk: false }, { stage: "demo", is_junk: false }, { stage: "trial", is_junk: false },
  { stage: "quote", is_junk: false },
  { stage: "won", is_junk: false }, { stage: "won", is_junk: false },
  { stage: "new", is_junk: true }, { stage: "won", is_junk: true },
];

describe("R-1475: sidebar badge == the page's 'All' count", () => {
  for (const isDealsPage of [false, true]) {
    const page = isDealsPage ? "/deals (All deals)" : "/leads (All leads)";
    it(`${page}: badge equals the first view the page opens on`, () => {
      const all = everythingCountForPage(
        { folders: folders(ROWS, isDealsPage) } as Parameters<typeof everythingCountForPage>[0],
        isDealsPage,
      );
      expect(navBadgeCount(ROWS, isDealsPage)).toBe(all);
    });
  }

  it("Pawan's numbers: Sales 4 (3 open + 1 lost), Deals 7 (4 open + 2 won + 1 lost)", () => {
    expect(navBadgeCount(ROWS, false)).toBe(4);
    expect(navBadgeCount(ROWS, true)).toBe(7);
  });
});

/* The sidebar reads nav_badges(); the SQL must use the same stage split and junk rule. */
function latestNavBadgesSql(): string {
  const dir = join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const hits = files.filter((f) => /function\s+public\.nav_badges\s*\(/i.test(readFileSync(join(dir, f), "utf8")));
  return readFileSync(join(dir, hits[hits.length - 1]), "utf8");
}

function stagesOf(sql: string, key: string): { stages: string[]; junk: boolean } {
  const m = sql.match(new RegExp(`'${key}',\\s*\\(select count\\(\\*\\) from public\\.leads l where ([^\\n]*)\\)`));
  if (!m) throw new Error(`nav_badges() has no leads count for '${key}'`);
  const inList = m[1].match(/l\.stage in \(([^)]*)\)/);
  return {
    stages: inList ? [...inList[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort() : [],
    junk: /not l\.is_junk/.test(m[1]),
  };
}

describe("R-1475: nav_badges() SQL uses each page's stages, without junk", () => {
  const sql = latestNavBadgesSql();
  it("leads = LEADS_PAGE_STAGES, junk left out", () => {
    expect(stagesOf(sql, "leads")).toEqual({ stages: [...LEADS_PAGE_STAGES].sort(), junk: true });
  });
  it("deals = DEALS_PAGE_STAGES, junk left out", () => {
    expect(stagesOf(sql, "deals")).toEqual({ stages: [...DEALS_PAGE_STAGES].sort(), junk: true });
  });
});
