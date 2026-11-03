import { describe, expect, it } from "vitest";
import { bankReferenceKey, isRealBankReference } from "./bank-reference";

/* R-2424 — the same cases as supabase/tests/r2424_placeholder_bank_ref.test.sql. */
const PLACEHOLDERS = ["", "   ", "000000000000000", "0000-0000-0000", "000000", "111111111111", "XXXXXXXX", "NA", "-", "0", "N/A", "NIL", "x x x x x x"];
const REAL = ["TESTUTR123456", "162440272175", "0000162440272175", "HDFCN52026051912345678", "  testutr 1234-56 ", "100000"];

describe("R-2424 isRealBankReference", () => {
  it.each(PLACEHOLDERS)("%j is a placeholder, not a UTR", (ref) => {
    expect(isRealBankReference(ref)).toBe(false);
  });
  it.each(REAL)("%j is a real reference", (ref) => {
    expect(isRealBankReference(ref)).toBe(true);
  });
  it("null / undefined are placeholders", () => {
    expect(isRealBankReference(null)).toBe(false);
    expect(isRealBankReference(undefined)).toBe(false);
  });
});

describe("R-2424 bankReferenceKey (twin of public.payment_ref_key)", () => {
  it("staging case: two different credits with an all-zero reference get no key, so neither blocks the other", () => {
    expect(bankReferenceKey("bank_transfer", "000000000000000")).toBeNull();
    expect(bankReferenceKey("upi", "000000000000000")).toBeNull();
  });
  it("a real UTR keeps its R-1676 key (spaces/hyphens dropped, upper-case) — a repeat is still caught", () => {
    expect(bankReferenceKey("bank_transfer", "TESTUTR123456")).toBe("BANK:TESTUTR123456");
    expect(bankReferenceKey("upi", "  testutr 1234-56 ")).toBe("BANK:TESTUTR123456");
  });
  it("leading zeros on a real UTR are kept in the key, as before", () => {
    expect(bankReferenceKey("bank_transfer", "0000162440272175")).toBe("BANK:0000162440272175");
  });
  it("cash, cheque, razorpay and other never get a key", () => {
    for (const m of ["cash", "cheque", "razorpay", "other", null]) expect(bankReferenceKey(m, "TESTUTR123456")).toBeNull();
  });
});
