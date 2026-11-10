/**
 * R-2192: bank-page-perf-golden.json was re-made after the ₹1 tolerance (8 matches on the 6,000-line
 * fixture are within ₹1 of their invoice; matches now carry roundOff). This proves that
 * change is the ONLY difference: with sameMoney switched off and the new field left out, the
 * matcher gives exactly R-2524's digest (6dfed652a, before the re-make).
 */
import { it, vi, expect } from "vitest";
import { createHash } from "node:crypto";
vi.mock("@/lib/banking/same-money", () => ({ sameMoney: () => false, ROUND_OFF_AUTO: 1 }));
import { bankPerfFixture } from "./bank-page-perf-fixture";
import { matchCreditToInvoices } from "@/lib/banking/invoice-credit-match";
const R2524 = { matches: "c44674a5006a0ebb3b842d84c242ed830a88def2c463cf274e5f570c246692a3", matchCount: 84557 };
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
it("with the ₹1 rule off, the matches are exactly R-2524's", () => {
  const f = bankPerfFixture(6000);
  const matches = f.txns.map((t) => matchCreditToInvoices({ amount: t.credit, txnDate: t.txn_date, description: t.description, reference: t.reference }, f.invoices));
  const stripped = matches.map((ms) => ms.map(({ roundOff, ...rest }) => { void roundOff; return rest; }));
  expect(sha(stripped)).toBe(R2524.matches);
  expect(matches.reduce((n, m) => n + m.length, 0)).toBe(R2524.matchCount);
});
