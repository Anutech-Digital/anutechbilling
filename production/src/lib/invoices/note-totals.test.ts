/**
 * R-009 — note totals for the invoices list. Pure arithmetic, plus a source scan that
 * the list reads them through ONE tenant-wide query, not one per row.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { noteTotalsByInvoice, netAfterNotes, roundRupees } from "./note-totals";

describe("noteTotalsByInvoice", () => {
  it("credit note only", () => {
    const m = noteTotalsByInvoice([{ invoice_id: "INV-1", amount: 1180 }], []);
    expect(m.get("INV-1")).toEqual({ credit: 1180, debit: 0 });
    expect(netAfterNotes(11800, m.get("INV-1"))).toBe(10620);
  });

  it("debit note only", () => {
    const m = noteTotalsByInvoice([], [{ invoice_id: "INV-2", amount: 50000 }]);
    expect(m.get("INV-2")).toEqual({ credit: 0, debit: 50000 });
    expect(netAfterNotes(540000, m.get("INV-2"))).toBe(590000);
  });

  it("both, and several of each, on one invoice", () => {
    const m = noteTotalsByInvoice(
      [{ invoice_id: "INV-3", amount: 100 }, { invoice_id: "INV-3", amount: 250 }],
      [{ invoice_id: "INV-3", amount: 40 }],
    );
    expect(m.get("INV-3")).toEqual({ credit: 350, debit: 40 });
    expect(netAfterNotes(1000, m.get("INV-3"))).toBe(690);
  });

  it("keeps invoices apart and leaves invoices without notes out", () => {
    const m = noteTotalsByInvoice([{ invoice_id: "A", amount: 10 }], [{ invoice_id: "B", amount: 20 }]);
    expect(m.get("A")).toEqual({ credit: 10, debit: 0 });
    expect(m.get("B")).toEqual({ credit: 0, debit: 20 });
    expect(m.has("C")).toBe(false);
    expect(netAfterNotes(500, m.get("C"))).toBe(500);
  });

  it("ignores void / cancelled notes if a status is present", () => {
    const m = noteTotalsByInvoice(
      [{ invoice_id: "INV-4", amount: 100, status: "void" }, { invoice_id: "INV-4", amount: 30, status: "issued" }],
      [{ invoice_id: "INV-4", amount: 999, status: "Cancelled" }],
    );
    expect(m.get("INV-4")).toEqual({ credit: 30, debit: 0 });
  });

  it("an invoice whose only notes are void has no entry", () => {
    const m = noteTotalsByInvoice([{ invoice_id: "INV-5", amount: 100, status: "void" }], []);
    expect(m.has("INV-5")).toBe(false);
  });

  it("skips rows without an invoice id or amount, and reads numeric strings", () => {
    const m = noteTotalsByInvoice(
      [{ invoice_id: null, amount: 5 }, { invoice_id: "X", amount: null }, { invoice_id: "Y", amount: "12.50" }],
      [],
    );
    expect(m.has("X")).toBe(false);
    expect(m.get("Y")).toEqual({ credit: 12.5, debit: 0 });
  });

  it("sums to the paisa without float drift", () => {
    const m = noteTotalsByInvoice(
      [{ invoice_id: "F", amount: 0.1 }, { invoice_id: "F", amount: 0.2 }],
      [{ invoice_id: "F", amount: 0.105 }],
    );
    expect(m.get("F")!.credit).toBe(0.3);
    expect(m.get("F")!.debit).toBe(0.11);
    expect(netAfterNotes(1.1, m.get("F"))).toBe(0.91);
  });
});

describe("netAfterNotes", () => {
  it("never goes below zero", () => {
    expect(netAfterNotes(100, { credit: 150, debit: 0 })).toBe(0);
  });
  it("treats a missing amount as zero", () => {
    expect(netAfterNotes(null, { credit: 0, debit: 25 })).toBe(25);
  });
  it("rounds to 2 places", () => {
    expect(netAfterNotes(10.005, null)).toBe(10.01);
    expect(roundRupees(0.1 + 0.2)).toBe(0.3);
  });
});

describe("invoices list wiring", () => {
  const page = readFileSync("src/app/(app)/invoices/page.tsx", "utf8");
  it("reads note totals once for the list, not per-invoice hooks inside rows", () => {
    expect(page).toMatch(/useInvoiceNoteTotals\(\)/);
    // The per-invoice hooks are only for the expanded notes list, which R-086 moved into
    // invoice-detail.tsx (the list imports InvoiceNotesList from there).
    expect(page).not.toMatch(/useCreditNotesByInvoice\(/);
    const detail = readFileSync("src/app/(app)/invoices/invoice-detail.tsx", "utf8");
    expect(detail.match(/useCreditNotesByInvoice\(/g)?.length).toBe(1);
  });
});
