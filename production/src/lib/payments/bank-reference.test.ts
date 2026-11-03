import { describe, expect, it } from "vitest";
import { bankReferenceKey, isRealBankReference } from "./bank-reference";

/* R-2424 — the same cases as supabase/tests/r2424_placeholder_bank_ref.test.sql. */
const PLACEHOLDERS = ["", "   ", "000000000000000", "0000-0000-0000", "000000", "111111111111", "XXXXXXXX", "NA", "-", "0", "N/A", "NIL", "x x x x x x", "NOT AVAILABLE", "Not-Applicable", "no reference", "NOT PROVIDED"];
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

/* R-2441 — the same cases as supabase/tests/r2441_review_fixes.test.sql (part 2). */
const PREFIXED_PLACEHOLDERS = ["NEFT-000000000000", "UPI/000000000000", "UTR:0000000000", "IMPS/000000", "RTGS 000000000000000",
  "neft/utr/000000000000", "UTR NO 000000000", "UPIREF000000", "NEFT-", "UPI/XXXXXXXX", "NEFT N/A", "UTR NOT AVAILABLE",
  "REF NONE", "UTR NIL", "TXN-001", "NEFT-12", "UTR NO 12", "IMPS NOT PROVIDED"];
const PREFIXED_REAL = ["UPI/412345678901", "NEFT-N123260512345678", "UTR:HDFCN52026051912345678", "IMPS/612345000000",
  "TESTUTR123456", "162440272175", "100000", "NEFT100000"];

describe("R-2441 rail prefixes (NEFT/RTGS/IMPS/UPI/UTR/REF/TXN/NO) before a placeholder", () => {
  it.each(PREFIXED_PLACEHOLDERS)("%j is a placeholder, not a UTR", (ref) => {
    expect(isRealBankReference(ref)).toBe(false);
    expect(bankReferenceKey("bank_transfer", ref)).toBeNull();
  });
  it.each(PREFIXED_REAL)("%j stays a real reference", (ref) => {
    expect(isRealBankReference(ref)).toBe(true);
  });
  it("a real prefixed UTR keeps exactly its R-1676 key", () => {
    expect(bankReferenceKey("upi", "UPI/412345678901")).toBe("BANK:UPI/412345678901");
    expect(bankReferenceKey("bank_transfer", "NEFT-N123260512345678")).toBe("BANK:NEFTN123260512345678");
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
