import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { B2CL_THRESHOLD, buildAdvances, buildGstr1, docGstRate, docHsnLines, lineHsn, gstr1Csv, gstr1Json, gstr3bClass, gstSplit, hsnLines, posFor, GSTR1_HEADERS, type Advance, type Gstr1Doc } from "./gstr1";
import { SAAS_HSN } from "./hsn";

const seller = { stateCode: "07", state: "Delhi", gstin: "07AABCU9603R1ZM" };

function doc(over: Partial<Gstr1Doc>): Gstr1Doc {
  return {
    id: "INV-1", date: "2026-08-10", docType: "invoice", customerName: "Cust",
    customerGstin: null, customerStateCode: null, customerState: null,
    amount: 118000, taxableValue: 100000, gst: 18000, taxRate: 18, interState: false,
    ...over,
  };
}

describe("GSTR-1 sections", () => {
  it("B2CL cut-off is ₹1,00,000 (Notification 12/2024-CT), on invoice VALUE, inter-state only", () => {
    expect(B2CL_THRESHOLD).toBe(100_000);
    const s = buildGstr1([
      doc({ id: "BIG", interState: true, customerStateCode: "27", customerState: "Maharashtra", amount: 118000, taxableValue: 100000, gst: 18000 }),
      doc({ id: "SMALL", interState: true, customerStateCode: "27", customerState: "Maharashtra", amount: 99999, taxableValue: 84745, gst: 15254 }),
      doc({ id: "INTRA-BIG", interState: false, amount: 590000, taxableValue: 500000, gst: 90000 }),
    ], seller);
    expect(s.b2cl.map((r) => r.id)).toEqual(["BIG"]);
    expect(s.b2cl[0].pos).toBe("27-Maharashtra");
    expect(s.b2cl[0].heads).toEqual({ igst: 18000, cgst: 0, sgst: 0 });
    // the small one and the intra-state one consolidate into B2CS, by POS + rate
    expect(s.b2cs).toHaveLength(2);
    const intra = s.b2cs.find((r) => r.pos === "07-Delhi")!;
    expect(intra.taxable).toBe(500000);
    expect(intra.heads).toEqual({ igst: 0, cgst: 45000, sgst: 45000 });
  });

  it("registered buyer → B2B from the GSTIN's state, whatever the customer record says", () => {
    const s = buildGstr1([doc({ customerGstin: "29AABCU9603R1ZX", customerStateCode: "07", customerState: "Delhi", interState: true })], seller);
    expect(s.b2b).toHaveLength(1);
    expect(s.b2b[0].pos).toBe("29-Karnataka");
    expect(s.b2cs).toHaveLength(0);
  });

  it("credit/debit notes of a registered buyer go to CDNR with positive values and the note type", () => {
    const s = buildGstr1([
      doc({ id: "CN-1", docType: "credit_note", customerGstin: "07AABCU9603R1ZM", amount: -11800, taxableValue: -10000, gst: -1800 }),
      doc({ id: "DN-1", docType: "debit_note", customerGstin: "07AABCU9603R1ZM", amount: 2360, taxableValue: 2000, gst: 360 }),
    ], seller);
    expect(s.b2b).toHaveLength(0);
    expect(s.cdnr.map((r) => [r.id, r.noteType, r.value, r.taxable, r.heads.cgst])).toEqual([
      ["CN-1", "C", 11800, 10000, 900],
      ["DN-1", "D", 2360, 2000, 180],
    ]);
  });

  it("unregistered notes: large inter-state → CDNUR; small ones net into B2CS (signed)", () => {
    const s = buildGstr1([
      doc({ id: "INV-M", interState: true, customerStateCode: "27", customerState: "Maharashtra", amount: 59000, taxableValue: 50000, gst: 9000 }),
      doc({ id: "CN-M", docType: "credit_note", interState: true, customerStateCode: "27", customerState: "Maharashtra", amount: -11800, taxableValue: -10000, gst: -1800 }),
      doc({ id: "CN-BIG", docType: "credit_note", interState: true, customerStateCode: "27", customerState: "Maharashtra", amount: -236000, taxableValue: -200000, gst: -36000 }),
    ], seller);
    expect(s.cdnur).toHaveLength(1);
    expect(s.cdnur[0]).toMatchObject({ id: "CN-BIG", noteType: "C", value: 236000, taxable: 200000, heads: { igst: 36000, cgst: 0, sgst: 0 } });
    expect(s.b2cs).toHaveLength(1);
    expect(s.b2cs[0].taxable).toBe(40000);
    expect(s.b2cs[0].heads.igst).toBe(7200);
    expect(s.notesNettedIntoB2cs).toBe(1);
  });

  it("a B2C document with no place of supply is skipped by id, never dropped silently", () => {
    const s = buildGstr1([doc({ id: "NOPOS", interState: true })], { stateCode: null, state: null });
    expect(s.skipped).toEqual(["NOPOS"]);
    expect(s.b2cs).toHaveLength(0);
    expect(s.hsn[0].taxable).toBe(100000); // still in the HSN summary — it was still a supply
  });

  it("HSN summary is per SAC from the lines, nets notes, and defaults to the SaaS SAC", () => {
    const s = buildGstr1([
      doc({ id: "A", lines: [{ hsn: "998313", taxable: 70000 }, { hsn: "998315", description: "Hosting", taxable: 30000 }] }),
      doc({ id: "B" }),                               // no lines → 998313
      doc({ id: "CN", docType: "credit_note", amount: -11800, taxableValue: -10000, gst: -1800 }),
    ], seller);
    const saas = s.hsn.find((h) => h.hsn === SAAS_HSN)!;
    const host = s.hsn.find((h) => h.hsn === "998315")!;
    expect(saas.taxable).toBe(70000 + 100000 - 10000);
    expect(saas.heads).toEqual({ igst: 0, cgst: 6300 + 9000 - 900, sgst: 6300 + 9000 - 900 });
    expect(host).toMatchObject({ description: "Hosting", taxable: 30000, value: 35400, heads: { igst: 0, cgst: 2700, sgst: 2700 } });
  });

  it("hsnLines prorates the invoice's taxable value by line weight and always adds up", () => {
    const ln = hsnLines(100000, [{ hsn: "998313", weight: 1000 }, { hsn: "998315", weight: 500 }, { hsn: null, weight: 500 }]);
    expect(ln.map((l) => l.taxable)).toEqual([50000, 25000, 25000]);
    expect(ln[2].hsn).toBe(SAAS_HSN);
    expect(hsnLines(999, [{ hsn: "1", weight: 1 }, { hsn: "2", weight: 1 }, { hsn: "3", weight: 1 }]).reduce((s, l) => s + l.taxable, 0)).toBe(999);
    expect(hsnLines(500, [])).toEqual([{ hsn: SAAS_HSN, description: expect.any(String), taxable: 500 }]);
  });

  it("R-067: a line's own HSN (project milestone, SAC 998314, no item_id) is filed under 998314, not 998313", () => {
    // INV-FBB9-2026-27-0003 as stored: one milestone line, own hsn, no catalogue item.
    const stored = [{ id: "milestone-2", hsn: "998314", qty: 1, cost: 0, name: "Complete Billing System — Doosri kist (advance)", rate: 500000 }];
    const catalogue = new Map<string, string | null>([["ITEM-GWS", null], ["ITEM-HW", "847130"]]);
    const s = buildGstr1([doc({ id: "INV-FBB9-2026-27-0003", amount: 590000, taxableValue: 500000, gst: 90000, lines: docHsnLines(500000, stored, catalogue) })], seller);
    expect(s.hsn.map((r) => r.hsn)).toEqual(["998314"]);
    expect(s.hsn[0].taxable).toBe(500000);
    expect(s.hsn[0].description).toBe("Information technology (IT) design and development services");
    // Order: line's own code → catalogue item's code → SaaS default.
    expect(lineHsn({ item_id: "ITEM-HW", hsn: "998314" }, catalogue)).toBe("998314");
    expect(lineHsn({ item_id: "ITEM-HW" }, catalogue)).toBe("847130");
    expect(lineHsn({ item_id: "ITEM-GWS", hsn: "  " }, catalogue)).toBeNull();
    expect(docHsnLines(100, [{ item_id: "ITEM-GWS", qty: 1, rate: 1 }], catalogue)[0].hsn).toBe(SAAS_HSN);
  });

  it("R-067: a credit note on a 998314 invoice reverses 998314 (split like the invoice it amends)", () => {
    const parent = [{ hsn: "998314", qty: 1, rate: 300000, name: "Dev" }, { item_id: "GWS", qty: 10, rate: 10000, name: "Workspace" }];
    const lines = docHsnLines(-40000, parent, new Map());
    expect(lines).toEqual([
      { hsn: "998314", description: "Dev", taxable: -30000 },
      { hsn: SAAS_HSN, description: "Workspace", taxable: -10000 },
    ]);
    const s = buildGstr1([
      doc({ id: "INV-P", amount: 472000, taxableValue: 400000, gst: 72000, lines: docHsnLines(400000, parent, new Map()) }),
      doc({ id: "CN-P", docType: "credit_note", amount: -47200, taxableValue: -40000, gst: -7200, lines }),
    ], seller);
    const by = Object.fromEntries(s.hsn.map((r) => [r.hsn, r.taxable]));
    expect(by).toEqual({ "998314": 270000, [SAAS_HSN]: 90000 });
  });

  it("CSV rows follow the Offline Tool templates (CDNR note type, CDNUR UR type B2CL)", () => {
    const s = buildGstr1([
      doc({ id: "CN-1", docType: "credit_note", customerGstin: "07AABCU9603R1ZM", amount: -11800, taxableValue: -10000, gst: -1800 }),
      doc({ id: "CN-BIG", docType: "debit_note", interState: true, customerStateCode: "27", customerState: "Maharashtra", amount: 236000, taxableValue: 200000, gst: 36000 }),
    ], seller);
    const csv = gstr1Csv(s);
    expect(csv.cdnr[0]).toEqual(["07AABCU9603R1ZM", "Cust", "CN-1", "10-Aug-2026", "C", "07-Delhi", "N", "Regular B2B", 11800, "", 18, 10000, 0]);
    expect(csv.cdnur[0]).toEqual(["B2CL", "CN-BIG", "10-Aug-2026", "D", "27-Maharashtra", "B2CL", 236000, "", 18, 200000, 0]);
    expect(csv.hsn[0][0]).toBe(SAAS_HSN);
  });

  it("Portal JSON carries the real GSTIN, split tax heads, and every section", () => {
    const s = buildGstr1([
      doc({ id: "INV-B2B", customerGstin: "07AABCU9603R1ZM" }),
      doc({ id: "INV-B2B-2", customerGstin: "07AABCU9603R1ZM", amount: 1180, taxableValue: 1000, gst: 180 }),
      doc({ id: "CN-1", docType: "credit_note", customerGstin: "07AABCU9603R1ZM", amount: -11800, taxableValue: -10000, gst: -1800 }),
      doc({ id: "INV-BIG", interState: true, customerStateCode: "27", customerState: "Maharashtra" }),
      doc({ id: "INV-SM", customerStateCode: "07", customerState: "Delhi", amount: 590, taxableValue: 500, gst: 90 }),
    ], seller);
    const j = gstr1Json(s, seller.gstin, "082026");
    expect(j.gstin).toBe("07AABCU9603R1ZM");
    expect(j.fp).toBe("082026");
    expect(j.b2b).toHaveLength(1);                     // grouped by ctin
    expect(j.b2b[0].inv).toHaveLength(2);
    expect(j.b2b[0].inv[0]).toMatchObject({ inum: "INV-B2B", idt: "10-08-2026", pos: "07", itms: [{ num: 1, itm_det: { rt: 18, txval: 100000, iamt: 0, camt: 9000, samt: 9000 } }] });
    expect(j.cdnr[0].nt[0]).toMatchObject({ ntty: "C", nt_num: "CN-1", val: 11800, itms: [{ itm_det: { camt: 900, samt: 900 } }] });
    expect(j.b2cl[0]).toMatchObject({ pos: "27", inv: [{ inum: "INV-BIG", itms: [{ itm_det: { iamt: 18000 } }] }] });
    expect(j.b2cs[0]).toMatchObject({ sply_ty: "INTRA", pos: "07", txval: 500, camt: 45, samt: 45 });
    expect(j.hsn.data[0]).toMatchObject({ hsn_sc: SAAS_HSN, uqc: "OTH" });
  });

  it("gstSplit halves CGST/SGST exactly (odd rupee → CGST, like the invoice), mirrored for a signed note", () => {
    expect(gstSplit({ gst: 181, interState: false })).toEqual({ igst: 0, cgst: 91, sgst: 90 });
    expect(gstSplit({ gst: -181, interState: false })).toEqual({ igst: 0, cgst: -91, sgst: -90 });
    expect(gstSplit({ gst: 181, interState: true })).toEqual({ igst: 181, cgst: 0, sgst: 0 });
  });

  it("posFor: GSTIN beats customer state beats seller state; inter-state without a state is unknown", () => {
    expect(posFor({ customerGstin: "27ABCDE1234F1Z5", customerStateCode: "07", customerState: "Delhi", interState: true }, seller)?.code).toBe("27");
    expect(posFor({ customerGstin: null, customerStateCode: "9", customerState: null, interState: true }, seller)).toEqual({ code: "09", name: "Uttar Pradesh" });
    expect(posFor({ customerGstin: null, customerStateCode: null, customerState: null, interState: false }, seller)?.code).toBe("07");
    expect(posFor({ customerGstin: null, customerStateCode: null, customerState: null, interState: true }, seller)).toBeNull();
  });
});

