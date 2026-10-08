import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  toTurnoverBracket, turnoverFromRow, isMissingTurnoverColumn, einvoiceRequired, irnDeadlineApplies,
  issueEinvoiceNotice, invoiceEinvoiceNotice, invoiceAgeDays, irnAgeingInvoices, irnAgeingNotice,
} from "./einvoice";

/**
 * R-337: AATO > ₹5 Cr → B2B invoices need an e-invoice IRN; ₹10 Cr+ → within 30 days.
 * The app did not know the turnover at all. Warnings only — no block, no tax change.
 */

const NOW = new Date("2026-10-07T10:00:00Z");

describe("turnover read — column na ho to aaj jaisa", () => {
  it("missing column (42703 / PGRST204) = not sure, no error", () => {
    expect(turnoverFromRow(null, { code: "42703", message: "column tenants.aggregate_turnover does not exist" }))
      .toEqual({ bracket: null, columnMissing: true });
    expect(isMissingTurnoverColumn({ code: "PGRST204" })).toBe(true);
    expect(isMissingTurnoverColumn({ message: "Could not find the 'aggregate_turnover' column" })).toBe(true);
  });
  it("any other error is thrown", () => {
    expect(() => turnoverFromRow(null, { code: "42501", message: "permission denied" })).toThrow(/permission/);
  });
  it("null / junk value = not sure", () => {
    expect(turnoverFromRow({ aggregate_turnover: null }, null).bracket).toBeNull();
    expect(toTurnoverBracket("50cr")).toBeNull();
    expect(turnoverFromRow({ aggregate_turnover: "10cr_plus" }, null)).toEqual({ bracket: "10cr_plus", columnMissing: false });
  });
  it("rules per bracket", () => {
    expect(einvoiceRequired(null)).toBe(false);
    expect(einvoiceRequired("up_to_5cr")).toBe(false);
    expect(einvoiceRequired("5_to_10cr")).toBe(true);
    expect(einvoiceRequired("10cr_plus")).toBe(true);
    expect(irnDeadlineApplies("5_to_10cr")).toBe(false);
    expect(irnDeadlineApplies("10cr_plus")).toBe(true);
  });
});

