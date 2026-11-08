// R-2602 — "Import Amazon Business report" on the Expenses page. Owner's real case (8 Nov 2026):
// Amazon Business → Business Analytics → "Reconciliation by shipment level" CSV; one NetBanking
// payment (one Payment Reference ID) covers several orders → one HDFC debit, reconciled by hand.
// Every order id / ASIN / title / amount below is made up (T- names) — the real file never enters git.
import { describe, it, expect } from "vitest";
import {
  AMAZON_VENDOR_NAME, SAMPLE_AMAZON_CSV, buildAmazonImportPreview, readAmazonReportCsv, toAmazonExpenseInserts,
  type ExistingExpenseKey,
} from "./amazon-business-import";

/* The 37 columns of the real report, in its order (header only — the rows are invented). */
const HEADER = "﻿Order Date,Order ID,Account Group,PO Number,Account User,Account User Email,Document issue date,Statement number,Original Invoice Number,Invoice due date,Document status,Transaction Type,Order payment method,Payment Reference ID,Payment Date,Charge Identifier,Payment Identifier,Shipment/refund date,Shipment Status,Ship From Country,Currency,Shipment Quantity,Item subtotal incl. tax,Shipping and handling excl. tax,Promotions and discounts excl. tax,Gift wrap fees excl. tax,Regulatory fees excl. tax ,Other fees excl. tax,Tax rate,Total tax amount,Net total,Delivery status,ASIN,Title,Unit price excl. tax,PO Line Item Id,Cost center";

const row = (o: {
  date: string; id: string; ref: string; payDate: string; qty: string; sub: string; ship?: string; promo?: string;
  rate?: string; tax: string; net: string; asin: string; title: string; unit: string; currency?: string; shipDate?: string;
}) => [
  o.date, o.id, "T-Test Group", "", "T Buyer", "t.buyer@example.test", "N/A", "", "", "N/A", "", "Charge",
  o.ref ? "NetBanking" : "", o.ref, o.payDate, "", "", o.shipDate ?? (o.qty === "0" ? "N/A" : "25/08/2026"), o.qty === "0" ? "" : "Shipped", "IN",
  o.currency ?? "INR", o.qty, o.sub, o.ship ?? "", o.promo ?? "", "", "", "", o.rate ?? (o.tax ? "18%" : ""), o.tax, o.net,
  o.qty === "0" ? "N/A" : "Delivered", o.asin, `"${o.title}"`, o.unit, "", "",
].join(",");

const REF_A = "TPayRefAAAAAAAAAAAAAAAAAAAAAAAAA01";
const REF_B = "TPayRefBBBBBBBBBBBBBBBBBBBBBBBBB02";

/** Two orders on one payment (ref A), a cancelled row, a Prime membership on its own ref (B), and one unpaid-yet row. */
const FILE = [
  HEADER,
  row({ date: "23/08/2026", id: "260-2602001-0000001", ref: REF_A, payDate: "23/08/2026", qty: "1", sub: "1179.99", ship: "0.00", tax: "179.99", net: "1179.99", asin: "T0AAAA01A1", title: "T-Laptop Stand, Aluminium, Foldable", unit: "1000.00" }),
  row({ date: "23/08/2026", id: "260-2602001-0000001", ref: REF_A, payDate: "23/08/2026", qty: "2", sub: "472.00", ship: "0.00", tax: "72.00", net: "472.00", asin: "T0AAAA02B2", title: "T-USB-C Cable 1m (pack of 2)", unit: "200.00" }),
  row({ date: "23/08/2026", id: "260-2602002-0000002", ref: REF_A, payDate: "23/08/2026", qty: "1", sub: "2360.00", ship: "40.00", promo: "-40.00", tax: "360.00", net: "2360.00", asin: "T0AAAA03C3", title: "T-Office Chair Cushion", unit: "2000.00" }),
  // cancelled before shipping: quantity 0, no amounts, no payment reference
  row({ date: "11/08/2026", id: "260-2602003-0000003", ref: "", payDate: "N/A", qty: "0", sub: "", tax: "", net: "", asin: "T0AAAA04D4", title: "T-Desk Lamp (cancelled)", unit: "9.99" }),
  // Prime membership: its own order, own payment
  row({ date: "09/08/2026", id: "T60-2602004-0000004", ref: REF_B, payDate: "09/08/2026", qty: "1", sub: "1499.00", tax: "228.66", net: "1499.00", asin: "T0PRIME001", title: "Amazon Prime Membership — Business Prime Annual", unit: "1270.34" }),
].join("\n") + "\n";