describe("WC-gst: odd tax amounts", () => {
  it("B2CS, B2B and HSN all put the odd rupee in CGST, the same split the invoice printed", () => {
    const s = buildGstr1([
      doc({ id: "ODD-B2C", customerStateCode: "07", customerState: "Delhi", amount: 1181, taxableValue: 1000, gst: 181 }),
      doc({ id: "ODD-B2B", customerGstin: "07AABCU9603R1ZM", amount: 1181, taxableValue: 1000, gst: 181 }),
    ], seller);
    expect(s.b2cs[0].heads).toEqual({ igst: 0, cgst: 91, sgst: 90 });
    expect(s.b2b[0].heads).toEqual({ igst: 0, cgst: 91, sgst: 90 });
    expect(s.hsn[0].heads).toEqual({ igst: 0, cgst: 182, sgst: 180 });
  });

  it("a credit note reversing an odd-tax invoice reverses the same heads (CDNR positive)", () => {
    const s = buildGstr1([doc({ id: "CN-ODD", docType: "credit_note", customerGstin: "07AABCU9603R1ZM", amount: -1181, taxableValue: -1000, gst: -181 })], seller);
    expect(s.cdnr[0].heads).toEqual({ igst: 0, cgst: 91, sgst: 90 });
  });
});

describe("WC-gst: exports (Table 6A EXP)", () => {
  const exportDoc = (over: Partial<Gstr1Doc>) => doc({ customerCountry: "United Arab Emirates", customerStateCode: null, customerState: null, ...over });

  it("an export under LUT goes to EXP as WOPAY, rate 0 (not B2CS, not skipped)", () => {
    const s = buildGstr1([exportDoc({ id: "EXP-1", amount: 100000, taxableValue: 100000, gst: 0 })], seller);
    expect(s.exp).toEqual([{ exportType: "WOPAY", id: "EXP-1", date: "2026-08-10", value: 100000, rate: 0, taxable: 100000, igst: 0 }]);
    expect(s.b2cs).toHaveLength(0);
    expect(s.skipped).toHaveLength(0);
    expect(s.hsn[0].taxable).toBe(100000);   // still an outward supply in Table 12
  });

  it("an export with IGST paid is WPAY and the tax is IGST even if the row said intra-state", () => {
    const s = buildGstr1([exportDoc({ id: "EXP-2", interState: false, amount: 118000, taxableValue: 100000, gst: 18000 })], seller);
    expect(s.exp[0]).toMatchObject({ exportType: "WPAY", rate: 18, igst: 18000 });
    expect(s.hsn[0].heads).toEqual({ igst: 18000, cgst: 0, sgst: 0 });
  });

  it("a customer marked India, or with no country, is never zero-rated", () => {
    const s = buildGstr1([
      doc({ id: "IN", customerCountry: "India", customerStateCode: "07", customerState: "Delhi" }),
      doc({ id: "BLANK", customerCountry: "", customerStateCode: "07", customerState: "Delhi" }),
    ], seller);
    expect(s.exp).toHaveLength(0);
    expect(s.b2cs[0].taxable).toBe(200000);
  });

  it("a foreign-country customer WITH an Indian GSTIN stays B2B", () => {
    const s = buildGstr1([doc({ id: "GSTIN", customerCountry: "United States", customerGstin: "07AABCU9603R1ZM" })], seller);
    expect(s.b2b).toHaveLength(1);
    expect(s.exp).toHaveLength(0);
  });

  it("an export credit note is CDNUR with UR Type EXPWOP / EXPWP and no place of supply", () => {
    const s = buildGstr1([
      exportDoc({ id: "CN-EXP", docType: "credit_note", amount: -5000, taxableValue: -5000, gst: 0 }),
      exportDoc({ id: "CN-EXPWP", docType: "credit_note", amount: -1180, taxableValue: -1000, gst: -180 }),
    ], seller);
    expect(s.cdnur.map((r) => [r.id, r.urType, r.pos, r.value])).toEqual([["CN-EXP", "EXPWOP", "", 5000], ["CN-EXPWP", "EXPWP", "", 1180]]);
    const j = gstr1Json(s, seller.gstin, "082026");
    expect(j.cdnur[0]).toMatchObject({ typ: "EXPWOP", ntty: "C" });
    expect(j.cdnur[0]).not.toHaveProperty("pos");
  });

  it("EXP CSV follows the Offline Tool template; JSON groups by exp_typ", () => {
    const s = buildGstr1([
      exportDoc({ id: "EXP-1", amount: 100000, taxableValue: 100000, gst: 0 }),
      exportDoc({ id: "EXP-2", amount: 118000, taxableValue: 100000, gst: 18000 }),
    ], seller);
    const csv = gstr1Csv(s);
    expect(GSTR1_HEADERS.exp).toEqual(["Export Type", "Invoice Number", "Invoice date", "Invoice Value", "Port Code", "Shipping Bill Number", "Shipping Bill Date", "Rate", "Taxable Value", "Cess Amount"]);
    expect(csv.exp[0]).toEqual(["WOPAY", "EXP-1", "10-Aug-2026", 100000, "", "", "", 0, 100000, 0]);
    expect(csv.exp[0]).toHaveLength(GSTR1_HEADERS.exp.length);
    const j = gstr1Json(s, seller.gstin, "082026");
    expect(j.exp.map((g) => g.exp_typ)).toEqual(["WPAY", "WOPAY"]);
    expect(j.exp[0].inv[0]).toMatchObject({ inum: "EXP-2", idt: "10-08-2026", val: 118000, itms: [{ txval: 100000, rt: 18, iamt: 18000, csamt: 0 }] });
  });

  it("3B class: export is zero-rated; inter-state unregistered gets its POS for 3.2", () => {
    expect(gstr3bClass(exportDoc({}), seller)).toEqual({ zeroRated: true, unregInterPos: null });
    expect(gstr3bClass(doc({ interState: true, customerStateCode: "27", customerState: "Maharashtra" }), seller)).toEqual({ zeroRated: false, unregInterPos: "27-Maharashtra" });
    expect(gstr3bClass(doc({ interState: true, customerGstin: "27ABCDE1234F1Z5" }), seller).unregInterPos).toBeNull();
    expect(gstr3bClass(doc({ interState: false }), seller).unregInterPos).toBeNull();
  });
});

