import { describe, expect, it } from "vitest";
import { duplicateReferenceHref, duplicateReferenceOf } from "./duplicate-reference";

const PAY = "11111111-2222-4333-8444-555555555555";
const CUST = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("R-1676 duplicateReferenceOf", () => {
  it("reads the existing payment from the database refusal", () => {
    const err = {
      message: "Ye UTR pehle se RV-2026-27-0004 par hai — reference TESTUTR123456 is already recorded …",
      details: `duplicate_payment_reference payment_id=${PAY} customer_id=${CUST}`,
      code: "P0001",
    };
    expect(duplicateReferenceOf(err)).toEqual({ paymentId: PAY, customerId: CUST });
    expect(duplicateReferenceHref(duplicateReferenceOf(err)!)).toBe(`/payments?customer=${CUST}`);
  });

  it("a payment with no customer still links to Payments", () => {
    const dup = duplicateReferenceOf({ details: `duplicate_payment_reference payment_id=${PAY} customer_id=` });
    expect(dup).toEqual({ paymentId: PAY, customerId: null });
    expect(duplicateReferenceHref(dup!)).toBe("/payments");
  });

  it("is null for any other error", () => {
    expect(duplicateReferenceOf(new Error("boom"))).toBeNull();
    expect(duplicateReferenceOf({ details: null })).toBeNull();
    expect(duplicateReferenceOf(null)).toBeNull();
    expect(duplicateReferenceOf({ details: "Key (id)=(x) already exists" })).toBeNull();
  });
});
