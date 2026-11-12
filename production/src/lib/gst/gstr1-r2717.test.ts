/* R-2717 — an invoice whose lines carry different GST rates (0% + 18%) in GSTR-1.
   Owner example (R-2702: INV/25-26/1248, 1953, 2065): ₹10,000 at 0% + ₹20,000 at 18%,
   GST ₹3,600, total ₹33,600. Before: the whole invoice was filed at ONE rate. */
import { describe, expect, it } from "vitest";
import { buildGstr1, docHsnLines, gstr1Csv, gstr1Json, type Gstr1Doc } from "./gstr1";
import { returnFromSections } from "./gstr1a";

const seller = { stateCode: "07", state: "Delhi", gstin: "07ABDCA0000A1Z5" };
const noItems = new Map<string, string | null>();

const storedLines = [
  { name: "Domain renewal", hsn: "998315", qty: 1, rate: 10000, tax_rate: 0 },
  { name: "Workspace", hsn: "998313", qty: 2, rate: 10000, tax_rate: 18 },
];

/** The mixed invoice as the GST page hands it in (tax_rate NULL on the row → taxRate is only a fallback). */
function mixed(over: Partial<Gstr1Doc> = {}): Gstr1Doc {
  const taxableValue = over.taxableValue ?? 30000;
  return {
    id: "INV/25-26/1248", date: "2025-11-10", docType: "invoice", customerName: "Acme Pvt Ltd",
    customerGstin: "29AAACA1111A1Z5", customerStateCode: "29", customerState: "Karnataka", customerCountry: "India",
    amount: 33600, taxableValue, gst: 3600, taxRate: 12, interState: true,
    lines: docHsnLines(taxableValue, storedLines, noItems),
    ...over,
  };
}

