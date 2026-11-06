/**
 * R-2534 — UTR / RRN / cheque number out of HDFC / ICICI / Axis / SBI narrations. The same table
 * (narration-ref-cases.ts) is checked against the SQL twin in supabase/tests/r2534_bank_ref_key.test.sql;
 * the last test here proves every row is in that file.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NARRATION_REF_CASES } from "./narration-ref-cases";
import { bankRefKey, bankRefNorm, parseNarrationRef, referenceMatchesKey } from "./narration-ref";
import { utrCandidates } from "@/lib/integrations/zoho-books/payment-match";

describe("R-2534 parseNarrationRef — real-shaped narrations", () => {
  it("has 20+ cases across the four banks", () => {
    expect(NARRATION_REF_CASES.length).toBeGreaterThanOrEqual(20);
    for (const b of ["HDFC", "ICICI", "Axis", "SBI"]) expect(NARRATION_REF_CASES.some((c) => c.bank === b)).toBe(true);
  });

  it.each(NARRATION_REF_CASES.map((c) => [c.bank, c.narration, c] as const))("%s: %s", (_b, _n, c) => {
    const got = parseNarrationRef(c.narration, c.ref);
    expect(got?.key ?? null).toBe(c.key);
    expect(got?.kind ?? null).toBe(c.kind);
    expect(bankRefKey(c.narration, c.ref)).toBe(c.key);
  });

  it("a 12-digit phone UPI id before the RRN is not the RRN", () => {
    expect(bankRefKey("UPI-A-919876543210@PAYTM-PYTM0123456-621812345678-X")).toBe("621812345678");
    expect(bankRefKey("UPI-A-919876543210@PAYTM-PYTM0123456-X")).toBeNull();
  });

  it("empty / null narration → null", () => {
    expect(bankRefKey(null)).toBeNull();
    expect(bankRefKey("")).toBeNull();
    expect(bankRefKey("   ", "0000")).toBeNull();
  });
});

describe("R-2534 referenceMatchesKey", () => {
  it("equal after normalising (zeros, spaces, punctuation)", () => {
    expect(bankRefNorm(" 0000-6218 5639 5591 ")).toBe("621856395591");
    expect(referenceMatchesKey("0000621856395591", "621856395591")).toBe(true);
    expect(referenceMatchesKey("hdfcn52026110612345", "HDFCN52026110612345")).toBe(true);
  });
  it("a long key inside a longer typed reference matches; a short cheque number must be equal", () => {
    expect(referenceMatchesKey("UTR: 0811OP6167031041 (Suresh)", "811OP6167031041")).toBe(true);
    expect(referenceMatchesKey("INV 781 / 2026", "781")).toBe(false);
    expect(referenceMatchesKey("000781", "781")).toBe(true);
  });
  it("nothing matches an empty key or reference", () => {
    expect(referenceMatchesKey("", "621856395591")).toBe(false);
    expect(referenceMatchesKey("621856395591", null)).toBe(false);
    expect(referenceMatchesKey("000000", "")).toBe(false);
  });
});

describe("R-2534 Zoho Find-in-Zoho tries the parsed reference first", () => {
  it("the line's ref key leads utrCandidates", () => {
    const c = utrCandidates({ description: "UPI-MOHIT SHARMA-919876543210@PAYTM-PYTM0123456-621812345678-PAYMENT", reference: null });
    expect(c[0]).toBe("621812345678");
    expect(c).not.toContain("919876543210");
  });
  it("NEFT CR: the UTR leads (not the remitter's account)", () => {
    const c = utrCandidates({ description: "NEFT-HDFCN52026110612345-KAPOOR LEGAL-INV 88-50200012345678-HDFC0000240", reference: null });
    expect(c[0]).toBe("HDFCN52026110612345");
  });
});

describe("R-2534 the SQL twin is tested on the same table", () => {
  it("every case is a row of supabase/tests/r2534_bank_ref_key.test.sql", () => {
    const sql = readFileSync(path.join(__dirname, "../../../supabase/tests/r2534_bank_ref_key.test.sql"), "utf8");
    const q = (s: string | null) => (s === null ? "null" : `'${s.replace(/'/g, "''")}'`);
    for (const c of NARRATION_REF_CASES) {
      expect(sql, c.narration).toContain(`(${q(c.narration)}, ${q(c.ref)}, ${q(c.key)})`);
    }
  });
});