describe("WC-gst: advances (Tables 11A / 11B)", () => {
  const period = { from: "2026-08-01", to: "2026-08-31" };
  const adv = (over: Partial<Advance>): Advance => ({
    paymentId: "P1", voucherNo: "RV-1", receivedDate: "2026-08-05", adjustedOn: null,
    gross: 11800, rate: 18, interState: false,
    customerGstin: null, customerStateCode: "07", customerState: "Delhi", ...over,
  });

  it("11A: advance received this month and not invoiced by month-end, taxable part only", () => {
    const t = buildAdvances([adv({})], period, seller);
    expect(t.at).toEqual([{ pos: "07-Delhi", interState: false, rate: 18, advance: 10000, heads: { igst: 0, cgst: 900, sgst: 900 } }]);
    expect(t.atadj).toHaveLength(0);
  });

  it("11A also when the invoice comes next month", () => {
    expect(buildAdvances([adv({ adjustedOn: "2026-09-02" })], period, seller).at).toHaveLength(1);
  });

  it("received and invoiced in the same month: neither table", () => {
    const t = buildAdvances([adv({ adjustedOn: "2026-08-20" })], period, seller);
    expect(t.at).toHaveLength(0);
    expect(t.atadj).toHaveLength(0);
  });

  it("11B: received last month, invoiced this month", () => {
    const t = buildAdvances([adv({ receivedDate: "2026-07-28", adjustedOn: "2026-08-03", interState: true, customerStateCode: "27", customerState: "Maharashtra" })], period, seller);
    expect(t.at).toHaveLength(0);
    expect(t.atadj).toEqual([{ pos: "27-Maharashtra", interState: true, rate: 18, advance: 10000, heads: { igst: 1800, cgst: 0, sgst: 0 } }]);
  });

  it("odd tax on an advance splits with the shared rule and consolidates per POS + rate", () => {
    const t = buildAdvances([adv({ gross: 1187 }), adv({ paymentId: "P2", gross: 11800 })], period, seller);
    // 1187 -> taxable 1006, tax 181 -> CGST 91 / SGST 90
    expect(t.at).toHaveLength(1);
    expect(t.at[0].advance).toBe(1006 + 10000);
    expect(t.at[0].heads).toEqual({ igst: 0, cgst: 91 + 900, sgst: 90 + 900 });
  });

  it("export advances are not taxed (LUT) and are counted, not reported", () => {
    const t = buildAdvances([adv({ customerCountry: "Singapore", customerStateCode: null, customerState: null })], period, seller);
    expect(t.at).toHaveLength(0);
    expect(t.exportsSkipped).toBe(1);
  });

  it("no place of supply: skipped by payment id", () => {
    const t = buildAdvances([adv({ paymentId: "NOPOS", interState: true, customerStateCode: null, customerState: null })], period, seller);
    expect(t.skipped).toEqual(["NOPOS"]);
  });

  it("CSV matches the Offline Tool at / atadj templates; JSON has at / txpd with ad_amt", () => {
    const t = buildAdvances([adv({}), adv({ paymentId: "P0", receivedDate: "2026-07-10", adjustedOn: "2026-08-10" })], period, seller);
    const csv = gstr1Csv(buildGstr1([], seller), t);
    expect(GSTR1_HEADERS.at).toEqual(["Place Of Supply", "Applicable % of Tax Rate", "Rate", "Gross Advance Received", "Cess Amount"]);
    expect(GSTR1_HEADERS.atadj).toEqual(["Place Of Supply", "Applicable % of Tax Rate", "Rate", "Gross Advance Adjusted", "Cess Amount"]);
    expect(csv.at).toEqual([["07-Delhi", "", 18, 10000, 0]]);
    expect(csv.atadj).toEqual([["07-Delhi", "", 18, 10000, 0]]);
    const j = gstr1Json(buildGstr1([], seller), seller.gstin, "082026", t);
    expect(j.at).toEqual([{ pos: "07", sply_ty: "INTRA", itms: [{ rt: 18, ad_amt: 10000, iamt: 0, camt: 900, samt: 900, csamt: 0 }] }]);
    expect(j.txpd[0]).toMatchObject({ pos: "07", sply_ty: "INTRA" });
  });
});

