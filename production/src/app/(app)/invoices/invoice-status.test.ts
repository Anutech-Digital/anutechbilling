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

describe("invoice page wiring (R-238)", () => {
  const detail = readFileSync(join(process.cwd(), "src/app/(app)/invoices/invoice-detail.tsx"), "utf8");
  const list = readFileSync(join(process.cwd(), "src/app/(app)/invoices/page.tsx"), "utf8");

  it("the page header badge uses the shared label, not the raw status", () => {
    expect(detail).toMatch(/invoiceStatusBadge\(invoice\)/);
    expect(detail).not.toMatch(/\{invoice\.status\}\s*<\/Badge>/);
  });

  it("the list uses the same function, so the two cannot drift", () => {
    expect(list).toMatch(/invoiceStatusBadge\(inv\)/);
  });

  it("an empty receipts panel offers Record payment on the page", () => {
    expect(detail).toMatch(/onRecordPayment=\{/);
    expect(detail).toMatch(/onRecordPayment && \(/);
  });
});
