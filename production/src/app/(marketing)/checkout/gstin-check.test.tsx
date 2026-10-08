// @vitest-environment jsdom
//
// R-227 (6 Oct 2026): a mistyped GSTIN used to be dropped by the server without a word
// (isValidGstin fails → B2C invoice → the buyer loses input tax credit). Now the checkout
// and the Buy-now dialog refuse it on screen, and a valid GSTIN fills the state.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  missingCheckoutDetails, gstinProblem, normalizeGstinInput, GSTIN_INVALID_MSG, type CheckoutDetails,
} from "@/site/lib/checkout-details";
import { buyNowSchema } from "@/app/(public)/buy/workspace/buy-now-schema";
import { Field } from "./fields";

afterEach(cleanup);

const BAD = "27ABCDE1234F1Z9";   // right shape, wrong checksum
const GOOD = "07ABDCA0298H1ZP";  // Delhi, checksum passes

const ok: CheckoutDetails = {
  name: "Pawan", email: "pawan@anutech.in", phone: "7778886760", domain: "mywebsite.com",
  hasHosting: true, hasDomain: false, address: { line1: "", city: "", state: "", pin: "" },
};

describe("R-227 GSTIN check", () => {
  it("a wrong-checksum GSTIN is a problem; blank or valid is not", () => {
    expect(gstinProblem(BAD)).toBe(GSTIN_INVALID_MSG);
    expect(gstinProblem("27ABC")).toBe(GSTIN_INVALID_MSG);
    expect(gstinProblem("")).toBeNull();
    expect(gstinProblem("   ")).toBeNull();
    expect(gstinProblem(GOOD)).toBeNull();
    expect(gstinProblem(GOOD.toLowerCase())).toBeNull();
  });

  it("checkout Continue stays blocked on a bad GSTIN, and goes on when blank or valid", () => {
    expect(missingCheckoutDetails({ ...ok, gstin: BAD })).toEqual(["a valid GSTIN (or leave it blank)"]);
    expect(missingCheckoutDetails({ ...ok, gstin: "" })).toEqual([]);
    expect(missingCheckoutDetails({ ...ok, gstin: GOOD })).toEqual([]);
  });

  it("typing is uppercased, spaces dropped, capped at 15", () => {
    expect(normalizeGstinInput("07abdca 0298h1zp99")).toBe(GOOD);
  });

  it("Buy-now refuses a bad GSTIN; a valid one stands in for the state", () => {
    const base = {
      fullName: "Asha Rao", companyName: "Acme", email: "asha@acme.in", phone: "9000000000",
      seats: 5, domain: "acme.in", tierId: "t", agreeTerms: true,
    };
    const bad = buyNowSchema.safeParse({ ...base, gstin: BAD, stateCode: "27" });
    expect(bad.success).toBe(false);
    expect(bad.success ? null : bad.error.issues.find((i) => i.path[0] === "gstin")?.message).toBe(GSTIN_INVALID_MSG);
    expect(buyNowSchema.safeParse({ ...base, gstin: GOOD }).success).toBe(true);
    expect(buyNowSchema.safeParse({ ...base, gstin: "", stateCode: "27" }).success).toBe(true);
  });

  it("the GSTIN box caps length, asks for capitals and points at its error", () => {
    render(<Field label="GSTIN" value={BAD} onChange={() => {}} maxLength={15} autoCapitalize="characters" invalid describedBy="gstin-err" />);
    const box = screen.getByLabelText("GSTIN");
    expect(box.getAttribute("maxlength")).toBe("15");
    expect(box.getAttribute("autocapitalize")).toBe("characters");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("aria-describedby")).toBe("gstin-err");
  });

  it("the checkout page fills the state from a valid GSTIN and warns on a mismatch", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(src).toMatch(/stateCodeFromGstin\(gstin\)/);
    expect(src).toMatch(/gstinContradictsState\(/);
    expect(src).toMatch(/normalizeGstinInput/);
  });
});
