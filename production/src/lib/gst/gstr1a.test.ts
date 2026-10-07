import { describe, it, expect } from "vitest";
import { buildGstr1, gstr1Json, type Gstr1Doc } from "./gstr1";
import { compareGstr1, gstr1VsBooksCsv, GSTR1_VS_BOOKS_HEADERS, isoFromJsonDate, parseGstr1Json, returnFromBooks } from "./gstr1a";

const seller = { stateCode: "07", state: "Delhi", gstin: "07AABCU9603R1ZM" };

function doc(over: Partial<Gstr1Doc>): Gstr1Doc {
  return {
    id: "INV-1", date: "2026-08-10", docType: "invoice", customerName: "Cust",
    customerGstin: null, customerStateCode: null, customerState: null,
    amount: 118000, taxableValue: 100000, gst: 18000, taxRate: 18, interState: false,
    ...over,
  };
}

const filedBooks: Gstr1Doc[] = [
  doc({ id: "INV-1", customerGstin: "27AAACR5055K1Z5", customerName: "Ravi", interState: true }),
  doc({ id: "INV-2", customerGstin: "07AAACB1234C1Z1", customerName: "Bharat", amount: 11800, taxableValue: 10000, gst: 1800 }),
  doc({ id: "INV-3", amount: 5900, taxableValue: 5000, gst: 900 }), // B2CS, intra Delhi
  doc({ id: "CN-1", docType: "credit_note", customerGstin: "07AAACB1234C1Z1", amount: -1180, taxableValue: -1000, gst: -180 }),
];

/** What was uploaded: this app's own GSTR-1 JSON, through a JSON round trip like a real file. */
function filedFile(docs: Gstr1Doc[]) {
  return JSON.parse(JSON.stringify(gstr1Json(buildGstr1(docs, seller), seller.gstin, "082026")));
}

describe("parseGstr1Json", () => {
  it("reads every document table and B2CS from the app's own export", () => {
    const p = parseGstr1Json(filedFile(filedBooks));
    expect(p.errors).toEqual([]);
    expect(p.gstin).toBe(seller.gstin);
    expect(p.fp).toBe("082026");
    expect(p.docs.map((d) => `${d.table}:${d.num}`).sort()).toEqual(["B2B:INV-1", "B2B:INV-2", "CDNR:CN-1"]);
    const inv1 = p.docs.find((d) => d.num === "INV-1")!;
    expect(inv1).toMatchObject({ date: "2026-08-10", ctin: "27AAACR5055K1Z5", pos: "27", value: 118000, taxable: 100000, rates: [18] });
    expect(inv1.heads).toEqual({ igst: 18000, cgst: 0, sgst: 0 });
    expect(p.b2cs).toEqual([{ pos: "07", rate: 18, taxable: 5000, heads: { igst: 0, cgst: 450, sgst: 450 } }]);
  });

  it("refuses a file that is not a GSTR-1", () => {
    expect(parseGstr1Json([]).errors.length).toBe(1);
    expect(parseGstr1Json({ docdata: {} }).errors[0]).toMatch(/no GSTR-1 tables/);
  });

  it("portal date DD-MM-YYYY → ISO", () => {
    expect(isoFromJsonDate("05-09-2026")).toBe("2026-09-05");
    expect(isoFromJsonDate("2026-09-05")).toBe("");
  });
});

