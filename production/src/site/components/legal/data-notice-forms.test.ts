/**
 * R-2011 (DPDP): every public form the 27 Oct audit listed shows the shared <DataNotice> next to
 * its button, starts the "Send me offers" box UNTICKED, and sends `formConsent("<form>", optIn)`
 * with its normal body; the checkouts also show the 18+ line. And every API route behind those
 * forms records it (recordFormConsent with readFormConsent(body)) — a form without its route
 * would show a box whose answer is thrown away.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CONSENT_FORMS } from "@/lib/consent/data-notice";

const read = (f: string) => readFileSync(f, "utf8");

const FORMS: ReadonlyArray<{ file: string; forms: string[]; adultLine?: boolean }> = [
  { file: "src/app/(public)/buy/workspace/_parts/checkout.tsx", forms: [], adultLine: true }, // consent sent by submit-order.ts
  { file: "src/app/(public)/buy/support/support-checkout.tsx", forms: ["support_checkout"], adultLine: true },
  { file: "src/app/(marketing)/checkout/page.tsx", forms: ["cart_checkout"], adultLine: true },
  { file: "src/site/components/lp/WorkspaceAdLanding.tsx", forms: ["ad_callback", "workspace_enquiry"] },
  { file: "src/site/components/home/HomeCompany.tsx", forms: ["callback"] },
  { file: "src/site/components/trial/TrialForm.tsx", forms: ["trial"] },
  { file: "src/site/components/quote/QuoteBuilder.tsx", forms: ["quote_builder"] },
  { file: "src/app/(public)/enquiry/enquiry-client.tsx", forms: ["enquiry"] },
];

describe("every listed form shows the data notice + an unticked offers box (R-2011)", () => {
  it.each(FORMS)("$file", ({ file, forms, adultLine }) => {
    const src = read(file);
    expect(src).toMatch(/<DataNotice\b/);
    expect(src).toMatch(/optIn=\{optIn\} onOptIn=\{setOptIn\}/);
    expect(src).toMatch(/const \[optIn, setOptIn\] = (React\.)?useState\(false\)/);
    for (const f of forms) expect(src).toContain(`formConsent("${f}", optIn)`);
    if (adultLine) expect(src).toMatch(/<DataNotice[^>]*adultLine/);
  });

  it("the buy page sends the box with pay, trial and quote", () => {
    const src = read("src/app/(public)/buy/workspace/_parts/submit-order.ts");
    for (const f of ["buy_checkout", "buy_trial", "buy_quote"]) expect(src).toContain(`formConsent("${f}", ctx.marketingOptIn === true)`);
    expect(src).toContain("consentAnonId: consentAnonId(), ...optIn }");
    expect(read("src/app/(public)/buy/workspace/_parts/checkout.tsx")).toContain("marketingOptIn: optIn");
  });

  it("the AI chat shows the notice (no offers box — it is not a form)", () => {
    const src = read("src/site/components/agent/AgentChat.tsx");
    expect(src).toMatch(/<DataNotice purpose="chat"/);
  });

  it("every form key the forms send is a known one", () => {
    for (const { forms } of FORMS) for (const f of forms) expect(CONSENT_FORMS).toContain(f);
  });
});

describe("every route behind those forms records the opt-in (R-2011)", () => {
  it.each([
    "src/app/api/public/callback/route.ts",
    "src/app/api/public/enquiry/general/route.ts",
    "src/app/api/public/enquiry/workspace/route.ts",
    "src/app/api/public/trial/workspace/route.ts",
    "src/app/api/public/checkout/workspace/route.ts",
    "src/app/api/public/checkout/support/route.ts",
    "src/lib/checkout/cart-checkout.ts",
  ])("%s", (file) => {
    expect(read(file)).toMatch(/recordFormConsent\(admin|recordFormConsent\(createAdminClient\(\)/);
    expect(read(file)).toContain("consent: readFormConsent(body)");
  });

  it("/api/enquiry (trial + quote pages) passes the consent through to the handler", () => {
    const src = read("src/app/api/enquiry/route.ts");
    expect(src).toContain("const consent = readFormConsent(body);");
    expect(src).toContain("attribution.consent = consent");
  });
});
