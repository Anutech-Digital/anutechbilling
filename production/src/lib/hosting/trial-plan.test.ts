import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isTrialPlan, TRIAL_PLAN_ID } from "./trial-plan";

const root = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

describe("only Starter has a free trial (owner, 24 Sep 2026)", () => {
  it("Starter is eligible, the others are not", () => {
    expect(isTrialPlan("starter")).toBe(true);
    expect(isTrialPlan(" Starter ")).toBe(true);
    for (const p of ["standard", "plus", "", null, undefined, "hosting-starter"]) expect(isTrialPlan(p), String(p)).toBe(false);
    expect(TRIAL_PLAN_ID).toBe("starter");
  });

  it("the cart checkout refuses a trial line on any other plan", () => {
    expect(src("lib/checkout/cart-checkout.ts")).toMatch(/isTrialPlan\(tier\)/);
  });

  it("the confirm route never provisions a non-trial plan, even from an older lead", () => {
    expect(src("app/api/public/trial/hosting/confirm/route.ts")).toMatch(/isTrialPlan\(/);
  });

  it("the /hosting page offers the trial button only on the trial plan", () => {
    const page = src("site/components/hosting/HostingLanding.tsx");
    expect(page).toMatch(/isTrialPlan\(p\.name\)/);
    expect(page).not.toMatch(/trial on any plan/i);
  });
});

describe("Start free trial goes straight to the cart (owner, 24 Sep 2026)", () => {
  const page = () => src("site/components/hosting/HostingLanding.tsx");

  it("no trial button links to the old form any more", () => {
    expect(page()).not.toMatch(/href=\{?[`"]\/hosting\/trial/);
  });

  it("the trial is a ₹0 Starter trial line, on the cycle being viewed, then the cart page", () => {
    const p = page();
    expect(p).toMatch(/sku: `hosting-trial:\$\{TRIAL_PLAN_ID\}`/);
    expect(p).toMatch(/unitPrice: 0,/);
    expect(p).toMatch(/cycle: yearly \? "yearly" : "monthly"/);
    expect(p).toMatch(/router\.push\("\/cart"/);
    // Every trial button calls it: hero, the Starter card, the footer, the "Try Starter free" note.
    expect(p.match(/onClick=\{startTrialInCart\}/g)?.length).toBe(4);
  });

  it("the old form and its API route are gone; the page left only renders the confirmation", () => {
    expect(existsSync(join(root, "site/components/hosting/HostingTrialForm.tsx"))).toBe(false);
    expect(existsSync(join(root, "app/api/public/trial/hosting/route.ts"))).toBe(false);
    expect(src("app/(marketing)/hosting/trial/page.tsx")).toMatch(/redirect\("\/hosting#choose"\)/);
  });

  it("the trial's emailed links use the trusted origin (R-723), not a fallback host", () => {
    const s = src("lib/hosting/start-trial.ts");
    expect(s).not.toMatch(/resellersos\.web\.app/);
    expect(s).toContain("${trustedOrigin(request.headers)}/api/public/trial/hosting/confirm");
  });
});
