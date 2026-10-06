/**
 * A trial sends the OWNER no email (owner, 30 Sep 2026: "Remove this feature completely.
 * That will just annoy the owner."). Every trial — including every test run — used to email
 * pardeep@anutech.in up to three times. Staff see trials as leads with follow-up tasks; a
 * setup that fails becomes a task, not an email. This fails if an owner email comes back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FILES = [
  "src/lib/hosting/start-trial.ts",
  "src/app/api/public/trial/hosting/confirm/route.ts",
  "src/app/api/public/trial/workspace/route.ts",
];
/* The confirm route sends no email at all since 3 Oct 2026 — DMS sends the customer's
   "trial is live" email when it creates the account — so it has no sendEmail to anchor on. */
const SENDS_CUSTOMER_EMAIL = new Set(["src/lib/hosting/start-trial.ts", "src/app/api/public/trial/workspace/route.ts"]);
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("trials never email the owner", () => {
  for (const f of FILES) {
    it(f, () => {
      const c = code(f);
      if (SENDS_CUSTOMER_EMAIL.has(f)) expect(c).toContain("sendEmail("); // guard: the customer's email is still there to scan
      else expect(c).not.toContain("sendEmail(");
      expect(c).not.toMatch(/buy_page_trial_owner/);
      expect(c).not.toMatch(/to:\s*owner\.to/);
    });
  }
});

/* The site's trial FORM goes through the enquiry routes, not the trial routes, so it got
   the "new enquiry" owner alert until 30 Sep 2026. It now sends `trial: true`, and the
   enquiry routes skip only the owner alert for it — real enquiries still alert the owner. */
describe("a trial request through the enquiry routes does not email the owner", () => {
  it("the trial form marks itself a trial", () => {
    expect(code("src/site/components/trial/TrialForm.tsx")).toMatch(/fetch\("\/api\/enquiry"[\s\S]{0,400}trial: true/);
  });
  it("general route: the owner alert is skipped for a trial, the customer's copy is not", () => {
    const c = code("src/app/api/public/enquiry/general/route.ts");
    expect(c).toMatch(/trial:\s*z\.boolean\(\)\.optional\(\)/);
    expect(c).toMatch(/ownerEmail && !trial\s*\?\s*sendEmail\(\{[\s\S]{0,400}to:\s*ownerEmail/);
    expect(c).toMatch(/sendEmail\(\{[\s\S]{0,300}to:\s*email,/);
  });
  it("workspace route: the same", () => {
    const c = code("src/app/api/public/enquiry/workspace/route.ts");
    expect(c).toMatch(/trial:\s*z\.boolean\(\)\.optional\(\)/);
    expect(c).toMatch(/owner\.ok && !trial && sendEmail\(\{\s*to:\s*owner\.to/);
    // The customer still gets the acknowledgement — addressed by its reply-to (support for the storefront).
    expect(c).toMatch(/customerReplyTo && sendEmail\(\{\s*to:\s*email,/);
  });
});
