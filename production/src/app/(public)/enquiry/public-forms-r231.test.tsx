// @vitest-environment jsdom
//
// R-231 (6 Oct 2026): the website's quote / trial / buy / enquiry forms — one column on a
// phone, browser autofill for name / company / email / mobile, a real 10-digit mobile rule
// on the quote form, and the trial asks for the person's name instead of sending the
// company as it.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QField, isIndianMobile } from "@/site/components/quote/QuoteBuilder";
import { TField } from "@/site/components/trial/TrialForm";

afterEach(cleanup);
const SRC = join(__dirname, "..", "..", "..");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

describe("R-231 public form fields", () => {
  it("mobile rule: 10 digits starting 6-9, +91 / 0 allowed in front", () => {
    expect(isIndianMobile("12345")).toBe(false);
    expect(isIndianMobile("98765 43210")).toBe(true);
    expect(isIndianMobile("98765 4321")).toBe(false);
    expect(isIndianMobile("+91 98765 43210")).toBe(true);
    expect(isIndianMobile("098765 43210")).toBe(true);
    expect(isIndianMobile("12345 67890")).toBe(false);
    expect(isIndianMobile("98765 432101")).toBe(false);
  });

  it("quote form: a 5-digit mobile shows an error once touched", () => {
    render(<QField label="Mobile" value="12345" set={() => {}} touched required kind="tel" autoComplete="tel" inputMode="tel" />);
    const box = screen.getByLabelText(/Mobile/);
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("autocomplete")).toBe("tel");
    expect(box.getAttribute("inputmode")).toBe("tel");
    expect(screen.getByText("Enter a 10-digit mobile number.")).toBeTruthy();
  });

  it("quote + trial fields carry autofill hints", () => {
    render(<TField label="Your name" value="" set={() => {}} err="" autoComplete="name" />);
    expect(screen.getByLabelText(/Your name/).getAttribute("autocomplete")).toBe("name");
    const qb = read("site/components/quote/QuoteBuilder.tsx");
    const tf = read("site/components/trial/TrialForm.tsx");
    for (const src of [qb, tf]) {
      for (const hint of ["organization", "email", "tel"]) expect(src).toContain(`autoComplete="${hint}"`);
    }
    expect(qb).toContain(`autoComplete="name"`);
  });

  it("the two-column detail grids collapse on a phone (data-grid)", () => {
    const qb = read("site/components/quote/QuoteBuilder.tsx");
    const tf = read("site/components/trial/TrialForm.tsx");
    expect(qb).toMatch(/gridTemplateColumns: "1fr 1fr", gap: 14 \}\} data-grid>/);
    expect(tf).toMatch(/gridTemplateColumns: "1fr 1fr", gap: 14 \}\} data-grid>/);
    expect(read("site/site.css")).toMatch(/\[data-grid\] \{ grid-template-columns: 1fr !important; \}/);
  });

  it("trial asks for the person's name and sends it as fullName", () => {
    const tf = read("site/components/trial/TrialForm.tsx");
    expect(tf).toMatch(/<TField label="Your name"/);
    expect(tf).toMatch(/fullName: contactName\.trim\(\)/);
    expect(tf).not.toMatch(/fullName: company/);
  });

  it("buy-now and enquiry forms carry autofill hints", () => {
    for (const f of ["app/(public)/buy/workspace/buy-workspace-client.tsx", "app/(public)/enquiry/enquiry-client.tsx"]) {
      const src = read(f);
      for (const hint of ["name", "organization", "email", "tel"]) expect(src).toContain(`autoComplete="${hint}"`);
    }
  });
});
