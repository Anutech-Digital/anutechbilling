import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invoicePaidInFull, lineDomainNote } from "./invoice-display";

const adv = (amount: number, received_at = "2026-10-03T04:48:12.918Z") =>
  ({ payment_id: "p1", voucher_no: "RV-1", amount, received_at, method: "razorpay" as const });

describe("lineDomainNote — the line says which website it is for", () => {
  it("a hosting line with a domain", () => {
    expect(lineDomainNote({ name: "Starter hosting (billed yearly)", domain: "Rospaid714304.anutech.in" })).toBe("For rospaid714304.anutech.in");
  });
  it("nothing when there is no domain", () => {
    expect(lineDomainNote({ name: "Google Workspace Business Starter" })).toBeNull();
    expect(lineDomainNote({ name: "x", domain: "  " })).toBeNull();
  });
  it("nothing when the name or detail already shows it (a domain registration line)", () => {
    expect(lineDomainNote({ name: "Domain registration — acme.in", domain: "acme.in" })).toBeNull();
    expect(lineDomainNote({ name: "Hosting", description: "for ACME.in", domain: "acme.in" })).toBeNull();
  });
  it("nothing on a bulk line, which lists its own domains", () => {
    expect(lineDomainNote({ name: "Workspace", domain: "acme.in", bulk: true })).toBeNull();
  });
});

describe("invoicePaidInFull — a settled invoice reads as paid", () => {
  it("paid at checkout: advances cover the total, nothing payable → paid on the advance date", () => {
    expect(invoicePaidInFull({ status: "paid", net_payable: 0, adjusted_advances: [adv(708)] }, 708)).toEqual({ paidOn: "2026-10-03T04:48:12.918Z" });
  });
  it("the invoice's own paid_date wins", () => {
    expect(invoicePaidInFull({ status: "paid", paid_date: "2026-10-05", net_payable: 0, adjusted_advances: [adv(708)] }, 708)).toEqual({ paidOn: "2026-10-05" });
  });
  it("advances cover it even before the status is updated", () => {
    expect(invoicePaidInFull({ status: "pending", adjusted_advances: [adv(500), adv(208, "2026-10-04T00:00:00Z")] }, 708)).toEqual({ paidOn: "2026-10-04T00:00:00Z" });
  });
  it("marked paid with no record of when → paid, date unknown", () => {
    expect(invoicePaidInFull({ status: "paid", net_payable: 0 }, 708)).toEqual({ paidOn: null });
  });
  it("still owed → null, so the due date stays", () => {
    expect(invoicePaidInFull({ status: "pending", net_payable: 708 }, 708)).toBeNull();
    expect(invoicePaidInFull({ status: "pending", adjusted_advances: [adv(300)] }, 708)).toBeNull();
    expect(invoicePaidInFull({ status: "paid", net_payable: 100 }, 708)).toBeNull();
    expect(invoicePaidInFull({ status: "pending" }, 708)).toBeNull();
  });
});

describe("wired into the documents", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("the invoice PDF prints the domain note and the paid line", () => {
    const src = read("src/lib/pdf/InvoicePDF.tsx");
    expect(src).toContain("lineDomainNote(li)");
    expect(src).toContain("invoicePaidInFull(");
    expect(src).toMatch(/Paid on/);
    expect(src).toMatch(/Paid in full/);
  });
  it("the quote PDF prints the domain note too", () => {
    expect(read("src/lib/pdf/QuotePDF.tsx")).toContain("lineDomainNote(");
  });
  /* The on-screen tax-invoice preview (components/features/quotes/tax-invoice-dialog.tsx) is in
     the Billing & Subscriptions section reserved for a colleague (AGENTS.md §13), so it is left
     unchanged; it can adopt these two helpers when its owner chooses. */
});
