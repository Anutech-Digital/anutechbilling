/**
 * The documents a buyer agrees to are reachable (30 Sep 2026). The checkout sentence named
 * "the terms of service and the refund policy" with no link to either, and the footer's
 * "Terms" opened /terms — the ResellerOS SOFTWARE terms, not the terms for what a customer
 * buys. Anutech's own terms now live at /terms-and-conditions.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { LEGAL } from "@/site/lib/data/misc";

const read = (f: string) => readFileSync(f, "utf8");

describe("buyer-facing legal documents", () => {
  it("each has a real page", () => {
    expect(read("src/app/(marketing)/terms-and-conditions/page.tsx")).toMatch(/<LegalDoc page="terms" \/>/);
    expect(read("src/app/(marketing)/refund/page.tsx")).toMatch(/<LegalDoc page="refund" \/>/);
    expect(read("src/app/(marketing)/privacy-policy/page.tsx")).toMatch(/<LegalDoc page="privacy" \/>/);
    expect(existsSync("src/app/(public)/privacy/page.tsx")).toBe(true); // the software's own privacy policy stays
    expect(existsSync("src/app/(public)/terms/page.tsx")).toBe(true); // the software's own terms stay
  });

  it("the checkout agreement links to both documents", () => {
    const c = read("src/app/(marketing)/checkout/page.tsx");
    expect(c).toMatch(/href="\/terms-and-conditions"[^>]*>terms and conditions</);
    expect(c).toMatch(/href="\/refund"[^>]*>refund policy</);
  });

  it("the site footer's Terms is the buyer's terms, not the software's", () => {
    const c = read("src/site/components/chrome/Chrome.tsx");
    expect(c).toMatch(/\["Terms", "\/terms-and-conditions"\]/);
    expect(c).not.toMatch(/\["Terms", "\/terms"\]/);
    expect(c).toMatch(/\["Privacy", "\/privacy-policy"\]/);
  });

  it("the documents do not promise what checkout cannot do", () => {
    const text = JSON.stringify(LEGAL);
    expect(text).not.toMatch(/NEFT|RTGS/);           // checkout takes Razorpay only
    expect(text).not.toMatch(/eleven minutes/);      // an average nobody measures
    expect(text).not.toMatch(/Message us on WhatsApp/); // the site's WhatsApp number is a placeholder
    expect(text).not.toMatch(/address on the About page/); // the About page names no grievance officer
  });

  it("the grievance officer is the company, not a named person (5 Oct 2026)", () => {
    const grievance = LEGAL.privacy.blocks.find((b) => b.h === "Grievances")?.p ?? "";
    expect(grievance).toMatch(/Grievance Officer is Anutech Digital Pvt Ltd/);
    const app = read("src/app/(public)/privacy/page.tsx");
    expect(app).toMatch(/Grievance Officer \/ Data Protection Officer:<\/strong><br \/>\s*\{PLATFORM_OPERATOR\.legalName\}/);
    expect(app).not.toMatch(/PLATFORM_OPERATOR\.directors/);
  });
});

describe("inside the ResellerOS app", () => {
  it("the login page (also the site's Client login) links the buyer documents", () => {
    const c = read("src/app/(auth)/login/page.tsx");
    expect(c).toMatch(/href=\{"\/terms-and-conditions" as never\}/);
    expect(c).toMatch(/href=\{"\/refund" as never\}/);
    expect(c).toMatch(/href=\{"\/privacy-policy" as never\}/);
  });
  it("the public pages' footer names both sets of terms apart", () => {
    const c = read("src/app/(public)/_components/public-shell.tsx");
    expect(c).toMatch(/"\/terms" as never\}\s+className="hover:text-ink">ResellerOS terms</);
    expect(c).toMatch(/"\/terms-and-conditions" as never\} className="hover:text-ink">Terms and conditions</);
    expect(c).toMatch(/"\/refund" as never\}\s+className="hover:text-ink">Refund policy</);
    expect(c).toMatch(/"\/privacy" as never\} className="hover:text-ink">ResellerOS privacy</);
    expect(c).toMatch(/"\/privacy-policy" as never\} className="hover:text-ink">Privacy policy</);
  });
  it("Online Orders shows staff what buyers agreed to", () => {
    const c = read("src/app/(app)/online-orders/page.tsx");
    expect(c).toMatch(/href="\/terms-and-conditions"/);
    expect(c).toMatch(/href="\/refund"/);
  });
});
