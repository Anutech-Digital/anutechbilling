// R-2324 — "Import bills" on the Bills page. Owner's real case first (R-2319, staging 31 Oct):
// one distributor payment covers 40–54 COGS bills; typing each one by hand is not practical.
// All names / GSTINs below are made up (T- names, checksum-valid fake GSTINs).
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  SAMPLE_BILL_CSV, buildBillImportPreview, readBillCsv, toVendorBillInserts, type ExistingBillKey, type VendorLite,
} from "./bill-import";

const OWN = "07"; // our company is in Delhi
const DIST_GSTIN = "27AAACT1111A1Z9"; // T-Distributor, Maharashtra → IGST
const LOCAL_GSTIN = "07AAACT2222B1Z3"; // T-Local Supplies, Delhi → CGST + SGST

const vendors: VendorLite[] = [
  { id: "v-dist", name: "T-Distributor Pvt Ltd", gstin: DIST_GSTIN, default_category: "COGS-M365" },
  { id: "v-local", name: "T-Local Supplies", gstin: LOCAL_GSTIN, default_category: "Office Supplies" },
  { id: "v-twin1", name: "T-Twin Traders", gstin: null, default_category: null },
  { id: "v-twin2", name: "T-Twin Traders", gstin: null, default_category: null },
  // the local E2E Test Co fixture vendor the sample file is written for (made-up)
  { id: "v-mehta", name: "Mehta Cloud Distributors", gstin: null, default_category: "COGS-Workspace" },
];

const preview = (csv: string, existing: ExistingBillKey[] = [], own: string | null = OWN) =>
  buildBillImportPreview(readBillCsv(csv).bills, vendors, existing, own);

describe("readBillCsv — Zoho Books bill export (one row per line item)", () => {
  const zoho = [
    "Bill Date,Due Date,Bill ID,Vendor Name,Bill Number,Currency Code,SubTotal,Total,Balance,Bill Status,GST Identification Number (GSTIN),Source of Supply,Destination of Supply,Item Name,Item Total,CGST,SGST,IGST",
    `31/08/2026,30/09/2026,9001,T-Distributor Pvt Ltd,RD-1001,INR,"1,00,000.00","1,18,000.00",118000.00,Open,${DIST_GSTIN},MH,DL,Microsoft 365 Business Basic,60000.00,0,0,10800.00`,
    `31/08/2026,30/09/2026,9001,T-Distributor Pvt Ltd,RD-1001,INR,"1,00,000.00","1,18,000.00",118000.00,Open,${DIST_GSTIN},MH,DL,Microsoft 365 E3,40000.00,0,0,7200.00`,
    `01/09/2026,01/10/2026,9002,T-Distributor Pvt Ltd,RD-1002,INR,50000.00,59000.00,59000.00,Overdue,${DIST_GSTIN},MH,DL,Google Workspace,50000.00,0,0,9000.00`,
    `02/09/2026,,9003,T-Distributor Pvt Ltd,RD-1003,INR,1000.00,1180.00,1180.00,Void,${DIST_GSTIN},MH,DL,Old item,1000.00,0,0,180.00`,
  ].join("\n");

  it("merges a bill's line rows: SubTotal once, GST heads summed", () => {
    const r = readBillCsv(zoho);
    expect(r.missingColumns).toEqual([]);
    expect(r.lineItems).toBe(true);
    expect(r.bills.map((b) => b.billNo)).toEqual(["RD-1001", "RD-1002", "RD-1003"]);
    const b = r.bills[0];
    expect(b.lines).toEqual([2, 3]);
    expect(b.taxable).toBe(100000);
    expect(b.igst).toBe(18000);
    expect(b.billDate).toBe("2026-08-31");
    expect(b.dueDate).toBe("2026-09-30");
  });

  it("preview: two bills to import with IGST, the void one skipped", () => {
    const p = preview(zoho);
    expect(p.counts).toMatchObject({ import: 2, skipped: 1, already: 0, noVendor: 0, problem: 0 });
    const [b1, b2] = p.toImport;
    expect(b1).toMatchObject({ vendorId: "v-dist", matchedBy: "gstin", taxable: 100000, cgst: 0, sgst: 0, igst: 18000, total: 118000 });
    expect(b2).toMatchObject({ billNo: "RD-1002", total: 59000, igst: 9000 });
    expect(p.totalAmount).toBe(177000);
  });
});

