/**
 * R-2524 — the answers of the bank page's guesses on the 6,000-line fixture, as one digest.
 * bank-page-perf-golden.json holds this digest made with the code BEFORE R-2524 (the matcher,
 * customer guess and vendor guess as on anutech/manager-pardeep 6dfed652a); the test makes it
 * again with today's code and the two must be identical — the speed-up changed no answer.
 */
import { createHash } from "node:crypto";
import { bankPerfFixture } from "./bank-page-perf-fixture";
import { matchCreditToInvoices } from "@/lib/banking/invoice-credit-match";
import { guessCustomer } from "@/lib/banking/credit-pay-for";
import { guessVendor } from "@/lib/banking/debit-pay-for";
import { nameOverlap } from "@/lib/accounting/credit-match";

const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

export function guessDigest() {
  const f = bankPerfFixture(6000);
  const memory = { payers: [], ownNames: ["Anutech"] };
  // every line, matched or not, money in or out — exactly the per-line call the page made before
  const matches = f.txns.map((t) => matchCreditToInvoices(
    { amount: t.credit, txnDate: t.txn_date, description: t.description, reference: t.reference }, f.invoices));
  const customers = f.txns.map((t, i) => guessCustomer(t, f.customers, matches[i], memory));
  const vendors = f.txns.map((t) => guessVendor(t, f.vendors, {}));
  const overlaps = f.txns.slice(0, 300).flatMap((t) => f.invoices.slice(0, 50).map((inv) => nameOverlap(t.description, inv.customerName)));
  return {
    matches: sha(matches), matchCount: matches.reduce((n, m) => n + m.length, 0),
    customers: sha(customers), customerHits: customers.filter(Boolean).length,
    vendors: sha(vendors), vendorHits: vendors.filter(Boolean).length,
    overlaps: sha(overlaps),
  };
}