/* R-1131: a note (or legacy invoice) with no stored tax_rate used to be filed at 18%.
   The rate now comes from the document's own tax ÷ taxable, snapped to a GST slab;
   with no tax figure to go on it is flagged "rate missing", never guessed. */
describe("docGstRate — no hardcoded 18% fallback", () => {
  it("a stored rate wins", () => {
    expect(docGstRate(5, -1000, -180)).toEqual({ rate: 5, rateMissing: false });
  });
  it("no rate + 0 tax → 0%; no rate + 18% tax → 18% (signed credit-note figures)", () => {
    expect(docGstRate(null, -1000, 0)).toEqual({ rate: 0, rateMissing: false });
    expect(docGstRate(null, -1000, -180)).toEqual({ rate: 18, rateMissing: false });
    expect(docGstRate(undefined, 847, 153)).toEqual({ rate: 18, rateMissing: false });
    expect(docGstRate(null, 1000, 49)).toEqual({ rate: 5, rateMissing: false });
    expect(docGstRate(null, 1000, 280)).toEqual({ rate: 28, rateMissing: false });
  });
  it("nothing to derive from → flagged, not 18", () => {
    expect(docGstRate(null, null, null)).toEqual({ rate: 0, rateMissing: true });
    expect(docGstRate(null, 0, 180)).toEqual({ rate: 0, rateMissing: true });
  });
  it("credit notes with no rate land in the 0% and 18% GSTR-1 rows", () => {
    const zero = docGstRate(null, -1000, 0);
    const eighteen = docGstRate(null, -1000, -180);
    const s = buildGstr1([
      doc({ id: "CN-0", docType: "credit_note", amount: -1000, taxableValue: -1000, gst: 0, taxRate: zero.rate }),
      doc({ id: "CN-18", docType: "credit_note", amount: -1180, taxableValue: -1000, gst: -180, taxRate: eighteen.rate }),
    ], seller);
    const rows = s.b2cs.map((r) => [r.rate, r.taxable]).sort((a, b) => a[0] - b[0]);
    expect(rows).toEqual([[0, -1000], [18, -1000]]);
  });
  it("the GST report source has no `?? 18` rate fallback left", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/accounting/gst/report.ts"), "utf8");
    expect(src).not.toMatch(/\?\?\s*18\b/);
  });
});