describe("readBillCsv — simple template (one row per bill)", () => {
  const tpl = [
    "Vendor Name,Vendor GSTIN,Bill Number,Bill Date,Taxable Value,GST,Category",
    `T-Local Supplies,${LOCAL_GSTIN},LS-77,2026-09-10,10000,1800,`,
    `T-Distributor Pvt Ltd,${DIST_GSTIN},RD-2001,2026-09-11,20000,3600,COGS-Workspace`,
  ].join("\n");

  it("a GST total is split by state: same state → CGST + SGST, other state → IGST", () => {
    const p = preview(tpl);
    expect(p.counts.import).toBe(2);
    expect(p.toImport[0]).toMatchObject({ billNo: "LS-77", cgst: 900, sgst: 900, igst: 0, total: 11800 });
    expect(p.toImport[1]).toMatchObject({ billNo: "RD-2001", cgst: 0, sgst: 0, igst: 3600, total: 23600 });
  });

  it("category: the file's, else the vendor's COGS head, else COGS-Other", () => {
    const p = preview(tpl);
    expect(p.toImport[0].category).toBe("COGS-Other"); // vendor's default is an expense head, not COGS
    expect(p.toImport[1].category).toBe("COGS-Workspace");
    const p2 = preview(tpl.replace(",COGS-Workspace", ","));
    expect(p2.toImport[1].category).toBe("COGS-M365");
  });

  it("same bill twice in a template file is a problem, not added twice", () => {
    const twice = tpl + `\nT-Local Supplies,${LOCAL_GSTIN},LS-77,2026-09-10,10000,1800,`;
    const p = preview(twice);
    const row = p.rows.find((r) => r.billNo === "LS-77")!;
    expect(row.verdict).toBe("problem");
    expect(row.message).toMatch(/twice/);
  });

  it("no way to tell CGST/SGST from IGST → a row problem, not a guess", () => {
    const p = preview(["Vendor Name,Bill Number,Bill Date,Taxable Value,GST", "T-Twin Traders,TT-1,2026-09-01,1000,180"].join("\n"), [], null);
    expect(p.rows[0].verdict).toBe("problem");
  });

  it("CGST / SGST / IGST columns are taken as written", () => {
    const p = preview(["Vendor Name,Bill Number,Bill Date,Taxable Value,CGST,SGST,IGST", "T-Local Supplies,LS-80,2026-09-12,5000,450,450,0"].join("\n"));
    expect(p.toImport[0]).toMatchObject({ cgst: 450, sgst: 450, igst: 0, total: 5900, matchedBy: "name" });
  });

  it("only Total given → GST = Total − taxable", () => {
    const p = preview(["Vendor Name,Bill Number,Bill Date,Taxable Value,Total", "T-Local Supplies,LS-81,2026-09-12,5000,5900"].join("\n"));
    expect(p.toImport[0]).toMatchObject({ cgst: 450, sgst: 450, total: 5900 });
  });
});

describe("vendor match and duplicates", () => {
  const head = "Vendor Name,GSTIN,Bill Number,Bill Date,Taxable Value,IGST";
  it("GSTIN wins over a different name", () => {
    const p = preview([head, `T-Distributor (Mumbai branch),${DIST_GSTIN},RD-9,2026-09-01,100,18`].join("\n"));
    expect(p.toImport[0]).toMatchObject({ vendorId: "v-dist", vendorName: "T-Distributor Pvt Ltd", matchedBy: "gstin" });
  });
  it("unknown vendor → row error, never auto-created", () => {
    const p = preview([head, "T-Brand New Vendor,,NB-1,2026-09-01,100,18"].join("\n"));
    expect(p.rows[0].verdict).toBe("no_vendor");
    expect(p.rows[0].message).toMatch(/Vendors/);
    expect(p.toImport).toEqual([]);
  });
  it("two vendors with the same name → asks for the GSTIN", () => {
    const p = preview([head, "T-Twin Traders,,TT-2,2026-09-01,100,18"].join("\n"));
    expect(p.rows[0].verdict).toBe("problem");
    expect(p.rows[0].message).toMatch(/GSTIN/);
  });
  it("same vendor + bill number already in the books → skipped and listed", () => {
    const existing: ExistingBillKey[] = [{ vendor_id: "v-dist", vendor_name: "T-Distributor Pvt Ltd", bill_no: "rd-9" }];
    const p = preview([head, `T-Distributor Pvt Ltd,${DIST_GSTIN},RD-9,2026-09-01,100,18`, `T-Distributor Pvt Ltd,${DIST_GSTIN},RD-10,2026-09-02,100,18`].join("\n"), existing);
    expect(p.counts).toMatchObject({ already: 1, import: 1 });
    expect(p.rows.find((r) => r.billNo === "RD-9")).toMatchObject({ verdict: "already" });
  });
  it("an older bill saved without vendor_id still counts as a duplicate by name", () => {
    const existing: ExistingBillKey[] = [{ vendor_id: null, vendor_name: "t-distributor pvt ltd", bill_no: "RD-9" }];
    const p = preview([head, `T-Distributor Pvt Ltd,${DIST_GSTIN},RD-9,2026-09-01,100,18`].join("\n"), existing);
    expect(p.rows[0].verdict).toBe("already");
  });
  it("same bill number from a DIFFERENT vendor is not a duplicate", () => {
    const existing: ExistingBillKey[] = [{ vendor_id: "v-local", vendor_name: "T-Local Supplies", bill_no: "RD-9" }];
    const p = preview([head, `T-Distributor Pvt Ltd,${DIST_GSTIN},RD-9,2026-09-01,100,18`].join("\n"), existing);
    expect(p.rows[0].verdict).toBe("import");
  });
});

