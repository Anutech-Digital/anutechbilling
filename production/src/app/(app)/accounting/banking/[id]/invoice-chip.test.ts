/**
 * R-399: the bank transaction list shows "Matches INV-…" on unmatched credit rows with a
 * certain open-invoice match (lib/banking/invoice-credit-match.ts certainInvoiceMatches —
 * tested there), and the chip opens the SAME reconcile drawer as the Reconcile button.
 * Pinned here so the wiring (row + phone card, write-only, drawer handler) cannot drift.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const page = readFileSync(join(__dirname, "page.tsx"), "utf8");
const chip = readFileSync(join(__dirname, "..", "..", "..", "..", "..", "components", "features", "banking", "invoice-match-chip.tsx"), "utf8");

describe("bank list invoice-match chip (R-399)", () => {
  it("uses the R-109 matcher through certainInvoiceMatches, fetched only for writers with an unmatched credit", () => {
    expect(page).toMatch(/certainInvoiceMatches\(transactions \?\? \[\], openInvoices \?\? \[\]\)/);
    expect(page).toMatch(/useOpenInvoicesForCreditMatch\(canWrite && hasUnmatchedCredit\)/);
  });

  it("is on both the desktop row and the phone card, and only for someone who can reconcile", () => {
    const passes = page.match(/invoiceMatch=\{canWrite \? invoiceChips\.get\(txn\.id\) : undefined\}/g) ?? [];
    expect(passes).toHaveLength(2);
    const renders = page.match(/<InvoiceMatchChip match=\{invoiceMatch\} onOpen=\{onReconcile\} \/>/g) ?? [];
    expect(renders).toHaveLength(2);
  });

  it("the chip only points — it opens the drawer and never records a payment itself", () => {
    expect(chip).toMatch(/onClick=\{onOpen\}/);
    expect(chip).not.toMatch(/useMatchCreditToInvoice|mutate/);
    expect(chip).toMatch(/Matches <span className="font-mono">\{match\.invoiceId\}<\/span>/);
  });
});
