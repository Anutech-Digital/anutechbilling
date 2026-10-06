import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COPY } from "@/lib/copy";
import { DEAL_STAGES, LEAD_STAGES, LEAD_STAGE_IDS } from "./stage-meta";

/* R-249 (6 Oct 2026): the Kanban ran quote → demo → trial, while the dashboard, the insight
   band and the add-lead form each kept their own list in demo → trial → quote order; and the
   "new quote" action had four names. One funnel order, one table, one label. */
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

const SCREENS = [
  "src/app/(app)/dashboard/page.tsx",
  "src/components/features/leads/leads-insight-band.tsx",
  "src/components/features/leads/add-lead-form.tsx",
];

describe("R-249 deal stages read in one order everywhere", () => {
  it("the stage table is in funnel order: quote, then demo, then trial", () => {
    expect(LEAD_STAGE_IDS).toEqual(["new", "contact", "quote", "demo", "trial", "won"]);
    expect(DEAL_STAGES.map((s) => s.id)).toEqual(LEAD_STAGES.map((s) => s.id));
  });

  for (const f of SCREENS) {
    it(`${f} imports the stage table instead of keeping its own list`, () => {
      const src = read(f);
      expect(src).toMatch(/from "@\/lib\/leads\/stage-meta"/);
      expect(src).not.toMatch(/"Demo Done"|"Trial Active"|"Quote Sent"/);
      expect(src).not.toMatch(/"demo",\s*"trial",\s*"quote"/);
    });
  }

  it("the new-quote action has one name", () => {
    expect(COPY.newQuote).toBe("New quote");
    for (const f of [
      "src/app/(app)/dashboard/page.tsx",
      "src/app/(app)/quotes/page.tsx",
      "src/components/layout/command-palette.tsx",
    ]) {
      const src = read(f);
      expect(src).not.toMatch(/Quick add quote|>\s*New Quote\s*<|"Create new quote"/);
      expect(src).toMatch(/COPY\.newQuote/);
    }
  });
});