describe("compareGstr1 (GSTR-1 vs books)", () => {
  it("books unchanged since filing → no differences", () => {
    const r = compareGstr1(parseGstr1Json(filedFile(filedBooks)), returnFromBooks(filedBooks, seller));
    expect(r.docs).toEqual([]);
    expect(r.b2cs).toEqual([]);
    expect(r.unchanged).toBe(3);
    expect(r.taxDiff).toEqual({ igst: 0, cgst: 0, sgst: 0 });
  });

  it("an invoice edited after filing → original (filed) and revised (books) figures, amend in GSTR-1A", () => {
    const now = filedBooks.map((d) => (d.id === "INV-2" ? { ...d, amount: 23600, taxableValue: 20000, gst: 3600 } : d));
    const r = compareGstr1(parseGstr1Json(filedFile(filedBooks)), returnFromBooks(now, seller));
    expect(r.docs).toHaveLength(1);
    const d = r.docs[0];
    expect(d.status).toBe("changed");
    expect(d.table).toBe("B2B");
    expect(d.num).toBe("INV-2");
    expect(d.filed).toMatchObject({ value: 11800, taxable: 10000, heads: { igst: 0, cgst: 900, sgst: 900 } });
    expect(d.books).toMatchObject({ value: 23600, taxable: 20000, heads: { igst: 0, cgst: 1800, sgst: 1800 } });
    expect(d.taxDiff).toBe(1800);
    expect(d.changes).toContain("Taxable value 10,000 → 20,000");
    expect(d.action).toMatch(/Amend this record in GSTR-1A/);
    expect(r.taxDiff).toEqual({ igst: 0, cgst: 900, sgst: 900 });
  });

  it("a note edited after filing (CDNR) is reported with its note number", () => {
    const now = filedBooks.map((d) => (d.id === "CN-1" ? { ...d, amount: -2360, taxableValue: -2000, gst: -360 } : d));
    const r = compareGstr1(parseGstr1Json(filedFile(filedBooks)), returnFromBooks(now, seller));
    expect(r.docs.map((d) => [d.table, d.num, d.status])).toEqual([["CDNR", "CN-1", "changed"]]);
    expect(r.docs[0].filed?.taxable).toBe(1000);
    expect(r.docs[0].books?.taxable).toBe(2000);
  });

  it("an invoice added after filing → add in GSTR-1A; one deleted → not in books", () => {
    const now = [...filedBooks.filter((d) => d.id !== "INV-1"), doc({ id: "INV-9", date: "2026-08-28", customerGstin: "07AAACB1234C1Z1" })];
    const r = compareGstr1(parseGstr1Json(filedFile(filedBooks)), returnFromBooks(now, seller));
    expect(r.docs.map((d) => [d.status, d.num])).toEqual([["missing_in_return", "INV-9"], ["not_in_books", "INV-1"]]);
    expect(r.docs[0].action).toMatch(/Add this record in GSTR-1A/);
    expect(r.taxDiff).toEqual({ igst: -18000, cgst: 9000, sgst: 9000 });
  });

  it("recipient GSTIN changed → cannot be fixed in GSTR-1A, says use a later GSTR-1 (B2BA)", () => {
    const now = filedBooks.map((d) => (d.id === "INV-2" ? { ...d, customerGstin: "07AAACZ9999Z1Z9" } : d));
    const r = compareGstr1(parseGstr1Json(filedFile(filedBooks)), returnFromBooks(now, seller));
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].gstinChanged).toBe(true);
    expect(r.docs[0].action).toMatch(/cannot be changed in GSTR-1A.*B2BA/);
  });

  it("B2CS totals compared by place of supply + rate", () => {
    const now = [...filedBooks, doc({ id: "INV-4", amount: 1180, taxableValue: 1000, gst: 180 })];
    const r = compareGstr1(parseGstr1Json(filedFile(filedBooks)), returnFromBooks(now, seller));
    expect(r.docs).toEqual([]);
    expect(r.b2cs).toHaveLength(1);
    expect(r.b2cs[0]).toMatchObject({ pos: "07", rate: 18, taxableDiff: 1000, taxDiff: 180 });
  });

  it("paise in the portal file are not a difference", () => {
    const f = filedFile(filedBooks);
    f.b2b[0].inv[0].val = 118000.4;
    const r = compareGstr1(parseGstr1Json(f), returnFromBooks(filedBooks, seller));
    expect(r.docs).toEqual([]);
  });

  it("CSV has one row per difference, in header order", () => {
    const now = filedBooks.map((d) => (d.id === "INV-2" ? { ...d, amount: 23600, taxableValue: 20000, gst: 3600 } : d));
    const rows = gstr1VsBooksCsv(compareGstr1(parseGstr1Json(filedFile(filedBooks)), returnFromBooks(now, seller)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(GSTR1_VS_BOOKS_HEADERS.length);
    expect(rows[0].slice(0, 3)).toEqual(["Changed after filing", "B2B", "INV-2"]);
    expect(rows[0][12]).toBe(1800);
  });
});