describe("R-2717 GSTR-1 by line rate", () => {
  it("docHsnLines carries each line's own rate; a line with none adds no rate", () => {
    expect(docHsnLines(30000, storedLines, noItems)).toEqual([
      { hsn: "998315", description: "Domain renewal", taxable: 10000, rate: 0 },
      { hsn: "998313", description: "Workspace", taxable: 20000, rate: 18 },
    ]);
    expect(docHsnLines(100, [{ name: "x", qty: 1, rate: 100 }], noItems)).toEqual([{ hsn: "998313", description: "x", taxable: 100 }]);
  });

  it("B2B mixed: one row per invoice with an item per rate; CSV one line per rate; JSON several itms", () => {
    const s = buildGstr1([mixed()], seller);
    expect(s.b2b).toHaveLength(1);
    expect(s.b2b[0]).toMatchObject({ id: "INV/25-26/1248", value: 33600, taxable: 30000, rate: 18, heads: { igst: 3600, cgst: 0, sgst: 0 } });
    expect(s.b2b[0].items).toEqual([
      { rate: 0, taxable: 10000, heads: { igst: 0, cgst: 0, sgst: 0 } },
      { rate: 18, taxable: 20000, heads: { igst: 3600, cgst: 0, sgst: 0 } },
    ]);
    const csv = gstr1Csv(s).b2b;
    expect(csv).toHaveLength(2);
    // Same invoice number and value on both lines; Rate + Taxable Value differ.
    expect(csv.map((r) => [r[2], r[4], r[10], r[11]])).toEqual([
      ["INV/25-26/1248", 33600, 0, 10000],
      ["INV/25-26/1248", 33600, 18, 20000],
    ]);
    const inv = gstr1Json(s, seller.gstin, "112025").b2b[0].inv[0];
    expect(inv.val).toBe(33600);
    expect(inv.itms).toEqual([
      { num: 1, itm_det: { rt: 0, txval: 10000, iamt: 0, camt: 0, samt: 0, csamt: 0 } },
      { num: 2, itm_det: { rt: 18, txval: 20000, iamt: 3600, camt: 0, samt: 0, csamt: 0 } },
    ]);
  });

  it("the old way is gone: no row files the 0% line at 18% (or the invoice at a derived 12%)", () => {
    const s = buildGstr1([mixed()], seller);
    const rates = gstr1Csv(s).b2b.map((r) => r[10]);
    expect(rates).not.toContain(12);
    expect(gstr1Csv(s).b2b.find((r) => r[10] === 18)?.[11]).toBe(20000);
  });

  it("intra-state mixed: CGST / SGST per rate add up to the invoice's own heads", () => {
    const s = buildGstr1([mixed({ customerGstin: "07AAACA1111A1Z5", customerStateCode: "07", customerState: "Delhi", interState: false, gst: 3601, amount: 33601 })], seller);
    expect(s.b2b[0].heads).toEqual({ igst: 0, cgst: 1801, sgst: 1800 });
    expect(s.b2b[0].items).toEqual([
      { rate: 0, taxable: 10000, heads: { igst: 0, cgst: 0, sgst: 0 } },
      { rate: 18, taxable: 20000, heads: { igst: 0, cgst: 1801, sgst: 1800 } },
    ]);
  });

  it("HSN by line rate: each SAC under its own rate, tax only on the taxed line", () => {
    const s = buildGstr1([mixed()], seller);
    expect(s.hsn).toEqual([
      { hsn: "998315", description: expect.any(String), rate: 0, value: 10000, taxable: 10000, heads: { igst: 0, cgst: 0, sgst: 0 } },
      { hsn: "998313", description: expect.any(String), rate: 18, value: 23600, taxable: 20000, heads: { igst: 3600, cgst: 0, sgst: 0 } },
    ]);
    // The same SAC at two rates → two rows.
    const same = buildGstr1([mixed({ lines: docHsnLines(30000, storedLines.map((l) => ({ ...l, hsn: "998313" })), noItems) })], seller);
    expect(same.hsn.map((h) => [h.hsn, h.rate, h.taxable, h.heads.igst])).toEqual([["998313", 0, 10000, 0], ["998313", 18, 20000, 3600]]);
    // Two lines at 18% + one at 0%: the 18% rows add up to the 18% slice (remainder on the last line).
    const three = buildGstr1([mixed({
      taxableValue: 30000, gst: 3601, amount: 33601,
      lines: docHsnLines(30000, [
        { name: "A", hsn: "998313", qty: 1, rate: 3333, tax_rate: 18 }, { name: "Z", hsn: "998315", qty: 1, rate: 10000, tax_rate: 0 }, { name: "B", hsn: "998314", qty: 1, rate: 16667, tax_rate: 18 },
      ], noItems),
    })], seller);
    expect(three.hsn.reduce((a, h) => a + h.heads.igst, 0)).toBe(3601);
    expect(three.hsn.find((h) => h.rate === 0)?.heads.igst).toBe(0);
    expect(three.hsn.reduce((a, h) => a + h.taxable, 0)).toBe(30000);
  });

  it("B2CS by line rate: each rate adds to its own place-of-supply bucket", () => {
    const b2c = mixed({ customerGstin: null, amount: 33600 });
    const plain: Gstr1Doc = { ...mixed({ customerGstin: null }), id: "INV-2", amount: 11800, taxableValue: 10000, gst: 1800, taxRate: 18, lines: undefined };
    const s = buildGstr1([b2c, plain], seller);
    expect(s.b2cs).toEqual([
      { pos: "29-Karnataka", interState: true, rate: 0, taxable: 10000, heads: { igst: 0, cgst: 0, sgst: 0 } },
      { pos: "29-Karnataka", interState: true, rate: 18, taxable: 30000, heads: { igst: 5400, cgst: 0, sgst: 0 } },
    ]);
  });

  it("B2CL (large inter-state unregistered) mixed: one invoice, itms per rate", () => {
    const s = buildGstr1([mixed({ customerGstin: null, amount: 336000, taxableValue: 300000, gst: 36000, lines: docHsnLines(300000, storedLines, noItems) })], seller);
    expect(s.b2cl).toHaveLength(1);
    expect(gstr1Json(s, seller.gstin, "112025").b2cl[0].inv[0].itms.map((i) => [i.itm_det.rt, i.itm_det.txval, i.itm_det.iamt]))
      .toEqual([[0, 100000, 0], [18, 200000, 36000]]);
  });

  it("EXP mixed: a taxed line + a 0% line is one WPAY invoice with an item per rate; all-0% stays WOPAY", () => {
    const exp = mixed({ customerGstin: null, customerStateCode: null, customerState: null, customerCountry: "United Arab Emirates", interState: false });
    const s = buildGstr1([exp], seller);
    expect(s.exp).toHaveLength(1);
    expect(s.exp[0]).toMatchObject({ exportType: "WPAY", value: 33600, taxable: 30000, igst: 3600, rate: 18 });
    expect(gstr1Json(s, seller.gstin, "112025").exp[0].inv[0].itms).toEqual([
      { txval: 10000, rt: 0, iamt: 0, csamt: 0 }, { txval: 20000, rt: 18, iamt: 3600, csamt: 0 },
    ]);
    expect(gstr1Csv(s).exp.map((r) => [r[0], r[1], r[7], r[8]])).toEqual([["WPAY", "INV/25-26/1248", 0, 10000], ["WPAY", "INV/25-26/1248", 18, 20000]]);
    const lut = buildGstr1([{ ...exp, gst: 0, amount: 30000, lines: docHsnLines(30000, storedLines.map((l) => ({ ...l, tax_rate: 0 })), noItems), taxRate: 0 }], seller);
    expect(lut.exp).toEqual([{ exportType: "WOPAY", id: "INV/25-26/1248", date: "2025-11-10", value: 30000, rate: 0, taxable: 30000, igst: 0 }]);
  });

  it("credit note follows its invoice: CDNR items per rate (positive), HSN nets signed per rate", () => {
    // Half the invoice credited: −₹16,800 = −₹15,000 taxable − ₹1,800 GST, split like the invoice's lines.
    const note = mixed({ id: "CN-1", docType: "credit_note", amount: -16800, taxableValue: -15000, gst: -1800, lines: docHsnLines(-15000, storedLines, noItems) });
    const s = buildGstr1([mixed(), note], seller);
    expect(s.cdnr).toHaveLength(1);
    expect(s.cdnr[0]).toMatchObject({ id: "CN-1", noteType: "C", value: 16800, taxable: 15000, heads: { igst: 1800, cgst: 0, sgst: 0 } });
    expect(s.cdnr[0].items).toEqual([
      { rate: 0, taxable: 5000, heads: { igst: 0, cgst: 0, sgst: 0 } },
      { rate: 18, taxable: 10000, heads: { igst: 1800, cgst: 0, sgst: 0 } },
    ]);
    expect(gstr1Csv(s).cdnr.map((r) => [r[2], r[8], r[10], r[11]])).toEqual([["CN-1", 16800, 0, 5000], ["CN-1", 16800, 18, 10000]]);
    expect(s.hsn.map((h) => [h.hsn, h.rate, h.taxable, h.heads.igst])).toEqual([["998315", 0, 5000, 0], ["998313", 18, 10000, 1800]]);
  });

  it("one row per invoice for the filed-return compare (GSTR-1A): both rates on the one document", () => {
    const r = returnFromSections(buildGstr1([mixed()], seller));
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0]).toMatchObject({ table: "B2B", num: "INV/25-26/1248", taxable: 30000, rates: [0, 18] });
  });

  it("a single-rate invoice is untouched: no items, its own rate, one CSV line", () => {
    const plain: Gstr1Doc = { ...mixed(), taxRate: 18, gst: 5400, amount: 35400, lines: docHsnLines(30000, storedLines.map(({ tax_rate: _t, ...l }) => l), noItems) };
    const s = buildGstr1([plain], seller);
    expect(s.b2b).toEqual([{ gstin: "29AAACA1111A1Z5", name: "Acme Pvt Ltd", id: "INV/25-26/1248", date: "2025-11-10", value: 35400, pos: "29-Karnataka", rate: 18, taxable: 30000, heads: { igst: 5400, cgst: 0, sgst: 0 }, invType: "R" }]);
    expect(gstr1Csv(s).b2b).toHaveLength(1);
    expect(s.hsn.map((h) => h.rate)).toEqual([18, 18]);
  });
});
