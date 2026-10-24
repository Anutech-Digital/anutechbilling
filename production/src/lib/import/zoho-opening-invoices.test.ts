/**
 * R-1739 — reading a Zoho Books invoice export. The owner's examples (card R-1739):
 *   1. Zoho INV-000245, T-ABC Pvt Ltd (GSTIN 07…), Total ₹59,000, Balance ₹20,000, due
 *      15 Sep 2026 → imported for ₹20,000, matched by GSTIN.
 *   2. The same CSV again → "INV-000245 already imported", skipped.
 * Zoho writes one row per LINE ITEM, so INV-000245's two item rows must become one invoice.
 */
import { describe, expect, it } from "vitest";
import {
  SAMPLE_ZOHO_INVOICE_CSV, buildPreview, parseCsvText, parsePlaceOfSupply, parseZohoAmount, parseZohoDate,
  readZohoInvoiceCsv, toImportRpcRows,
} from "./zoho-opening-invoices";

const CUSTOMERS = [
  { id: "c-abc", name: "T-ABC Private Limited", gstin: "07AAACT1234A1Z3" },
  { id: "c-bharat", name: "T-Bharat Traders", gstin: null },
];

describe("readZohoInvoiceCsv", () => {
  it("merges an invoice's line-item rows and reads Zoho's columns by name", () => {
    const r = readZohoInvoiceCsv(SAMPLE_ZOHO_INVOICE_CSV);
    expect(r.missingColumns).toEqual([]);
    expect(r.rowCount).toBe(5);
    expect(r.invoices.map((i) => i.number)).toEqual(["INV-000245", "INV-000246", "INV-000240", "INV-000250"]);
    const inv = r.invoices[0];
    expect(inv).toMatchObject({
      invoiceDate: "2026-08-16", dueDate: "2026-09-15", customerName: "T-ABC Pvt Ltd", gstin: "07AAACT1234A1Z3",
      placeOfSupply: "07", total: 59000, balance: 20000, status: "Overdue", currency: "INR", lines: [2, 3], conflict: null,
    });
    // a quoted item name with a comma does not shift the columns
    expect(r.invoices[1]).toMatchObject({ total: 11800, balance: 11800, placeOfSupply: "27" });
  });

  it("names the missing required columns instead of guessing", () => {
    const r = readZohoInvoiceCsv("Invoice Number,Customer Name\nINV-1,T-X\n");
    expect(r.missingColumns).toEqual(["Invoice Date", "Total", "Balance"]);
    expect(r.invoices).toEqual([]);
  });

  it("tolerates header case / punctuation variants and day-first dates", () => {
    const r = readZohoInvoiceCsv("invoice number,INVOICE DATE,due date,customer name,gstin,total,balance due\nINV-9,16/08/2026,15 Sep 2026,T-ABC Pvt Ltd,,\"59,000.00\",\"20,000.00\"\n");
    expect(r.invoices[0]).toMatchObject({ number: "INV-9", invoiceDate: "2026-08-16", dueDate: "2026-09-15", total: 59000, balance: 20000 });
  });

  it("flags an invoice whose rows disagree", () => {
    const r = readZohoInvoiceCsv("Invoice Number,Invoice Date,Customer Name,Total,Balance\nINV-1,2026-08-01,T-A,100,100\nINV-1,2026-08-01,T-A,100,50\n");
    expect(r.invoices[0].conflict).toMatch(/different Total or Balance/);
  });
});

