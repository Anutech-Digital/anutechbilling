// R-238: the invoice page showed the stored status ("pending") on an invoice 40 days past its
// due date, while the list beside it said "Overdue 40d". One function now gives both screens
// the same word, and the page offers Record payment even when no receipt exists yet.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invoiceStatusBadge } from "./invoice-status";

const TODAY = "2026-10-06";
const base = { amount: 11800, paid_amount: 0, adjusted_advances: null as unknown[] | null };

describe("invoiceStatusBadge (R-238)", () => {
  it("an unpaid invoice past due reads 'Overdue Nd', not its stored 'pending'", () => {
    expect(invoiceStatusBadge({ ...base, status: "pending", due_date: "2026-08-27" }, TODAY))
      .toEqual({ label: "Overdue 40d", kind: "danger" });
  });

  it("partly paid and late says both", () => {
    expect(invoiceStatusBadge({ ...base, status: "pending", due_date: "2026-10-01", paid_amount: 5000 }, TODAY))
      .toEqual({ label: "Overdue · Partial · 5d", kind: "danger" });
  });

  it("not yet due: Pending, or Partial once money is in", () => {
    expect(invoiceStatusBadge({ ...base, status: "pending", due_date: "2026-10-20" }, TODAY))
      .toEqual({ label: "Pending", kind: "warning" });
    expect(invoiceStatusBadge({ ...base, status: "pending", due_date: null, adjusted_advances: [{}] }, TODAY))
      .toEqual({ label: "Partial", kind: "warning" });
  });

  it("paid, draft and void read as words", () => {
    expect(invoiceStatusBadge({ ...base, status: "paid", due_date: "2026-01-01" }, TODAY)).toEqual({ label: "Paid", kind: "success" });
    expect(invoiceStatusBadge({ ...base, status: "draft", due_date: null }, TODAY)).toEqual({ label: "Draft", kind: "muted" });
    expect(invoiceStatusBadge({ ...base, status: "void", due_date: null }, TODAY)).toEqual({ label: "Void", kind: "muted" });
  });
});

describe("written off (R-1635)", () => {
  const base = { status: "pending", due_date: "2026-09-01", amount: 1180, net_payable: 1180, paid_amount: 0 };
  it("an overdue invoice written off reads 'Written off', not 'Overdue'", () => {
    expect(invoiceStatusBadge(base, "2026-10-23")?.label).toMatch(/^Overdue/);
    expect(invoiceStatusBadge({ ...base, written_off_at: "2026-10-23T06:00:00Z" }, "2026-10-23")).toEqual({ label: "Written off", kind: "muted" });
  });
  it("a paid invoice stays Paid", () => {
    expect(invoiceStatusBadge({ ...base, status: "paid", written_off_at: "2026-10-23T06:00:00Z" }, "2026-10-23")?.label).toBe("Paid");
  });
});

/* R-1709: T-L5 — settled by a credit note, not a rupee came in. */
describe("Credited, from money (R-1709)", () => {
  const tl5 = { status: "paid", due_date: "2026-10-30", amount: 38232, net_payable: 0, paid_amount: 0 };
  it.each([
    ["credit note closed it", tl5, { credit: 38232, debit: 0 }, "Credited"],
    ["notes not read → stays Paid", tl5, undefined, "Paid"],
    ["paid in full, credit note later → Paid", { ...tl5, amount: 100000, net_payable: 90000, paid_amount: 100000 }, { credit: 10000, debit: 0 }, "Paid"],
    ["receipt after the invoice → Partial", { ...tl5, status: "pending", net_payable: 38232, paid_amount: 20000 }, null, "Partial"],
  ] as const)("%s", (_l, inv, notes, label) => {
    expect(invoiceStatusBadge(inv, "2026-10-21", notes)?.label).toBe(label);
  });
});

describe("invoice page wiring (R-238)", () => {
  const detail = readFileSync(join(process.cwd(), "src/app/(app)/invoices/invoice-detail.tsx"), "utf8");
  const list = readFileSync(join(process.cwd(), "src/app/(app)/invoices/page.tsx"), "utf8");

  it("the page header badge uses the shared label, not the raw status — with its credit notes (R-1709)", () => {
    expect(detail).toMatch(/invoiceStatusBadge\(invoice, undefined, invoiceNotes\)/);
    expect(detail).not.toMatch(/\{invoice\.status\}\s*<\/Badge>/);
  });

  it("the list uses the same function with the same note totals, so the two cannot drift", () => {
    expect(list).toMatch(/invoiceStatusBadge\(inv, undefined, notes\)/);
    expect(list).not.toMatch(/invoiceStatusBadge\(inv\)/);
    /* R-1709: chips, tile focus and KPIs read the same note totals as the row badge. */
    expect(list).toMatch(/invoiceChipCounts\(viewInvoices, undefined, noteTotals\)/);
    expect(list).toMatch(/invoiceKpis\(invoices \?\? \[\], undefined, noteTotals\)/);
    expect(list).toMatch(/invoiceChip\(i, undefined, noteTotals\)/);
    expect(list).toMatch(/invoiceInFocus\(i, focus, undefined, noteTotals\)/);
  });

  it("an empty receipts panel offers Record payment on the page", () => {
    expect(detail).toMatch(/onRecordPayment=\{/);
    expect(detail).toMatch(/onRecordPayment && \(/);
  });
});
