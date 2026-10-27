// R-1927 (G-ONBOARD OB-6) — a shorter setup wizard, on the owner's real path:
// confirm link → /setup?welcome=1 → Company (Name, GSTIN, State) → Continue → Import → Continue
// → Done → "Create your first quote" → /quotes/new with a price list already loaded.
//
// Before (anutech/manager-pardeep ac31ee5e2):
//  - step 1 showed up to 13 fields on one form (page.tsx:136-320);
//  - the catalogue loaded only if the owner found "Load default catalog" in the Import step
//    (:556-583) — pressing Continue left an EMPTY quote builder;
//  - Razorpay and Google were two whole steps before the first quote (:54-60);
//  - the Done screen's primary button was "Open dashboard"; the quote was a secondary button.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DONE_STEP, wizardMove } from "./wizard-nav";
import { buildDoneChecklist, NEXT_STEPS, type DoneInputs } from "./done-checklist";
import { shouldAutoLoadCatalog } from "./auto-catalog";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
const page = read("page.tsx");
const done = read("done-screen.tsx");

/** The JSX of the company step, split at the "More details" disclosure. */
function companyStep() {
  const start = page.indexOf("function StepCompany(");
  const end = page.indexOf("\n}\n", start);
  const body = page.slice(start, end);
  const more = body.indexOf("More details");
  return { body, visible: more < 0 ? body : body.slice(0, more), more: more < 0 ? "" : body.slice(more) };
}

describe("R-1927 wizard: Company → Import → Done", () => {
  it("has three steps; Razorpay and Google are no longer steps", () => {
    const steps = page.match(/const STEPS = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
    const ids = [...steps.matchAll(/id:\s*"([a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["company", "import", "done"]);
    expect(DONE_STEP).toBe(2);
    expect(page).not.toMatch(/<StepRazorpay|<StepCsp/);
  });

  it("the owner reaches Done with two Continues (save company, then finish)", () => {
    let step = 0;
    const moves: string[] = [];
    while (step < DONE_STEP) {
      moves.push(wizardMove(step));
      step += 1;
    }
    expect(moves).toEqual(["save-company", "finish"]);
  });

  it("every footer label and the Done check follow DONE_STEP, not a hard-coded 3 / 4", () => {
    expect(page).not.toMatch(/step === 3|step < 4|step === 4/);
    expect(page).toMatch(/step === DONE_STEP && <StepDone/);
  });

  it("the welcome line does not promise 5 steps", () => {
    expect(page).not.toMatch(/5 quick steps/);
  });
});

describe("R-1927 step 1 asks only Name, GSTIN and State", () => {
  it("Legal name, GSTIN and State are on screen, before 'More details'", () => {
    const { visible } = companyStep();
    expect(visible).toMatch(/id="setup-legal-company-name"/);
    expect(visible).toMatch(/id="setup-gstin"/);
    expect(visible).toMatch(/id="setup-state"/);
  });

  it("address, invoice code, contact, PIN and bank sit under 'More details (optional)'", () => {
    const { visible, more } = companyStep();
    for (const id of ["setup-registered-address", "setup-invoice-code", "setup-owner-contact-name",
      "setup-contact-email", "setup-pin-code", "setup-upi", "setup-bank-name", "setup-account-number", "setup-ifsc"]) {
      expect(visible).not.toContain(`id="${id}"`);
      expect(more).toContain(`id="${id}"`);
    }
    expect(page).toMatch(/More details[^<]*<span[^>]*>\s*\(optional\)/);
  });

  it("a problem inside More details opens it, so the owner sees what to fix", () => {
    expect(page).toMatch(/<details[^>]*open=\{payError \|\| codeError \? true : undefined\}/);
  });
});

describe("R-1927 the price list loads by itself", () => {
  const support = { vendor: "support" };
  const product = { vendor: "google" };

  it("the owner with no products → load DEFAULT_CATALOG", () => {
    expect(shouldAutoLoadCatalog([], true)).toBe(true);
    expect(shouldAutoLoadCatalog([support, support], true)).toBe(true); // seeded support tiers are not a catalog
  });
  it("never over an existing catalogue, never while unknown, never for a non-owner", () => {
    expect(shouldAutoLoadCatalog([product], true)).toBe(false);
    expect(shouldAutoLoadCatalog(undefined, true)).toBe(false);
    expect(shouldAutoLoadCatalog([], false)).toBe(false);
  });
  it("saving step 1 runs the existing useLoadDefaultCatalog (no second copy of the prices)", () => {
    const save = page.slice(page.indexOf("const saveCompanyAndAdvance"), page.indexOf("const finishSetup"));
    expect(save).toMatch(/shouldAutoLoadCatalog\(/);
    expect(save).toMatch(/loadCatalog\.mutateAsync\(\)/);
    expect(page).toMatch(/useLoadDefaultCatalog\(\)/);
    expect(page).not.toMatch(/msrp:\s*\d/); // no prices typed into the wizard
  });
});

describe("R-1927 Done: first quote is the next step, integrations are 'Later'", () => {
  it("primary button is 'Create your first quote' → /quotes/new", () => {
    const primary = done.match(/<Button variant="primary" asChild>\s*<Link href="([^"]+)">[\s\S]*?<\/Link>/);
    expect(primary?.[1]).toBe("/quotes/new");
    expect(primary?.[0]).toMatch(/Create your first quote/);
    expect(done).not.toMatch(/Send first quote/); // one way, one label
  });

  const base: DoneInputs = {
    gstin: null, gstinVerifiedAt: null, stateCode: "07", address: null, upiVpa: null, remitAccountNumber: null,
    customerCount: 0, catalogCount: 7,
    razorpay: { configured: false }, whatsapp: { configured: false }, googleReseller: { connected: false },
  };
  it("Razorpay, Google and WhatsApp rows are marked later; the rest are not", () => {
    const later = buildDoneChecklist(base).filter((i) => i.later).map((i) => i.id);
    expect(later).toEqual(["razorpay", "google", "whatsapp"]);
  });
  it("the Done screen shows the later rows under their own 'Later' heading", () => {
    expect(done).toMatch(/>\s*Later\s*</);
    expect(done).toMatch(/\.filter\(\(it\) => it\.later\)/);
    expect(done).toMatch(/\.filter\(\(it\) => !it\.later\)/);
  });
  it("next steps do not repeat the first-quote button or the integrations", () => {
    expect(NEXT_STEPS.map((s) => s.href)).not.toContain("/quotes/new");
    expect(NEXT_STEPS.map((s) => s.href)).not.toContain("/settings?tab=integrations");
  });
});
