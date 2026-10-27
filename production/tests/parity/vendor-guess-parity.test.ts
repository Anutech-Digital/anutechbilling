/**
 * R-1867: auto-reconcile guesses the payee in SQL (bank_debit_vendor_guess); the Reconcile sheet
 * and the "Money out · no vendor yet" filter guess it in TypeScript (guessVendor). If the two ever
 * disagree, a line auto-paid to one vendor shows "no vendor yet" — or the sheet pre-fills another.
 *
 *   1. The SQL noise-word lists are the same words as credit-match.ts (read from both sources).
 *   2. guessVendor gives, on the SQL test's own narrations, the answers the SQL test asserts
 *      (supabase/tests/r1867_auto_vendor_payment.test.sql, block A).
 * DB-free: runs in the normal unit suite.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { guessVendor, type VendorLite } from "@/lib/banking/debit-pay-for";

const root = join(__dirname, "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/20261024211000_r1867_auto_vendor_payment.sql"), "utf8");
const creditMatch = readFileSync(join(root, "src/lib/accounting/credit-match.ts"), "utf8");

function sqlArray(name: string): string[] {
  const m = migration.match(new RegExp(`${name} constant text\\[\\] := array\\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`${name} not found in the migration`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}
function tsSet(name: string): string[] {
  const m = creditMatch.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!m) throw new Error(`${name} not found in credit-match.ts`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

describe("R-1867 SQL vendor guess = app guessVendor", () => {
  it("uses the same narration noise words", () => {
    expect(sqlArray("c_narr_noise")).toEqual(tsSet("NARRATION_NOISE"));
  });
  it("uses the same name noise words", () => {
    expect(sqlArray("c_name_noise")).toEqual(tsSet("NAME_NOISE"));
  });

  const vendors: VendorLite[] = [
    { id: "kapoor-legal", name: "Kapoor Legal Associates" },
    { id: "kapoor-stat", name: "Kapoor Stationers" },
    { id: "google", name: "Google Cloud India" },
    { id: "mehta", name: "Mehta Traders" },
    { id: "rao", name: "Rao Consultants" },
    { id: "zeta", name: "Zeta Infra", upi_id: "zeta@okhdfc" },
    { id: "nair", name: "Nair Printers", bank_account_no: "50100123456789" },
  ];
  const cases: [string, string | null][] = [
    ["NEFT-KAPOOR LEGAL ASSOCIATES-KL1", "kapoor-legal"],
    ["NEFT KAPOOR 1180", null],                 // tie: both Kapoor vendors share one word
    ["UPI/zeta@okhdfc/PAYMENT", "zeta"],
    ["IMPS 50100123456789 PRINT", "nair"],
    ["CHQ 004512", null],
    ["NEFT GOOGLE CLOUD", "google"],
    ["UPI-RAO CONSULTANTS-FEES", "rao"],
    ["NEFT VERMA HARDWARE", null],              // that vendor is another company's
  ];
  it.each(cases)("%s → %s (same answer the SQL test asserts)", (description, want) => {
    expect(guessVendor({ description, reference: null }, vendors)?.vendorId ?? null).toBe(want);
  });
});
