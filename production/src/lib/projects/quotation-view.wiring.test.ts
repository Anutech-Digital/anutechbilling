/**
 * R-006 — a project's quotation shows up where quotes are looked for.
 *
 * A scan, because the defect was that one filter asked only about the `quotes` table.
 * No unit test can see a filter predicate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const strip = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const PROFILE = strip("src/components/features/customers/customer-profile.tsx");
const QUOTES  = strip("src/app/(app)/quotes/page.tsx");

describe("Customer 360 -> Quotes includes project quotations", () => {
  it("the Quotes segment counts project rows", () => {
    /* THE BUG: `type === "Quote"` only. Demo Co' ERP quotation was
       invisible under the one heading somebody would look for it. */
    expect(PROFILE).toContain("const isQuoteish");
    expect(PROFILE).toMatch(/txnFilter === "quotes"\s*\?\s*isQuoteish\(type\)/);
    expect(PROFILE).toMatch(/label: "Quotes",\s*n: txns\.filter\(\(t\) => isQuoteish\(t\.type\)\)/);
  });

  it("a project row reads in quote language, not raw status", () => {
    // "quoted" / "active" under a Quotes heading means nothing to a reader.
    expect(PROFILE).toContain("projectQuotationView(");
    expect(PROFILE).not.toMatch(/type: "Project" as const[^}]*status: p\.status/);
  });

  it("nothing copies a project into the quotes table", () => {
    /* Pardeep asked for this explicitly: a copy would double it in the pipeline and
       in Customer 360, and then the two rows would drift. */
    expect(PROFILE).not.toMatch(/from\("quotes"\)[\s\S]{0,120}\.insert\(/);
  });
});

describe("/quotes already lists them — measured, not assumed", () => {
  it("has a Project tab fed by the project sales query", () => {
    /* This existed before the request (commit e04a81af, 4 Aug 2026). R-006 item 2
       assumed it did not. Asserted here so the claim in the request file is checkable
       rather than something I said once. */
    expect(QUOTES).toContain("useProjectSales()");
    expect(QUOTES).toMatch(/id: "project",\s*label: "Project"/);
  });
});
