/**
 * R-228 — the quote / trial reference number shown on the website is the app's own number
 * (draft quote or lead id from /api/enquiry), never a per-browser localStorage counter that
 * started every visitor at AQ-YYYYMM-001.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { enquiryReference, referenceNote } from "./enquiry-reference";

const SRC = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(SRC, p), "utf8");

describe("enquiryReference — what the proxy answered", () => {
  it("takes the server's reference", () => {
    expect(enquiryReference({ ok: true, reference: "QT-2026-0042" })).toBe("QT-2026-0042");
    expect(enquiryReference({ ok: true, reference: " L-MG3X9K " })).toBe("L-MG3X9K");
  });
  it("is empty when the server gave none — nothing is made up", () => {
    expect(enquiryReference({ ok: true, reference: null })).toBe("");
    expect(enquiryReference({ ok: true })).toBe("");
    expect(enquiryReference(null)).toBe("");
    expect(enquiryReference("x")).toBe("");
  });
});

describe("referenceNote — the line shown where the number would be", () => {
  it("the number itself when there is one", () => {
    expect(referenceNote("L-MG3X9K", { received: true, ackSent: true })).toBe("Ref L-MG3X9K");
  });
  it("received, no number, copy emailed: the number comes by email", () => {
    expect(referenceNote("", { received: true, ackSent: true })).toBe("Reference number will come by email");
  });
  it("received, no number, no email: we share it when we call", () => {
    expect(referenceNote("", { received: true, ackSent: false })).toBe("We will share your reference number when we call");
  });
  it("not received: says there is no number yet", () => {
    expect(referenceNote("", { received: false, ackSent: false })).toBe("Not registered yet — no reference number");
  });
});

describe("the forms show the server's number", () => {
  for (const file of ["components/quote/QuoteBuilder.tsx", "components/trial/TrialForm.tsx"]) {
    it(`${file}: no localStorage counter, no AQ-/AT- number built in the browser`, () => {
      const src = read(file);
      expect(src).not.toMatch(/anutech-(quote|trial)-seq/);
      expect(src).not.toMatch(/`A[QT]-\$\{/);
      expect(src).toMatch(/enquiryReference\(/);
    });
  }
});
