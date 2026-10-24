// R-1640 (24 Oct 2026): a button does what its label says. "New invoice" on /invoices sent
// people to the quotes LIST, and the payment toast's "Open invoice" on /subscriptions opened
// the invoices LIST although the invoice number had just come back from generate_invoice.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEW_INVOICE_HREF, raisedInvoiceHref } from "./invoice-href";

const app = join(process.cwd(), "src/app/(app)");
const invoices = readFileSync(join(app, "invoices/page.tsx"), "utf8");
const subs = readFileSync(join(app, "subscriptions/page.tsx"), "utf8");
const palette = readFileSync(join(process.cwd(), "src/components/layout/command-palette.tsx"), "utf8");

describe("New invoice", () => {
  it("opens the direct-invoice builder (the same place Ctrl+K 'Create invoice' goes)", () => {
    expect(NEW_INVOICE_HREF).toBe("/quotes/new?invoice=1");
  });

  it("the header button and the phone FAB both use it — never the quotes list", () => {
    expect(invoices).not.toMatch(/router\.push\(\s*"\/quotes"/);
    const uses = invoices.match(/router\.push\(NEW_INVOICE_HREF/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it("Ctrl+K 'Create invoice' reads the same constant, so the two cannot drift", () => {
    expect(palette).toMatch(/label: "Create invoice"[^\n]*href: NEW_INVOICE_HREF/);
  });
});

describe("toast 'Open invoice' after a subscription payment", () => {
  it("goes to that invoice's own page", () => {
    expect(raisedInvoiceHref("INV-2026-0042")).toBe("/invoices/INV-2026-0042");
    expect(raisedInvoiceHref("ANU/26-27/001")).toBe("/invoices/ANU%2F26-27%2F001");
  });

  it("falls back to the list only when no number came back", () => {
    expect(raisedInvoiceHref(null)).toBe("/invoices");
    expect(raisedInvoiceHref("  ")).toBe("/invoices");
    expect(raisedInvoiceHref(undefined)).toBe("/invoices");
  });

  it("the subscriptions page uses it instead of a bare /invoices push", () => {
    expect(subs).not.toMatch(/label: "Open invoice", onClick: \(\) => router\.push\("\/invoices"/);
    expect(subs).toMatch(/label: "Open invoice", onClick: \(\) => router\.push\(raisedInvoiceHref\(/);
  });
});