describe("row problems are listed, never dropped", () => {
  const head = "Vendor Name,Bill Number,Bill Date,Taxable Value,IGST,Currency Code";
  it.each([
    ["bad date", "T-Distributor Pvt Ltd,X-1,31/31/2026,100,18,INR", /date/i],
    ["foreign currency", "T-Distributor Pvt Ltd,X-2,2026-09-01,100,18,USD", /USD/],
    ["empty taxable", "T-Distributor Pvt Ltd,X-3,2026-09-01,,18,INR", /taxable/i],
    ["negative GST", "T-Distributor Pvt Ltd,X-4,2026-09-01,100,-18,INR", /negative/i],
  ])("%s", (_name, line, msg) => {
    const p = preview([head, line].join("\n"));
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].verdict).toBe("problem");
    expect(p.rows[0].message).toMatch(msg);
  });
  it("a row with no bill number is listed as a problem", () => {
    const p = preview([head, "T-Distributor Pvt Ltd,,2026-09-01,100,18,INR"].join("\n"));
    expect(p.rows[0]).toMatchObject({ verdict: "problem" });
    expect(p.rows[0].message).toMatch(/bill number/i);
  });
  it("missing required columns are named", () => {
    expect(readBillCsv("Vendor Name,Amount\nT-X,100").missingColumns).toEqual(["Bill Number", "Bill Date", "Taxable Value (or SubTotal)"]);
  });
  it("paise are rounded to whole rupees with a note", () => {
    const p = preview(["Vendor Name,Bill Number,Bill Date,Taxable Value,IGST", "T-Distributor Pvt Ltd,R-1,2026-09-01,100.40,18.07"].join("\n"));
    expect(p.toImport[0]).toMatchObject({ taxable: 100, igst: 18, total: 118 });
    expect(p.toImport[0].notes.join(" ")).toMatch(/whole rupees/);
  });
});

describe("toVendorBillInserts — the same row Add Bill writes", () => {
  it("unpaid INR tax invoice, vendor linked, ids unique in one batch, file named in notes", () => {
    const csv = ["Vendor Name,Bill Number,Bill Date,Due Date,Taxable Value,IGST",
      ...Array.from({ length: 54 }, (_, i) => `T-Distributor Pvt Ltd,RD-${3000 + i},2026-09-01,2026-10-01,1000,180`)].join("\n");
    const p = preview(csv);
    expect(p.counts.import).toBe(54);
    const rows = toVendorBillInserts(p.toImport, { fileName: "bills.csv", stamp: "MHF0ABC" });
    expect(rows).toHaveLength(54);
    expect(new Set(rows.map((r) => r.id)).size).toBe(54);
    expect(rows[0]).toEqual({
      id: rows[0].id,
      vendor_id: "v-dist",
      vendor_name: "T-Distributor Pvt Ltd",
      vendor_gstin: DIST_GSTIN,
      bill_no: "RD-3000",
      bill_date: "2026-09-01",
      due_date: "2026-10-01",
      category: "COGS-M365",
      currency: "INR",
      fx_rate: 1,
      subtotal: 1000,
      cgst: 0,
      sgst: 0,
      igst: 180,
      total: 1180,
      notes: "Imported from bills.csv.",
      status: "unpaid",
      document_type: "tax_invoice",
      line_items: [],
      attachment_url: null,
    });
    expect(rows[0].id).toMatch(/^BILL-MHF0ABC-/);
  });
});

describe("the sample file shipped for owners (docs/samples/bill-import-sample.csv)", () => {
  it("is the same as the in-app sample and previews cleanly against its made-up vendors", () => {
    const file = fs.readFileSync(path.join(__dirname, "../../../docs/samples/bill-import-sample.csv"), "utf8");
    expect(file.replace(/\r\n/g, "\n")).toBe(SAMPLE_BILL_CSV);
    const p = preview(SAMPLE_BILL_CSV);
    expect(p.counts).toMatchObject({ import: 3, noVendor: 1, problem: 0 });
    expect(p.totalAmount).toBe(88500);
  });
});