describe("buildPreview", () => {
  const read = readZohoInvoiceCsv(SAMPLE_ZOHO_INVOICE_CSV).invoices;

  it("owner example 1: INV-000245 → T-ABC by GSTIN, ₹20,000 due; paid ones left out; unknown customer listed", () => {
    const p = buildPreview(read, CUSTOMERS, new Set());
    const abc = p.rows.find((r) => r.number === "INV-000245")!;
    expect(abc).toMatchObject({ verdict: "import", customerId: "c-abc", matchedBy: "gstin", total: 59000, balance: 20000, dueDate: "2026-09-15" });
    expect(p.rows.find((r) => r.number === "INV-000246")).toMatchObject({ verdict: "import", customerId: "c-bharat", matchedBy: "name" });
    // never silently dropped: the customer we do not have is a row with the reason
    expect(p.rows.find((r) => r.number === "INV-000250")).toMatchObject({ verdict: "no_customer" });
    expect(p.rows.find((r) => r.number === "INV-000250")!.message).toMatch(/T-New Customer LLP" not found/);
    expect(p.rows.some((r) => r.number === "INV-000240")).toBe(false);
    expect(p.counts).toMatchObject({ import: 2, noCustomer: 1, nothingDue: 1, already: 0, problem: 0 });
    expect(p.totalBalance).toBe(31800);
    expect(toImportRpcRows(p.rows)).toEqual([
      { number: "INV-000245", invoice_date: "2026-08-16", due_date: "2026-09-15", customer_id: "c-abc", total: 59000, balance: 20000, currency: "INR", gstin: "07AAACT1234A1Z3", pos_state_code: "07" },
      { number: "INV-000246", invoice_date: "2026-09-01", due_date: "2026-10-01", customer_id: "c-bharat", total: 11800, balance: 11800, currency: "INR", gstin: null, pos_state_code: "27" },
    ]);
  });

  it("owner example 2: the same CSV again says 'INV-000245 already imported'", () => {
    const p = buildPreview(read, CUSTOMERS, new Set(["INV-000245", "INV-000246"]));
    expect(p.rows.find((r) => r.number === "INV-000245")).toMatchObject({ verdict: "already", message: "INV-000245 already imported" });
    expect(p.toImport).toEqual([]);
    expect(p.totalBalance).toBe(0);
  });

  it("refuses a foreign-currency invoice and Balance above Total; rounds paise with a note", () => {
    const r = readZohoInvoiceCsv([
      "Invoice Number,Invoice Date,Customer Name,Total,Balance,Currency Code",
      "INV-USD,2026-08-01,T-Bharat Traders,100,100,USD",
      "INV-BAD,2026-08-01,T-Bharat Traders,100,150,INR",
      "INV-PAISE,2026-08-01,T-Bharat Traders,100.50,40.50,INR",
    ].join("\n"));
    const p = buildPreview(r.invoices, CUSTOMERS, new Set());
    expect(p.rows.find((x) => x.number === "INV-USD")).toMatchObject({ verdict: "problem" });
    expect(p.rows.find((x) => x.number === "INV-BAD")).toMatchObject({ verdict: "problem" });
    const paise = p.rows.find((x) => x.number === "INV-PAISE")!;
    expect(paise).toMatchObject({ verdict: "import", total: 101, balance: 41 });
    expect(paise.notes[0]).toMatch(/Rounded to whole rupees/);
  });

  it("two customers with the same name and no GSTIN is a problem, not a guess", () => {
    const r = readZohoInvoiceCsv("Invoice Number,Invoice Date,Customer Name,Total,Balance\nINV-1,2026-08-01,T-Twin,100,100\n");
    const p = buildPreview(r.invoices, [{ id: "a", name: "T-Twin", gstin: null }, { id: "b", name: "t-twin", gstin: null }], new Set());
    expect(p.rows[0].verdict).toBe("problem");
    expect(p.rows[0].message).toMatch(/2 customers are named/);
  });
});

describe("cell readers", () => {
  it("dates, amounts and place of supply", () => {
    expect(parseZohoDate("2026-09-15")).toBe("2026-09-15");
    expect(parseZohoDate("15-09-2026")).toBe("2026-09-15");
    expect(parseZohoDate("Sep 15, 2026")).toBe("2026-09-15");
    expect(parseZohoDate("31/02/2026")).toBeNull();
    expect(parseZohoAmount("₹1,18,000.50")).toBe(118000.5);
    expect(parseZohoAmount("abc")).toBeNull();
    expect(parsePlaceOfSupply("DL")).toBe("07");
    expect(parsePlaceOfSupply("Maharashtra (27)")).toBe("27");
    expect(parsePlaceOfSupply("Karnataka")).toBe("29");
    expect(parsePlaceOfSupply("")).toBeNull();
    expect(parseCsvText('a,"b\nc",d\n1,2,3\n')).toEqual([["a", "b\nc", "d"], ["1", "2", "3"]]);
  });
});
