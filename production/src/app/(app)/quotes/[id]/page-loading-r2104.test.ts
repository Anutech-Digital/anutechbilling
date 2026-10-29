/**
 * R-2104 — the quote page waited for the quote only. Until the subscriptions (and the parts'
 * invoices) came, a paid split-billed quote said "No invoice yet" and showed the red
 * "Re-create subscription from quote" banner: no subscription read yet looked like a missing one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), "src/app/(app)/quotes/[id]");
const page = readFileSync(path.join(dir, "page.tsx"), "utf8");
const parts = readFileSync(path.join(dir, "part-invoices.ts"), "utf8");

describe("quote page waits for its subscriptions (R-2104)", () => {
  it("the loading skeleton stays until the quote, its subscriptions and the parts' invoices are read", () => {
    expect(page).toMatch(/const \{ data: allSubs, isLoading: subsLoading \} = useQuoteSubscriptions\(/);
    expect(page).toMatch(/isLoading: partInvoicesLoading \} = useQuotePartInvoices\(/);
    expect(page).toMatch(/if \(isLoading \|\| subsLoading \|\| partInvoicesLoading\) \{/);
  });

  it("closing Record payment re-reads the parts' invoices — INVOICED ticks without a reload (localhost check, 29 Oct)", () => {
    expect(page).toMatch(/if \(!o\) void qc\.invalidateQueries\(\{ queryKey: \["quote-part-invoices"\] \}\);/);
  });

  it("only the FIRST read of the parts' invoices waits — a refetch keeps the last answer (no skeleton under an open sheet)", () => {
    expect(parts).toMatch(/placeholderData: \(prev[^)]*\) => prev/);
  });
});
