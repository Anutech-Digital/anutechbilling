import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/* WC-scale (30 Sep 2026): PostgREST cuts every response at 1000 rows without saying so, so a
   screen that reads a whole table and counts it in the browser is silently wrong past the
   thousandth row. useLeads() is that read for leads (select("*"), every lead). It is
   removed (R-1536 moved its last caller, quote-builder.tsx, to a by-id read).
   This pins that it does not come back, and that the leads list's per-row look-ups stay
   scoped to the rows on screen. */

const SRC = join(process.cwd(), "src");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

describe("unbounded lead reads", () => {
  /* R-1536: its last caller, the quote builder, now reads one lead by id (useQuoteLead), and
     useLeads() itself is gone. Nothing may bring it, or a call to it, back. */
  it("useLeads() is neither defined nor called anywhere", () => {
    const callers = walk(SRC)
      .filter((f) => /\buseLeads\(\)/.test(readFileSync(f, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")))
      .map((f) => relative(SRC, f).replace(/\\/g, "/"));
    expect(callers).toEqual([]);
  });

  it("the leads list scopes its quote / task / first-reply look-ups to the rows on screen", () => {
    const src = readFileSync(join(SRC, "components/features/leads/lead-list-view.tsx"), "utf8");
    expect(src).toMatch(/useLeadQuotes\(leadIds\)/);
    expect(src).toMatch(/useOpenTasksForLeads\(leadIds\)/);
    expect(src).toMatch(/useLeadFirstReplies\(leadIds\)/);
    expect(src).not.toMatch(/useTasks\("all"\)/);
  });
});
