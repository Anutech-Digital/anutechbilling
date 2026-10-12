/**
 * The detector run against the REAL invoices, as they stood on 22 Aug 2026.
 *
 * This is not a unit test of the rules — mismatch.test.ts does that. This is the answer to
 * "what does it actually find in our books", pinned so that a future change to the rules
 * cannot quietly stop finding it.
 *
 * The rows below were read out of production (21 invoices, ANUTECH tenant) and reduced to
 * the fields the audit reads. No amounts were altered; the customer names are the real ones
 * because the finding is about specific customers and anonymising them would make the
 * output impossible to act on.
 */
import { describe, it, expect } from "vitest";
import { auditInvoiceGst, summariseGstIssues } from "./mismatch";

const SELLER = { stateCode: "07", gstin: "07ABDCA0298H1ZP", country: "India" };

/** [customer, gstin, stateCode, taxable, tax, interState, count] */
const LIVE: [string, string | null, string | null, number, number, boolean, number][] = [
  ["AB corprotion",      "8947HIJR894FJ",  "32",  635460, 114383, true,  5],
  ["Jijo corprotion",    "T67TRY54UTRH5Y", null,  278916,  50205, false, 3],
  ["KAILASH CORPROTION", null,             null,  213840,  38491, false, 2],
  ["Pankaj",             null,             null,  165600,  29808, false, 1],
  ["abc corporaton",     null,             null,  113676,  20462, false, 1],
  ["Pardeep Sharma",     null,             null,  113676,  20462, false, 1],
  ["Vivek corprotion",   null,             "24",  103680,  18662, true,  1],
  ["POP TECH",           null,             null,   81000,  14580, false, 1],
  ["Demo Co", null,             null,   56400,  10152, false, 2],
  ["Joel",               null,             null,   32400,   5832, false, 1],
  ["ROHINI TECH",        null,             null,   32400,   5832, false, 1],
  ["JASH PHARMA CHEM",   "27AABPM3961F1ZS","27",   24960,   4493, true,  1],
  ["SUSEN",              null,             "24",    9996,   1799, true,  1],
];

const audit = (row: (typeof LIVE)[number]) =>
  auditInvoiceGst(
    { taxableValue: row[3], taxAmount: row[4], taxRate: 18, interState: row[5] },
    { gstin: row[1], stateCode: row[2], country: "India" },
    SELLER,
  );

describe("what the detector finds in the real books", () => {
  it("clears the customers whose place of supply IS established", () => {
    /* Four of the thirteen are fine, and that matters as much as the failures: a checker
       that flags everything has told you nothing. Vivek (24) and SUSEN (24) are correctly
       IGST; JASH (27, with a valid matching GSTIN) is correctly IGST. */
    for (const name of ["Vivek corprotion", "SUSEN", "JASH PHARMA CHEM"]) {
      const row = LIVE.find((r) => r[0] === name)!;
      expect(audit(row), `${name} should be clean`).toEqual([]);
    }
  });

  it("flags both broken GSTINs", () => {
    /* "8947HIJR894FJ" is 13 characters and starts 89, which is not a state code.
       "T67TRY54UTRH5Y" starts with letters where the state code goes. Both are on real
       invoices, and both go into GSTR-1 as the buyer's identity. */
    expect(audit(LIVE.find((r) => r[0] === "AB corprotion")!).map((i) => i.code))
      .toContain("gstin_invalid");
    expect(audit(LIVE.find((r) => r[0] === "Jijo corprotion")!).map((i) => i.code))
      .toContain("gstin_invalid");
  });

  it("flags every customer whose tax head was assumed rather than determined", () => {
    const assumed = LIVE.filter((r) => audit(r).some((i) => i.code === "place_of_supply_unknown"));
    /* Nine of thirteen. Not a tidy-up — nine tax decisions taken by a default. */
    expect(assumed).toHaveLength(9);
    expect(assumed.map((r) => r[0]).sort()).toEqual([
      "Demo Co", "Joel", "KAILASH CORPROTION", "POP TECH", "Pankaj",
      "Pardeep Sharma", "ROHINI TECH", "abc corporaton", "Jijo corprotion",
    ].sort());
  });

  it("puts a rupee figure on it, counted once per customer", () => {
    const s = summariseGstIssues(LIVE.map(audit));
    expect(s.invoicesWithIssues).toBe(10);          // 9 assumed + AB corprotion's bad GSTIN
    /* Rs 3,10,207 of GST resting on either an unbacked place of supply or a GSTIN that is
       not a GSTIN. Pinned exactly: if a rule change moves this number, someone should have
       to explain why rather than notice a year later. */
    expect(s.totalAtRisk).toBe(310207);
    expect(s.byCode.place_of_supply_unknown).toBe(9);
    expect(s.byCode.gstin_invalid).toBe(2);
  });

  it("finds no arithmetic errors, which is worth stating", () => {
    /* All 21 invoices compute tax correctly at 18%. The sums were never the problem — the
       INPUTS were. Asserted so that "the detector found nothing arithmetic" stays a
       measured fact rather than an assumption nobody rechecked. */
    for (const row of LIVE) {
      expect(audit(row).map((i) => i.code), row[0]).not.toContain("tax_arithmetic");
    }
  });
});