describe("R-1742: SEZ and deemed export in GSTR-1 (invoices.gst_treatment)", () => {
  /* Owner's example: SEZ (with payment) invoice of ₹38,232 = ₹32,400 + IGST ₹5,832. The SEZ
     unit is in Delhi, the seller too — still IGST (IGST Act s.7(5)(b)). */
  const sez = (over: Partial<Gstr1Doc>) => doc({
    id: "INV-SEZ", customerGstin: "07AAACS1234E1ZP", customerStateCode: "07", customerState: "Delhi",
    amount: 38232, taxableValue: 32400, gst: 5832, taxRate: 18, interState: true,
    gstTreatment: "sez_with_payment", ...over,
  });

  it("SEZ with payment: B2B, invoice type SEWP in the JSON and 'SEZ supplies with payment' in the CSV, IGST ₹5,832", () => {
    const s = buildGstr1([sez({})], seller);
    expect(s.b2b).toHaveLength(1);
    expect(s.b2b[0].heads).toEqual({ igst: 5832, cgst: 0, sgst: 0 });
    expect(s.b2b[0].invType).toBe("SEWP");
    const j = gstr1Json(s, seller.gstin, "102026");
    expect(j.b2b[0].inv[0]).toMatchObject({ inum: "INV-SEZ", val: 38232, inv_typ: "SEWP", itms: [{ itm_det: { txval: 32400, iamt: 5832, camt: 0, samt: 0 } }] });
    const csv = gstr1Csv(s);
    expect(csv.b2b[0][8]).toBe("SEZ supplies with payment");
    expect(csv.b2b[0]).toHaveLength(GSTR1_HEADERS.b2b.length);
  });

  it("an SEZ invoice stored as intra-state is still filed as IGST", () => {
    const s = buildGstr1([sez({ interState: false })], seller);
    expect(s.b2b[0].heads).toEqual({ igst: 5832, cgst: 0, sgst: 0 });
    expect(s.hsn[0].heads).toEqual({ igst: 5832, cgst: 0, sgst: 0 });
  });

  it("SEZ without payment and no tax charged: SEWOP", () => {
    const s = buildGstr1([sez({ gstTreatment: "sez_without_payment", amount: 32400, gst: 0, taxRate: 0 })], seller);
    expect(s.b2b[0].invType).toBe("SEWOP");
    expect(gstr1Csv(s).b2b[0][8]).toBe("SEZ supplies without payment");
  });

  it("SEZ without payment but IGST was charged (LUT rule pending): filed as SEWP — the type follows the tax actually charged", () => {
    const s = buildGstr1([sez({ gstTreatment: "sez_without_payment" })], seller);
    expect(s.b2b[0].invType).toBe("SEWP");
  });

  it("deemed export: B2B with invoice type DE, tax by state as charged", () => {
    const s = buildGstr1([sez({ gstTreatment: "deemed_export", interState: false })], seller);
    expect(s.b2b[0].invType).toBe("DE");
    expect(s.b2b[0].heads).toEqual({ igst: 0, cgst: 2916, sgst: 2916 });
    expect(gstr1Json(s, seller.gstin, "102026").b2b[0].inv[0].inv_typ).toBe("DE");
    expect(gstr1Csv(s).b2b[0][8]).toBe("Deemed Exp");
  });

  it("regular and pre-R-1736 invoices (no treatment) stay R / Regular B2B", () => {
    const s = buildGstr1([doc({ customerGstin: "29AABCU9603R1ZX", interState: true }), doc({ id: "INV-2", customerGstin: "29AABCU9603R1ZX", interState: true, gstTreatment: "registered_regular" })], seller);
    expect(s.b2b.map((r) => r.invType)).toEqual(["R", "R"]);
    expect(gstr1Csv(s).b2b[0][8]).toBe("Regular B2B");
  });

  it("an SEZ credit note: CDNR with the SEZ supply type", () => {
    const s = buildGstr1([sez({ id: "CN-SEZ", docType: "credit_note", amount: -1180, taxableValue: -1000, gst: -180, interState: false })], seller);
    expect(s.cdnr[0]).toMatchObject({ invType: "SEWP", heads: { igst: 180, cgst: 0, sgst: 0 } });
    expect(gstr1Json(s, seller.gstin, "102026").cdnr[0].nt[0].inv_typ).toBe("SEWP");
    expect(gstr1Csv(s).cdnr[0][7]).toBe("SEZ supplies with payment");
  });

  it("3B: a supply to an SEZ is zero-rated (3.1(b)); deemed export is not", () => {
    expect(gstr3bClass(sez({}), seller).zeroRated).toBe(true);
    expect(gstr3bClass(sez({ gstTreatment: "deemed_export" }), seller).zeroRated).toBe(false);
  });
});