const preview = (csv: string, existing: ExistingExpenseKey[] = []) => buildAmazonImportPreview(readAmazonReportCsv(csv).lines, existing);

describe("readAmazonReportCsv", () => {
  it("finds the columns by name (BOM, trailing space in 'Regulatory fees excl. tax ') and reads each row", () => {
    const r = readAmazonReportCsv(FILE);
    expect(r.missingColumns).toEqual([]);
    expect(r.rowCount).toBe(5);
    const l = r.lines[0];
    expect(l).toMatchObject({ orderId: "260-2602001-0000001", orderDate: "2026-08-23", paymentRef: REF_A, paymentDate: "2026-08-23", qty: 1, netTotal: 1179.99, taxAmount: 179.99, taxRatePct: 18, asin: "T0AAAA01A1", unitPrice: 1000, currency: "INR", cancelled: false });
    expect(l.title).toBe("T-Laptop Stand, Aluminium, Foldable");
  });

  it("'N/A' and empty cells are blank, not errors; quantity 0 marks the row cancelled", () => {
    const r = readAmazonReportCsv(FILE);
    const c = r.lines[3];
    expect(c).toMatchObject({ cancelled: true, qty: 0, netTotal: null, paymentRef: null, paymentDate: null, bad: null });
  });

  it("missing key columns are named", () => {
    const r = readAmazonReportCsv("Order Date,Title,Net total\n01/08/2026,Thing,100\n");
    expect(r.missingColumns).toEqual(["Order ID", "ASIN", "Shipment Quantity"]);
    expect(r.lines).toEqual([]);
  });

  it("an unreadable amount or date is said plainly on the row (edge 8)", () => {
    const bad = [HEADER, row({ date: "23/08/2026", id: "260-2602009-0000009", ref: REF_A, payDate: "23/08/2026", qty: "1", sub: "abc", tax: "1", net: "abc", asin: "T0AAAA09Z9", title: "T-Thing", unit: "1" })].join("\n");
    const r = readAmazonReportCsv(bad);
    expect(r.lines[0].bad).toMatch(/Net total "abc" is not a number/);
    const p = buildAmazonImportPreview(r.lines, []);
    expect(p.rows[0].verdict).toBe("problem");
  });
});

