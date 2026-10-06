import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { invoiceByLead, invoiceHref } from "./invoice-links";

describe("R-083 invoiceByLead", () => {
  it("maps each lead to its invoiced quote's invoice", () => {
    const m = invoiceByLead([
      { lead_id: "L-1", invoice_id: "INV-ADPL-2026-27-0031", created_at: "2026-10-01T10:00:00Z" },
      { lead_id: "L-2", invoice_id: null, created_at: "2026-10-01T10:00:00Z" },
      { lead_id: null, invoice_id: "INV-X", created_at: "2026-10-01T10:00:00Z" },
    ]);
    expect(m.get("L-1")).toBe("INV-ADPL-2026-27-0031");
    expect(m.has("L-2")).toBe(false);
    expect(m.size).toBe(1);
  });

  it("picks the newest invoiced quote when a lead has two", () => {
    const m = invoiceByLead([
      { lead_id: "L-1", invoice_id: "INV-OLD", created_at: "2026-09-01T10:00:00Z" },
      { lead_id: "L-1", invoice_id: "INV-NEW", created_at: "2026-10-01T10:00:00Z" },
      { lead_id: "L-1", invoice_id: "INV-MID", created_at: "2026-09-15T10:00:00Z" },
    ]);
    expect(m.get("L-1")).toBe("INV-NEW");
  });

  it("links to the single-invoice view used everywhere else", () => {
    expect(invoiceHref("INV-ADPL-2026-27-0031")).toBe("/invoices/INV-ADPL-2026-27-0031");
    // R-218: an id with "/" from a custom series stays one path segment.
    expect(invoiceHref("ANU/26-27/001")).toBe("/invoices/ANU%2F26-27%2F001");
  });
});

describe("R-083 Online Orders page wiring", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "page.tsx"), "utf8");

  it("reads the invoice off the order's quote, not a hard-coded null", () => {
    expect(src).not.toMatch(/invoiceNo:\s*null/);
    expect(src).toMatch(/from\("quotes"\)[\s\S]{0,200}invoice_id/);
  });

  it("the Invoice button opens the invoice instead of a fake 'Downloading' toast", () => {
    expect(src).not.toMatch(/Downloading invoice PDF/);
    expect(src).toMatch(/invoiceHref\(/);
  });
});
