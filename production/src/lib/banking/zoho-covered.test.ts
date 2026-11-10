/**
 * R-2657 — Pardeep's D1 (10 Nov): the No-vendor bulk tool skips a money-out line a Zoho-imported
 * expense / COGS bill already covers (it is matched to that document instead, R-2655).
 */
import { describe, it, expect } from "vitest";
import { coveringDoc, importedDocs, loadImportedDocs, type DocsDb } from "./zoho-covered";

const exp = (over: Partial<{ zoho_doc_id: string; amount: number; gst_paid: number; tds_amount: number; expense_date: string; paid_date: string | null }>) => ({
  zoho_doc_id: "expenses:Z1", amount: 1000, gst_paid: 0, tds_amount: 0, expense_date: "2025-09-10", paid_date: "2025-09-10", ...over,
});

describe("importedDocs + coveringDoc", () => {
  it("same amount within 7 days of the expense is covered", () => {
    const docs = importedDocs([exp({})], []);
    expect(coveringDoc({ debit: 1000, txn_date: "2025-09-16" }, docs)?.key).toBe("expenses:Z1");
    expect(coveringDoc({ debit: 1000, txn_date: "2025-09-03" }, docs)?.key).toBe("expenses:Z1");
  });
  it("outside the window or another amount is not covered", () => {
    const docs = importedDocs([exp({})], []);
    expect(coveringDoc({ debit: 1000, txn_date: "2025-09-20" }, docs)).toBeNull();
    expect(coveringDoc({ debit: 1500, txn_date: "2025-09-10" }, docs)).toBeNull();
  });
  it("₹1 rounding still counts as covered", () => {
    expect(coveringDoc({ debit: 1001, txn_date: "2025-09-10" }, importedDocs([exp({})], []))).not.toBeNull();
  });
  it("a document split into legs is matched on its total, with GST and less TDS", () => {
    const docs = importedDocs([
      exp({ amount: 800, gst_paid: 144, tds_amount: 20 }),
      exp({ amount: 200, gst_paid: 36, tds_amount: 0 }),
    ], []);
    expect(docs).toHaveLength(1);
    for (const debit of [1000, 1180, 980, 1160]) expect(coveringDoc({ debit, txn_date: "2025-09-12" }, docs)).not.toBeNull();
  });
  it("the paid date also opens the window (Zoho paid later than the expense date)", () => {
    const docs = importedDocs([exp({ expense_date: "2025-06-01", paid_date: "2025-09-30" })], []);
    expect(coveringDoc({ debit: 1000, txn_date: "2025-10-02" }, docs)).not.toBeNull();
  });
  it("an unpaid COGS bill covers its total or what is still due, up to 120 days after the bill", () => {
    const docs = importedDocs([], [{ zoho_doc_id: "bills:B1", total: 50_000, paid_amount: 20_000, bill_date: "2025-08-01" }]);
    expect(coveringDoc({ debit: 30_000, txn_date: "2025-10-15" }, docs)?.kind).toBe("bill");
    expect(coveringDoc({ debit: 50_000, txn_date: "2025-08-01" }, docs)).not.toBeNull();
    expect(coveringDoc({ debit: 30_000, txn_date: "2026-01-15" }, docs)).toBeNull();
  });
  it("a money-in or zero line is never 'covered'", () => {
    expect(coveringDoc({ debit: 0, txn_date: "2025-09-10" }, importedDocs([exp({ amount: 0 })], []))).toBeNull();
  });
});

describe("loadImportedDocs", () => {
  const fake = (tables: Record<string, unknown[]>, filters: string[] = []): DocsDb => ({
    from: (t: string) => ({
      select: () => {
        const q: Record<string, unknown> = {};
        for (const m of ["not", "is", "gte", "lte", "order"]) q[m] = (...a: unknown[]) => { filters.push(`${t}.${m}:${a.slice(0, 2).join(",")}`); return q; };
        q.range = async () => ({ data: tables[t] ?? [], error: null });
        return q as never;
      },
    }),
  });

  it("reads only imported, not-yet-banked expenses and skips paid / void bills", async () => {
    const filters: string[] = [];
    const docs = await loadImportedDocs(fake({
      expenses: [exp({})],
      vendor_bills: [
        { zoho_doc_id: "bills:paid", total: 10, paid_amount: 10, bill_date: "2025-09-01", status: "paid" },
        { zoho_doc_id: "bills:void", total: 10, paid_amount: 0, bill_date: "2025-09-01", status: "void" },
        { zoho_doc_id: "bills:open", total: 10, paid_amount: 0, bill_date: "2025-09-01", status: "unpaid" },
      ],
    }, filters), "2025-09-10", "2025-09-12");
    expect(docs.map((d) => d.key)).toEqual(["expenses:Z1", "bills:open"]);
    expect(filters).toContain("expenses.is:reconciled_txn_id,");
    expect(filters).toContain("expenses.not:zoho_doc_id,is");
  });

  it("a read error throws (the caller then books nothing)", async () => {
    const db: DocsDb = { from: () => ({ select: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["not", "is", "gte", "lte", "order"]) q[m] = () => q;
      q.range = async () => ({ data: null, error: { message: "denied" } });
      return q as never;
    } }) };
    await expect(loadImportedDocs(db, "2025-09-10", "2025-09-12")).rejects.toThrow(/denied/);
  });
});