describe("buildAmazonImportPreview — orders, cancelled rows, Prime", () => {
  it("groups rows by Order ID into one draft expense each; cancelled row listed, not imported (edges 1, 6)", () => {
    const p = preview(FILE);
    expect(p.counts).toMatchObject({ import: 3, cancelled: 1, already: 0, problem: 0 });
    const o1 = p.rows.find((r) => r.orderId === "260-2602001-0000001")!;
    expect(o1.verdict).toBe("import");
    expect(o1.lines).toHaveLength(2);
    expect(o1.lines[0]).toMatchObject({ asin: "T0AAAA01A1", qty: 1, unitPrice: 1000, amount: 1180 });
    expect(o1.lines[1]).toMatchObject({ asin: "T0AAAA02B2", qty: 2, unitPrice: 200, amount: 472 });
    // order total = sum of its rows' Net total, whole rupees (1179.99 + 472.00 → 1652)
    expect(o1.total).toBe(1652);
    expect(o1.taxTotal).toBe(252); // 179.99 + 72.00 → 252
    expect(o1.notes.join(" ")).toMatch(/whole rupees/);
    const o2 = p.rows.find((r) => r.orderId === "260-2602002-0000002")!;
    expect(o2.total).toBe(2360); // shipping 40 − promotion 40 already inside Net total
    const cancelled = p.rows.find((r) => r.orderId === "260-2602003-0000003")!;
    expect(cancelled.verdict).toBe("cancelled");
    expect(cancelled.message).toMatch(/cancelled/i);
    expect(p.totalAmount).toBe(1652 + 2360 + 1499);
  });

  it("ITC is OFF by default: no GST head is guessed, the tax is noted for the invoice (edge 5)", () => {
    const p = preview(FILE);
    const ins = toAmazonExpenseInserts(p.toImport, { fileName: "t.csv", stamp: "T2602" });
    expect(ins).toHaveLength(3);
    for (const e of ins) {
      expect(e.bill_type).toBe("none");
      expect(e.gst_paid).toBe(0);
      expect(e.igst).toBeNull(); expect(e.cgst).toBeNull(); expect(e.sgst).toBeNull();
      expect(e.paid).toBe(false);
      expect(e.paid_date).toBeNull();
      expect(e.vendor_name).toBe(AMAZON_VENDOR_NAME);
      expect(e.vendor_id).toBeNull();
      expect(e.currency).toBe("INR");
      expect(e.notes).toMatch(/seller GSTIN/);
      expect(e.notes).toMatch(/ITC off/);
    }
    const o1 = ins.find((e) => e.bill_no === "260-2602001-0000001")!;
    expect(o1.amount).toBe(1652);
    expect(o1.expense_date).toBe("2026-08-23");
    expect(o1.notes).toMatch(/GST ₹252 at 18%/);
    expect(o1.notes).toMatch(new RegExp(`Payment Ref ${REF_A}`));
    expect(o1.line_items).toEqual([
      { name: "T-Laptop Stand, Aluminium, Foldable (ASIN T0AAAA01A1)", qty: 1, rate: 1000, amount: 1180 },
      { name: "T-USB-C Cable 1m (pack of 2) (ASIN T0AAAA02B2)", qty: 2, rate: 200, amount: 472 },
    ]);
    expect(o1.id).toBe("AMZ-T2602-A001");
  });

  it("a Prime membership is its own subscription expense (edge 7)", () => {
    const p = preview(FILE);
    const prime = p.rows.find((r) => r.orderId === "T60-2602004-0000004")!;
    expect(prime.verdict).toBe("import");
    expect(prime.isPrime).toBe(true);
    expect(prime.category).toBe("Software");
    expect(prime.notes.join(" ")).toMatch(/subscription/i);
    const ins = toAmazonExpenseInserts([prime], { fileName: "t.csv", stamp: "S" });
    expect(ins[0].description).toMatch(/Prime membership/i);
    expect(ins[0].description).toMatch(/subscription/i);
  });

  it("the same Order ID + ASIN twice (identical rows) counts once (edge 2)", () => {
    const dup = FILE + row({ date: "23/08/2026", id: "260-2602001-0000001", ref: REF_A, payDate: "23/08/2026", qty: "1", sub: "1179.99", ship: "0.00", tax: "179.99", net: "1179.99", asin: "T0AAAA01A1", title: "T-Laptop Stand, Aluminium, Foldable", unit: "1000.00" }) + "\n";
    const p = preview(dup);
    const o1 = p.rows.find((r) => r.orderId === "260-2602001-0000001")!;
    expect(o1.lines).toHaveLength(2);
    expect(o1.total).toBe(1652);
    expect(o1.notes.join(" ")).toMatch(/twice/);
  });

  it("an order already in Expenses (bill_no = Order ID) is 'already', never a second row (edges 3, 12)", () => {
    const p = preview(FILE, [{ vendor_name: AMAZON_VENDOR_NAME, bill_no: "260-2602001-0000001" }, { vendor_name: "Someone else", bill_no: "t60-2602004-0000004" }]);
    expect(p.counts).toMatchObject({ import: 1, already: 2 });
    expect(p.toImport.map((r) => r.orderId)).toEqual(["260-2602002-0000002"]);
  });

  it("a non-INR row is refused (edge 13)", () => {
    const usd = [HEADER, row({ date: "23/08/2026", id: "260-2602010-0000010", ref: REF_A, payDate: "23/08/2026", qty: "1", sub: "10", tax: "0", net: "10", asin: "T0AAAA10Y0", title: "T-Thing", unit: "10", currency: "USD" })].join("\n");
    const p = preview(usd);
    expect(p.rows[0].verdict).toBe("problem");
    expect(p.rows[0].message).toMatch(/USD/);
  });

  it("more than 500 orders → split the file (edge 14)", () => {
    const many = [HEADER, ...Array.from({ length: 501 }, (_, i) => row({ date: "01/08/2026", id: `260-2602100-${String(i).padStart(7, "0")}`, ref: REF_A, payDate: "01/08/2026", qty: "1", sub: "118", tax: "18", net: "118", asin: `T0MANY${String(i).padStart(4, "0")}`, title: "T-Thing", unit: "100" }))].join("\n");
    const p = preview(many);
    expect(p.counts.import).toBe(0);
    expect(p.rows[0].message).toMatch(/500/);
  });
});