describe("issue dialog banner (>₹5 Cr, GSTIN buyer)", () => {
  it("shows for a B2B invoice over 5 Cr", () => {
    const n = issueEinvoiceNotice("5_to_10cr", 1, 1);
    expect(n?.title).toMatch(/IRN/);
    expect(n?.body).toMatch(/does not generate IRNs yet/);
    expect(n?.body).not.toMatch(/30 days/);
  });
  it("10 Cr+ adds the 30-day limit", () => {
    expect(issueEinvoiceNotice("10cr_plus", 1, 1)?.body).toMatch(/within 30 days/);
  });
  it("bulk names how many are B2B", () => {
    expect(issueEinvoiceNotice("5_to_10cr", 2, 5)?.body).toMatch(/2 of these 5 invoices are B2B/);
  });
  it("silent: no GSTIN, up to 5 Cr, or not sure", () => {
    expect(issueEinvoiceNotice("10cr_plus", 0, 1)).toBeNull();
    expect(issueEinvoiceNotice("up_to_5cr", 1, 1)).toBeNull();
    expect(issueEinvoiceNotice(null, 1, 1)).toBeNull();
  });
  it("ROKTA NAHI: banner text never matches the dialog's blocking regex", () => {
    const blocking = /no amount|nothing can be issued/i;
    for (const b of ["5_to_10cr", "10cr_plus"] as const) {
      const n = issueEinvoiceNotice(b, 3, 3)!;
      expect(blocking.test(n.title) || blocking.test(n.body)).toBe(false);
    }
    // and the dialog renders it apart from `consequences`, which is what `blocked` reads
    const src = readFileSync(join(process.cwd(), "src/components/features/invoices/confirm-issue-dialog.tsx"), "utf8");
    expect(src).toMatch(/<EinvoiceBanner notice=\{einvoiceNotice\}/);
    expect(src).toMatch(/consequences\?\.consequences\.some\(/);
  });
});

describe("invoice page banner (no gst_irn)", () => {
  const base = { customerGstin: "29ABCDE1234F1Z5", gstIrn: null, status: "pending", invoiceDate: "2026-10-01" };
  it("shows for B2B without IRN over 5 Cr", () => {
    expect(invoiceEinvoiceNotice("5_to_10cr", base, NOW)?.title).toMatch(/No e-invoice IRN/);
  });
  it("hidden when IRN present, no GSTIN, void, or not sure", () => {
    expect(invoiceEinvoiceNotice("5_to_10cr", { ...base, gstIrn: "abc123" }, NOW)).toBeNull();
    expect(invoiceEinvoiceNotice("5_to_10cr", { ...base, customerGstin: " " }, NOW)).toBeNull();
    expect(invoiceEinvoiceNotice("5_to_10cr", { ...base, status: "void" }, NOW)).toBeNull();
    expect(invoiceEinvoiceNotice(null, base, NOW)).toBeNull();
  });
  it("10 Cr+ counts the days left / past", () => {
    expect(invoiceEinvoiceNotice("10cr_plus", base, NOW)?.body).toMatch(/24 days left/);
    expect(invoiceEinvoiceNotice("10cr_plus", { ...base, invoiceDate: "2026-08-01" }, NOW)?.body).toMatch(/past the 30-day/);
  });
});

describe("/invoices ageing banner (₹10 Cr+, B2B, >25 days, no IRN)", () => {
  const invs = [
    { id: "A", invoice_date: "2026-09-10", customer_gstin: "29ABCDE1234F1Z5", gst_irn: null, status: "pending" }, // 27d
    { id: "B", invoice_date: "2026-09-01", customer_gstin: "29ABCDE1234F1Z5", gst_irn: null, status: "paid" },    // 36d
    { id: "C", invoice_date: "2026-09-01", customer_gstin: null, gst_irn: null, status: "paid" },                 // B2C
    { id: "D", invoice_date: "2026-09-01", customer_gstin: "29ABCDE1234F1Z5", gst_irn: "irn", status: "paid" },  // has IRN
    { id: "E", invoice_date: "2026-10-01", customer_gstin: "29ABCDE1234F1Z5", gst_irn: null, status: "pending" }, // 6d
    { id: "F", invoice_date: "2026-09-01", customer_gstin: "29ABCDE1234F1Z5", gst_irn: null, status: "void" },
  ];
  it("picks only B2B, no IRN, 25+ days, not void", () => {
    const r = irnAgeingInvoices("10cr_plus", invs, NOW);
    expect(r.ageing.map((i) => i.id)).toEqual(["A", "B"]);
    expect(r.pastLimit).toBe(1);
    const n = irnAgeingNotice(r.ageing.length, r.pastLimit);
    expect(n?.title).toMatch(/2 B2B invoices near the 30-day IRN limit/);
    expect(n?.body).toMatch(/1 is already past 30 days/);
  });
  it("nothing below 10 Cr or when not sure", () => {
    expect(irnAgeingInvoices("5_to_10cr", invs, NOW).ageing).toEqual([]);
    expect(irnAgeingInvoices(null, invs, NOW).ageing).toEqual([]);
    expect(irnAgeingNotice(0, 0)).toBeNull();
  });
  it("age by calendar date", () => {
    expect(invoiceAgeDays("2026-10-07", NOW)).toBe(0);
    expect(invoiceAgeDays("2026-09-12", NOW)).toBe(25);
    expect(invoiceAgeDays("junk", NOW)).toBe(0);
  });
});

describe("migration file — written, never applied by the worker", () => {
  it("adds a nullable checked column, idempotent", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261007060000_tenant_aggregate_turnover.sql"), "utf8");
    expect(sql).toMatch(/add column if not exists aggregate_turnover text/);
    expect(sql).toMatch(/'up_to_5cr', '5_to_10cr', '10cr_plus'/);
  });
});
