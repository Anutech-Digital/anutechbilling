/**
 * R-226 (6 Oct 2026): the Buy-now dialog's Pay must not create an order (and so must not open
 * Razorpay) until the terms / refund box is ticked, and the annual, no-mid-term-cancel line
 * sits above Pay.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buyNowSchema, BUY_TERMS_ERROR, BUY_ANNUAL_NOTE } from "./buy-now-schema";

const base = {
  fullName: "Asha Rao", companyName: "Acme Pvt Ltd", email: "asha@acme.in", phone: "9000000000",
  seats: 5, domain: "acme.in", tierId: "business-starter", stateCode: "27",
};

describe("R-226 buy-now terms tick", () => {
  it("no tick → the form is refused with the nudge on agreeTerms", () => {
    for (const agreeTerms of [undefined, false]) {
      const r = buyNowSchema.safeParse({ ...base, agreeTerms });
      expect(r.success).toBe(false);
      const issue = r.success ? undefined : r.error.issues.find((i) => i.path[0] === "agreeTerms");
      expect(issue?.message).toBe(BUY_TERMS_ERROR);
    }
  });

  it("ticked → the form passes", () => {
    expect(buyNowSchema.safeParse({ ...base, agreeTerms: true }).success).toBe(true);
  });

  it("the state rule (R-173) still holds", () => {
    const r = buyNowSchema.safeParse({ ...base, stateCode: "", agreeTerms: true });
    expect(r.success).toBe(false);
  });

  it("the dialog renders the tick with terms + refund links and the annual line above Pay", () => {
    const src = readFileSync(join(__dirname, "buy-workspace-client.tsx"), "utf8");
    expect(src).toMatch(/resolver: zodResolver\(buyNowSchema\)/);
    expect(src).toMatch(/register\("agreeTerms"\)/);
    expect(src).toMatch(/href="\/terms-and-conditions"/);
    expect(src).toMatch(/href="\/refund"/);
    const note = src.indexOf("{BUY_ANNUAL_NOTE}");
    const tick = src.indexOf('id="buy-agree-terms"');
    const pay = src.indexOf("securely`}");
    expect(note).toBeGreaterThan(0);
    expect(tick).toBeGreaterThan(note);
    expect(pay).toBeGreaterThan(tick);
    expect(BUY_ANNUAL_NOTE).toMatch(/12 months/);
    expect(BUY_ANNUAL_NOTE).toMatch(/mid-term cancellation/);
  });
});
