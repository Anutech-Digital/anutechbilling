/**
 * Claims the public site may not make without a source (2 Oct 2026, Pardeep):
 * sample "Google review" cards, an unmeasured "11 minute" WhatsApp reply time, and a hosting
 * "from" price that disagreed with the /hosting page.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTING_FROM_MO, HOSTING_TIERS } from "@/site/lib/data/hosting-landing-v2";

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");
const FILES = [
  "components/home/HomeV2.tsx", "lib/data/copy.ts", "components/chrome/Chrome.tsx",
  "components/chrome/Header.tsx", "components/trial/TrialForm.tsx", "components/agent/AgentChat.tsx",
  "components/home/HomeCompany.tsx", "lib/data/home-faqs.ts", "lib/data/company-faqs.ts",
];

describe("public site claims", () => {
  it("no sample reviews presented as Google reviews", () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(/· Google review"/);
  });
  it("no unmeasured 11-minute reply time", () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(/11[ -]min|11 minutes|eleven[ -]minute/i);
  });
  it("one hosting 'from' price everywhere — the /hosting Starter yearly rate", () => {
    // Whole rupees (R-1465): ₹50, not ₹49.99.
    expect(HOSTING_FROM_MO).toBe(`₹${Math.round(Math.min(...HOSTING_TIERS.map((t) => t.yearlyMo)))}`);
    for (const f of ["lib/data/copy.ts", "components/chrome/Header.tsx"]) {
      expect(read(f), f).toContain(`from ${HOSTING_FROM_MO}/mo`);
      expect(read(f), f).not.toContain("₹159/mo");
    }
    expect(read("components/home/HomeV2.tsx")).toContain("from: HOSTING_FROM_MO");
  });
});

/* R-157 (5 Oct 2026): Google Workspace flow audit. Claims the buy pages made that were not
   true — a promo that was never charged, a refund of a fee never taken, an annual plan that
   "cancels anytime" — must not come back. */
describe("Google Workspace buy pages — no invented offers or promises", () => {
  /* R-2020: the tiers moved to _parts/tiers.ts — both files are read. */
  const buy = readFileSync(join(__dirname, "../app/(public)/buy/workspace/buy-workspace-client.tsx"), "utf8")
    + readFileSync(join(__dirname, "../app/(public)/buy/workspace/_parts/tiers.ts"), "utf8");
  it("no hardcoded 20% first-20-users promo", () => {
    expect(buy).not.toMatch(/First 20 users/i);
    expect(buy).not.toMatch(/promoPrice:\s*864/);
  });
  it("no refund of a setup fee that is never charged", () => {
    expect(buy).not.toMatch(/refund the setup fee/i);
  });
  it("annual plans are not sold as cancel-anytime / pro-rata refundable", () => {
    expect(buy).not.toMatch(/pro-rata refunds/i);
    expect(buy).not.toMatch(/>\s*Cancel anytime\s*</);
  });
  it("no invented monthly price", () => {
    expect(buy).not.toMatch(/annual \* 1\.25/);
  });
  it("one support-hours answer", () => {
    expect(buy).not.toMatch(/9am–9pm/);
  });
});

/* R-157: one trial rule site-wide (Pardeep, 5 Oct 2026) — no card, nothing automatic. */
describe("trial — no card anywhere", () => {
  const trialForm = readFileSync(join(__dirname, "components/trial/TrialForm.tsx"), "utf8");
  const trialPage = readFileSync(join(__dirname, "../app/(marketing)/trial/page.tsx"), "utf8");
  it("no ₹1 card check and no auto-continue on the trial page", () => {
    for (const f of [trialPage, trialForm.replace(/\/\*\*[\s\S]*?\*\//, "")]) {
      expect(f).not.toMatch(/₹1 (card|authori|link|Razorpay)/i);
      expect(f).not.toMatch(/continues at the published rate (afterwards )?unless you cancel/i);
    }
  });
});