describe("expected bank debits — one per Payment Reference ID + Payment Date (edge 9)", () => {
  it("sums the Net total of the orders on one payment; a cancelled row adds nothing", () => {
    const p = preview(FILE);
    expect(p.expectedDebits).toEqual([
      { paymentRef: REF_A, paymentDate: "2026-08-23", amount: 1652 + 2360, orderIds: ["260-2602001-0000001", "260-2602002-0000002"] },
      { paymentRef: REF_B, paymentDate: "2026-08-09", amount: 1499, orderIds: ["T60-2602004-0000004"] },
    ]);
  });

  it("an order without a payment reference is listed under 'no payment reference' and still imports", () => {
    const noRef = [HEADER, row({ date: "23/08/2026", id: "260-2602011-0000011", ref: "", payDate: "N/A", qty: "1", sub: "118", tax: "18", net: "118", asin: "T0AAAA11X1", title: "T-Thing", unit: "100" })].join("\n");
    const p = preview(noRef);
    expect(p.rows[0].verdict).toBe("import");
    expect(p.expectedDebits).toEqual([]);
    expect(p.noPaymentRef).toEqual(["260-2602011-0000011"]);
  });

  it("an already-imported order is left out of its payment's expected debit", () => {
    const p = preview(FILE, [{ vendor_name: AMAZON_VENDOR_NAME, bill_no: "260-2602001-0000001" }]);
    expect(p.expectedDebits[0]).toMatchObject({ paymentRef: REF_A, amount: 2360, orderIds: ["260-2602002-0000002"] });
  });
});

describe("sample file", () => {
  it("the sample CSV imports cleanly (what 'Download a sample' gives)", () => {
    const p = preview(SAMPLE_AMAZON_CSV);
    expect(p.counts.problem).toBe(0);
    expect(p.counts.import).toBeGreaterThanOrEqual(2);
    expect(p.counts.cancelled).toBe(1);
    expect(p.expectedDebits.length).toBeGreaterThanOrEqual(1);
  });
});

describe("rounding happens once, at the order and at the bank debit (review BLOCK on afbc32b3d)", () => {
  const twoHalves = (id: string, ref: string) => [
    row({ date: "23/08/2026", id, ref, payDate: "23/08/2026", qty: "1", sub: "10.49", tax: "1.60", net: "10.49", asin: "T0HALF0001", title: "T-Half A", unit: "8.89" }),
    row({ date: "23/08/2026", id, ref, payDate: "23/08/2026", qty: "1", sub: "10.49", tax: "1.60", net: "10.49", asin: "T0HALF0002", title: "T-Half B", unit: "8.89" }),
  ];
  it("10.49 + 10.49 = 20.98 → ₹21 for the order (not ₹10 + ₹10 = ₹20); tax 1.60 + 1.60 → ₹3", () => {
    const p = preview([HEADER, ...twoHalves("260-2602020-0000020", REF_A)].join("\n"));
    const o = p.rows[0];
    expect(o.verdict).toBe("import");
    expect(o.total).toBe(21);
    expect(o.taxTotal).toBe(3);
    expect(o.lines.map((l) => l.amount)).toEqual([10, 10]); // display only
    expect(o.notes.join(" ")).toMatch(/rounded once/);
    const ins = toAmazonExpenseInserts([o], { fileName: "t.csv", stamp: "X" });
    expect(ins[0].amount).toBe(21);
    expect(p.totalAmount).toBe(21);
  });
  it("the expected bank debit rounds the exact sum of its orders once: 20.98 + 20.98 = 41.96 → ₹42", () => {
    const p = preview([HEADER, ...twoHalves("260-2602021-0000021", REF_A), ...twoHalves("260-2602022-0000022", REF_A)].join("\n"));
    expect(p.rows.map((r) => r.total)).toEqual([21, 21]);
    expect(p.expectedDebits).toEqual([{ paymentRef: REF_A, paymentDate: "2026-08-23", amount: 42, orderIds: ["260-2602021-0000021", "260-2602022-0000022"] }]);
  });
  it("0.50 + 0.50 across two orders on one payment: orders ₹1 + ₹1 but the debit is the exact ₹1", () => {
    const one = (id: string, asin: string) => row({ date: "23/08/2026", id, ref: REF_B, payDate: "23/08/2026", qty: "1", sub: "0.50", tax: "0.08", net: "0.50", asin, title: "T-Tiny", unit: "0.42" });
    const p = preview([HEADER, one("260-2602023-0000023", "T0TINY0001"), one("260-2602024-0000024", "T0TINY0002")].join("\n"));
    expect(p.expectedDebits[0].amount).toBe(1);
  });
});
