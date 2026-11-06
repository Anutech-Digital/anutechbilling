/**
 * R-2524 — bank account page speed with 6,000 lines (staging HDFC ··4523 had 5,170 on 6 Nov 2026).
 *
 * Every reconcile save refetches the line list, and the page then re-runs the steps below over
 * EVERY line before it can draw again — so this is the wait after each save, not just on open.
 *
 * BENCHMARK NOTE (Pardeep's laptop, node, this fixture, 6 Nov 2026 — numbers swing ±30 % with load):
 *   before R-2524: invoice chip 2,130–4,318 ms + "no customer yet" 12,731–15,422 ms (it matched EVERY
 *                  line against every open invoice, matched lines and money-out too, a second time)
 *                  + "no vendor yet" 609–678 ms → 15.6–20.5 s of frozen tab per save.
 *   after R-2524:  see the console line this test prints; it runs ~0.3–0.6 s in total.
 * What changed: invoice matches worked out once per unmatched credit and shared (chip + no customer);
 * narration / name words split once (cached), invoices / customers / vendors prepared once per list;
 * one Intl formatter. The results are the same — the matcher tests (invoice-credit-match,
 * credit-pay-for, debit-pay-for) are unchanged and green.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { bankPerfFixture } from "./bank-page-perf-fixture";
import { noCustomerYet } from "@/lib/banking/no-customer-yet";
import { certainInvoiceMatches, certainOf, invoiceMatchesOfCredits, matchCreditToInvoices } from "@/lib/banking/invoice-credit-match";
import { guessVendor } from "@/lib/banking/debit-pay-for";
import { linesOfImport } from "@/lib/banking/import-history";
import { applyBankFilters, facetCounts, DEFAULT_FILTERS, filterTotals } from "@/lib/banking/bank-filters";
import { runningBalances } from "@/lib/banking/running-balance";
import { reconcileCoverage } from "@/lib/banking/reconcile-coverage";
import { checkStatement } from "@/lib/banking/statement-check";
import { salaryLinesOf } from "@/components/features/banking/salary-lines-dialog";

function time<T>(fn: () => T): { ms: number; out: T } {
  const t0 = performance.now();
  const out = fn();
  return { ms: performance.now() - t0, out };
}

/** Generous on purpose (CI machines are slower and shared): before R-2524 this was 15–20 s. */
const BUDGET_MS = 4_000;

describe("R-2524 bank page pipeline at 6,000 lines", () => {
  const f = bankPerfFixture(6000);
  const memory = { payers: [], ownNames: ["Anutech"] };

  it("runs every step the page runs per save inside the budget, and prints where the time goes", () => {
    const steps: Record<string, number> = {};
    steps.running = time(() => runningBalances(f.txns, 0, null)).ms;
    steps.salary = time(() => salaryLinesOf(f.txns)).ms;
    const matches = time(() => invoiceMatchesOfCredits(f.txns, f.invoices));
    steps.creditMatches = matches.ms;
    steps.invoiceChips = time(() => certainOf(matches.out)).ms;
    steps.noCustomer = time(() => noCustomerYet(f.txns, f.customers, (t) => matches.out.get(t.id) ?? [], memory)).ms;
    steps.noVendor = time(() => f.txns.filter((t) => t.matched_to_type === null && t.debit > 0 && guessVendor(t, f.vendors, {}) === null)).ms;
    steps.imports = time(() => f.imports.map((r) => linesOfImport(r, f.txns))).ms;
    steps.facets = time(() => facetCounts(f.txns, DEFAULT_FILTERS, {})).ms;
    const vis = time(() => applyBankFilters(f.txns, DEFAULT_FILTERS, {}));
    steps.filter = vis.ms;
    steps.totals = time(() => filterTotals(vis.out)).ms;
    steps.coverage = time(() => reconcileCoverage(f.txns)).ms;
    steps.statement = time(() => checkStatement(f.txns, 0)).ms;
    const total = Object.values(steps).reduce((a, b) => a + b, 0);
    // eslint-disable-next-line no-console
    console.log("R-2524 6000-line pipeline (ms):", JSON.stringify({ ...Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, Math.round(v)])), total: Math.round(total) }));
    expect(f.txns).toHaveLength(6000);
    expect(total).toBeLessThan(BUDGET_MS);
  });

  it("the shared matches give the same chips and the same 'no customer yet' lines as matching per line", () => {
    const shared = invoiceMatchesOfCredits(f.txns, f.invoices);
    const chipsOld = certainInvoiceMatches(f.txns, f.invoices);
    const chipsNew = certainOf(shared);
    expect([...chipsNew.keys()].sort()).toEqual([...chipsOld.keys()].sort());
    for (const [id, m] of chipsOld) expect(chipsNew.get(id)?.invoiceId).toBe(m.invoiceId);

    const perLine = noCustomerYet(f.txns, f.customers, (t) => matchCreditToInvoices(
      { amount: t.credit, txnDate: t.txn_date, description: t.description, reference: t.reference }, f.invoices), memory).map((t) => t.id);
    const viaShared = noCustomerYet(f.txns, f.customers, (t) => shared.get(t.id) ?? [], memory).map((t) => t.id);
    expect(viaShared).toEqual(perLine);
    expect(perLine.length).toBeGreaterThan(0);   // the fixture really exercises the rule
    expect(chipsNew.size).toBeGreaterThan(0);
  });

  it("the page matches each credit once and reads badges only for the lines it draws (source guard)", () => {
    const page = readFileSync(path.join(process.cwd(), "src/app/(app)/accounting/banking/[id]/page.tsx"), "utf8");
    expect(page).not.toMatch(/matchCreditToInvoices\(/);
    expect(page).not.toMatch(/certainInvoiceMatches\(/);
    expect(page).toMatch(/invoiceMatchesOfCredits\(/);
    // advance / split badges: only the drawn page of lines, never `transactions`
    expect(page).toMatch(/drawnTxns\.filter\(\(t\) => t\.matched_to_type === "payment" && t\.credit > 0 && t\.matched_to_id\)/);
    expect(page).toMatch(/drawnTxns\.filter\(\(t\) => t\.matched_to_type === "payment" && t\.credit > 0\)\.map\(\(t\) => t\.id\)/);
    // no mutation hook per row; the Reconcile sheet mounts on first use
    expect(page).not.toMatch(/useReconcileTransaction\(\)/);
    expect(page).toMatch(/\(drawerMounted \|\| reconcileTxn\) && <ReconcileTransactionDialog/);
  });
});
