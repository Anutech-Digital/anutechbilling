// R-1117: the trial length lives in src/lib/trials/trial-days.ts and nowhere else. These are
// the pages, routes and emails that promise or set up a trial; none of them may type "14-day"
// or "15 days" by hand again (comments are skipped — they explain, they do not promise).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_TRIAL_DAYS, HOSTING_TRIAL_DAYS } from "./trial-days";
import { QUOTE_TRIAL_DAYS } from "./start-from-quote";
import { TRIAL_DAYS as HOSTING_START_TRIAL_DAYS } from "@/lib/hosting/start-trial";
import { TRIAL_DAYS as HOSTING_LANDING_TRIAL_DAYS } from "@/site/lib/data/hosting-landing-v2";

const FILES = [
  // Workspace
  "src/app/(public)/buy/workspace/buy-workspace-client.tsx",
  "src/app/api/public/trial/workspace/route.ts",
  "src/app/api/leads/start-trial/route.ts",
  "src/app/api/cron/trial-expiry/route.ts",
  "src/app/api/public/enquiry/workspace/route.ts",
  "src/components/features/leads/start-trial-dialog.tsx",
  "src/site/components/lp/lp-copy.ts",
  "src/site/components/lp/WorkspaceAdLanding.tsx",
  "src/site/components/email/WorkspacePricing.tsx",
  "src/lib/marketing/landing-pages.ts",
  "src/lib/trials/start-from-quote.ts",
  // Hosting
  "src/lib/hosting/start-trial.ts",
  "src/app/api/public/trial/hosting/confirm/route.ts",
  "src/site/lib/data/hosting-landing-v2.ts",
  "src/site/lib/data/hosting-landing.ts",
  "src/site/lib/data/misc.ts",
  "src/site/components/hosting/HostingLanding.tsx",
  "src/site/components/cart/CartDrawer.tsx",
  "src/app/(marketing)/cart/page.tsx",
  "src/app/(marketing)/checkout/page.tsx",
  "src/app/(marketing)/done/page.tsx",
  "src/app/(marketing)/hosting/page.tsx",
];

/** Drop block / JSX / line comments; `://` inside a URL is not a comment. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const HARD_CODED = /\b1[45](?:-|\s)?days?\b|=\s*1[45]\s*;/gi;

describe("R-1117: one trial length per product", () => {
  it("Workspace is 14 days and hosting is 15 (unchanged — R-1117 only moved them)", () => {
    expect(WORKSPACE_TRIAL_DAYS).toBe(14);
    expect(HOSTING_TRIAL_DAYS).toBe(15);
  });

  it("the older names are the same constant, not a second copy", () => {
    expect(QUOTE_TRIAL_DAYS).toBe(WORKSPACE_TRIAL_DAYS);
    expect(HOSTING_START_TRIAL_DAYS).toBe(HOSTING_TRIAL_DAYS);
    expect(HOSTING_LANDING_TRIAL_DAYS).toBe(HOSTING_TRIAL_DAYS);
  });

  for (const f of FILES) {
    it(`${f} reads the length from trial-days.ts`, () => {
      const hits = code(readFileSync(join(process.cwd(), f), "utf8")).match(HARD_CODED) ?? [];
      expect(hits).toEqual([]);
    });
  }
});
