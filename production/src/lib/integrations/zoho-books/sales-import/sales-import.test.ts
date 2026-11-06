/**
 * R-2499 — FY 2025-26 Zoho invoices → app sales: paise → rupees, GST head, void / draft skipped,
 * books start, opening-invoice clash, rerun = already, customer / catalogue matching.
 * Zoho is never called: details are Zoho-shaped objects (R-2498 typed rows). Names are made up.
 */
import { describe, it, expect } from "vitest";
import type { ZohoFyDocDetail } from "../fy-fetch";
import { paiseToRupees, zohoSaleFacts } from "./normalise";
import { buildSalesPlan, toPick, type PlanContext } from "./plan";
import { frozenParty } from "@/lib/gst/place-of-supply";
import { buildGstr1, type Gstr1Doc } from "@/lib/gst/gstr1";

const SELLER = "07"; // Delhi

function detail(over: Partial<ZohoFyDocDetail> & { rawOver?: Record<string, unknown> } = {}): ZohoFyDocDetail {
  const { rawOver, ...rest } = over;
  const base: ZohoFyDocDetail = {
    kind: "invoices",
    id: "9000001",
    number: "INV/25-26/0001",
    date: "2025-05-10",
    status: "paid",
    contactId: "c-1",
    contactName: "Test Buyer Pvt Ltd",
    totalPaise: 1_18_000_00,      // ₹1,18,000.00
    balancePaise: 0,
    currency: "INR",
    raw: { line_items: [{ item_id: "z-item-1", name: "Cloud Seat Plan", rate: 1000 }], due_date: "2025-05-25" },
    lines: [{ accountId: "a1", accountName: "Sales", description: "100 seats", hsnOrSac: "998315", quantity: 100, amountPaise: 1_00_000_00, taxId: "t1", taxName: "IGST18", taxPercent: 18 }],
    taxes: [{ name: "IGST18", amountPaise: 18_000_00 }],
    taxTotalPaise: 18_000_00,
    tdsPaise: 0,
    gstNo: "29ABCDE1234F1Z5",
    gstTreatment: "business_gst",
    placeOfSupply: "KA",
    reverseCharge: false,
  };
  return { ...base, ...rest, raw: { ...base.raw, ...(rest.raw ?? {}), ...(rawOver ?? {}) } };
}

const intra = (over: Partial<ZohoFyDocDetail> = {}) => detail({
  gstNo: "07ABCDE1234F1Z5", placeOfSupply: "DL",
  taxes: [{ name: "CGST9", amountPaise: 9_000_00 }, { name: "SGST9", amountPaise: 9_000_00 }],
  lines: [{ accountId: "a1", accountName: "Sales", description: "", hsnOrSac: "998315", quantity: 1, amountPaise: 1_00_000_00, taxId: "g", taxName: "GST18", taxPercent: 18 }],
  ...over,
});

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
  customers: [
    { id: "cust-ka", name: "Test Buyer Pvt Ltd", gstin: "29ABCDE1234F1Z5" },
    { id: "cust-dl", name: "Delhi Buyer", gstin: "07ABCDE1234F1Z5" },
  ],
  items: [{ id: "ITEM-CSP", name: "Cloud Seat Plan" }],
  invoices: [],
  ...over,
});

describe("paise → rupees (R-2498 finding 8)", () => {
  it("divides by 100 once and rounds half up", () => {
    expect(paiseToRupees(1_18_000_00)).toBe(118000);
    expect(paiseToRupees(10050)).toBe(101);
    expect(paiseToRupees(10049)).toBe(100);
    expect(paiseToRupees(0)).toBe(0);
    expect(paiseToRupees(Number.NaN)).toBe(0);
  });

  it("an invoice's taxable, GST and total come out in whole rupees, never 100×", () => {
    const f = zohoSaleFacts(detail(), SELLER);
    expect(f.amount).toBe(118000);
    expect(f.tax).toBe(18000);
    expect(f.taxable).toBe(100000);
    expect(f.lines[0].taxable).toBe(100000);
    expect(f.lines[0].rate).toBe(1000);
    expect(f.problems).toEqual([]);
  });

  it("paise totals round once per figure; a round-off is a note, not a problem", () => {
    const f = zohoSaleFacts(detail({ totalPaise: 1180_40, taxTotalPaise: 180_06, taxes: [{ name: "IGST18", amountPaise: 180_06 }], rawOver: { adjustment: 0.34 } }), SELLER);
    // taxable = 1180.40 − 180.06 − 0.34 = 1000.00
    expect(f.taxable).toBe(1000);
    expect(f.tax).toBe(180);
    expect(f.amount).toBe(1180);
    expect(f.problems).toEqual([]);
  });

  it("an adjustment above ₹1 is not guessed", () => {
    const f = zohoSaleFacts(detail({ rawOver: { adjustment: -250 } }), SELLER);
    expect(f.problems.join(" ")).toMatch(/adjustment of ₹-250\.00/);
  });

  it("a foreign-currency invoice is booked in rupees at Zoho's exchange rate", () => {
    const f = zohoSaleFacts(detail({ currency: "USD", totalPaise: 1000_00, taxTotalPaise: 0, taxes: [], gstTreatment: "overseas", gstNo: "", placeOfSupply: "",
      lines: [{ accountId: "a", accountName: "Sales", description: "", hsnOrSac: "998315", quantity: 1, amountPaise: 1000_00, taxId: "", taxName: "", taxPercent: 0 }],
      rawOver: { exchange_rate: 83.25, line_items: [{ name: "Export Service", rate: 1000 }] } }), SELLER);
    expect(f.amount).toBe(83250);
    expect(f.taxable).toBe(83250);
    expect(f.tax).toBe(0);
    expect(f.fxRate).toBe(83.25);
    expect(f.currency).toBe("USD");
  });
});

describe("GST head — IGST vs CGST + SGST as Zoho charged it", () => {
  it("IGST on an inter-state invoice", () => {
    const f = zohoSaleFacts(detail(), SELLER);
    expect(f.head).toBe("igst");
    expect(f.posStateCode).toBe("29");
    expect(f.taxRate).toBe(18);
  });

  it("CGST + SGST on an intra-state invoice", () => {
    const f = zohoSaleFacts(intra(), SELLER);
    expect(f.head).toBe("cgst_sgst");
    expect(f.posStateCode).toBe("07");
    const plan = buildSalesPlan([f], ctx());
    expect(plan.importByMonth[0]).toMatchObject({ month: "2025-05", taxable: 100000, cgst: 9000, sgst: 9000, igst: 0 });
    expect(plan.rows[0].facts.head).toBe("cgst_sgst");
  });

  it("CGST/SGST charged to another state's place of supply is refused, not booked", () => {
    const f = zohoSaleFacts(intra({ placeOfSupply: "MH" }), SELLER);
    expect(f.problems.join(" ")).toMatch(/another state/);
  });

  it("different GST rates on one invoice are not flattened into one", () => {
    const f = zohoSaleFacts(detail({ lines: [
      { accountId: "a", accountName: "S", description: "", hsnOrSac: "1", quantity: 1, amountPaise: 50_000_00, taxId: "", taxName: "IGST18", taxPercent: 18 },
      { accountId: "a", accountName: "S", description: "", hsnOrSac: "2", quantity: 1, amountPaise: 50_000_00, taxId: "", taxName: "IGST5", taxPercent: 5 },
    ] }), SELLER);
    expect(f.taxRate).toBeNull();
    expect(f.problems.join(" ")).toMatch(/different GST rates \(5%, 18%\)/);
  });
});

describe("plan — what comes in", () => {
  it("void and draft invoices are skipped with a reason and are not in Zoho's sales totals", () => {
    const rows = [
      zohoSaleFacts(detail({ id: "1", number: "INV/25-26/0001" }), SELLER),
      zohoSaleFacts(detail({ id: "2", number: "INV/25-26/0002", status: "void" }), SELLER),
      zohoSaleFacts(detail({ id: "3", number: "INV/25-26/0003", status: "draft" }), SELLER),
    ];
    const plan = buildSalesPlan(rows, ctx());
    expect(plan.counts).toMatchObject({ scanned: 3, import: 1, skip: 2, voidOrDraft: 2 });
    expect(plan.rows[1].reason).toMatch(/Void in Zoho/);
    expect(plan.rows[2].reason).toMatch(/Draft in Zoho/);
    expect(plan.zohoByMonth).toEqual([{ month: "2025-05", count: 1, taxable: 100000, igst: 18000, cgst: 0, sgst: 0, amount: 118000 }]);
  });

  it("a date before the books start is refused", () => {
    const f = zohoSaleFacts(detail({ date: "2025-04-15" }), SELLER);
    const plan = buildSalesPlan([f], ctx({ booksStart: "2025-05-01" }));
    expect(plan.rows[0].verdict).toBe("skip");
    expect(plan.rows[0].reason).toMatch(/before the books start \(2025-05-01\)/);
  });

  it("no books start → nothing comes in", () => {
    const plan = buildSalesPlan([zohoSaleFacts(detail(), SELLER)], ctx({ booksStart: null }));
    expect(plan.rows[0].reason).toMatch(/books start date is not set/);
  });

  it("a date inside the books lock is refused", () => {
    const plan = buildSalesPlan([zohoSaleFacts(detail(), SELLER)], ctx({ lockedUntil: "2025-06-30" }));
    expect(plan.rows[0].reason).toMatch(/books lock/);
  });

  it("rerun: an invoice already imported (same Zoho id) is 'already', never a second sale", () => {
    const f = zohoSaleFacts(detail(), SELLER);
    const plan = buildSalesPlan([f], ctx({ invoices: [{ id: "INV/25-26/0001", externalNumber: "INV/25-26/0001", documentKind: "tax_invoice", zohoInvoiceId: "9000001" }] }));
    expect(plan.rows[0].verdict).toBe("already");
    expect(plan.counts.import).toBe(0);
    expect(plan.importByMonth).toEqual([]);
  });

  it("a Zoho number that is already an opening invoice is left to R-2504", () => {
    const f = zohoSaleFacts(detail(), SELLER);
    const plan = buildSalesPlan([f], ctx({ invoices: [{ id: "INV/25-26/0001", externalNumber: "inv/25-26/0001", documentKind: "opening_invoice", zohoInvoiceId: null }] }));
    expect(plan.rows[0].verdict).toBe("skip");
    expect(plan.rows[0].reason).toMatch(/opening invoice.*R-2504/);
  });

  it("no customer in the app → skip and report (safe default)", () => {
    const f = zohoSaleFacts(detail({ contactName: "Unknown Buyer", gstNo: "" }), SELLER);
    const plan = buildSalesPlan([f], ctx());
    expect(plan.rows[0].reason).toMatch(/No app customer is named "Unknown Buyer"/);
  });

  it("customer by GSTIN first, then by name; catalogue item by line name", () => {
    const plan = buildSalesPlan([zohoSaleFacts(detail(), SELLER), zohoSaleFacts(intra({ id: "2", number: "INV/25-26/0002", gstNo: "", contactName: "delhi  buyer" }), SELLER)], ctx());
    expect(plan.rows[0]).toMatchObject({ verdict: "import", customerId: "cust-ka", matchedBy: "gstin", itemIds: ["ITEM-CSP"] });
    expect(plan.rows[1]).toMatchObject({ verdict: "import", customerId: "cust-dl", matchedBy: "name" });
    // The pick carries no money — the SQL reads every amount from the server's scan.
    expect(toPick(plan.rows[0])).toEqual({ zoho_invoice_id: "9000001", customer_id: "cust-ka", item_ids: ["ITEM-CSP"] });
    expect(plan.rows[0].facts).toMatchObject({ number: "INV/25-26/0001", date: "2025-05-10", dueDate: "2025-05-25",
      taxable: 100000, tax: 18000, amount: 118000, taxRate: 18, head: "igst", posStateCode: "29", currency: "INR", appGstTreatment: "registered_regular" });
    expect(plan.rows[0].facts.lines[0]).toMatchObject({ hsn: "998315", qty: 100, taxable: 100000 });
  });
});

describe("review fixes", () => {
  const noTax = (pos: string) => detail({ placeOfSupply: pos, totalPaise: 1000_00, taxTotalPaise: 0, taxes: [],
    lines: [{ accountId: "a", accountName: "S", description: "", hsnOrSac: "1", quantity: 1, amountPaise: 1000_00, taxId: "", taxName: "", taxPercent: 0 }] });

  it("a nil / exempt sale keeps its inter- or intra-state head from the place of supply", () => {
    expect(zohoSaleFacts(noTax("KA"), SELLER).head).toBe("igst");
    expect(zohoSaleFacts(noTax("DL"), SELLER).head).toBe("none");
  });

  it("the 40% slab is a rate; a fractional rate is not rounded into a whole-number column", () => {
    const at = (pct: number) => detail({ totalPaise: (100 + pct) * 1000_00, taxTotalPaise: pct * 1000_00, taxes: [{ name: `IGST${pct}`, amountPaise: pct * 1000_00 }],
      lines: [{ accountId: "a", accountName: "S", description: "", hsnOrSac: "1", quantity: 1, amountPaise: 100 * 1000_00, taxId: "", taxName: `IGST${pct}`, taxPercent: pct }] });
    expect(zohoSaleFacts(at(40), SELLER)).toMatchObject({ taxRate: 40, problems: [] });
    expect(zohoSaleFacts(at(1.5), SELLER).problems.join(" ")).toMatch(/GST rate 1.5% is not one this app stores/);
  });

  it("an app invoice whose number is the Zoho number is caught in the preview, as the SQL does", () => {
    const plan = buildSalesPlan([zohoSaleFacts(detail(), SELLER)], ctx({ invoices: [{ id: "INV/25-26/0001", externalNumber: null, documentKind: "tax_invoice", zohoInvoiceId: null }] }));
    expect(plan.rows[0]).toMatchObject({ verdict: "skip", reason: "INV/25-26/0001 is already on app invoice INV/25-26/0001." });
  });
});

/* R-2530 (G-FY2526, found by w-cust-dupes on staging Excel): a Zoho customer whose name matches
   exactly one app customer but whose GSTIN differs was skipped as "No customer … in the app"
   (65 FY 25-26 invoices). Same PAN (GSTIN characters 3–12) = the same legal entity at another
   branch → import; a different PAN → skip with a clear reason unless the owner ticks "Use this
   customer anyway". The invoice keeps ITS OWN GSTIN and place of supply (GSTR-1 was filed from
   Zoho with them) — the SQL import writes the scan's gstin / posStateCode / head, never the
   customer's. Names and GSTINs are made up. */
describe("R-2530 — name match with a different GSTIN", () => {
  const SAME_PAN_CUST = { id: "cust-vz", name: "Vizira Media Pvt Ltd", gstin: "07AAFCV5915P1ZP" };   // Delhi
  const OTHER_PAN_CUST = { id: "cust-ab", name: "Abraf Traders", gstin: "07AAMPB0782G1ZV" };
  const base = ctx().customers;
  const c = (over: Partial<PlanContext> = {}) => ctx({ customers: [...base, SAME_PAN_CUST, OTHER_PAN_CUST], ...over });
  /* Haryana branch (06), IGST — as Zoho issued it. */
  const hrInvoice = (over: Partial<ZohoFyDocDetail> = {}) => zohoSaleFacts(detail({
    id: "7001", number: "INV/25-26/0101", contactName: "VIZIRA MEDIA PVT. LTD.", gstNo: "06AAFCV5915P1ZR", placeOfSupply: "HR", ...over,
  }), SELLER);
  const abrafInvoice = (over: Partial<ZohoFyDocDetail> = {}) => zohoSaleFacts(intra({
    id: "7002", number: "INV/25-26/0102", contactName: "Abraf Traders", gstNo: "07AAHCB0569M1ZD", ...over,
  }), SELLER);

  it("same PAN, another state's GSTIN → imported onto the one customer with that name", () => {
    const plan = buildSalesPlan([hrInvoice()], c());
    expect(plan.rows[0]).toMatchObject({ verdict: "import", customerId: "cust-vz", matchedBy: "pan", reason: null });
    // The invoice's own GSTIN / place of supply / head travel with the scan, not the customer's.
    expect(plan.rows[0].facts).toMatchObject({ gstin: "06AAFCV5915P1ZR", posStateCode: "06", head: "igst" });
    expect(toPick(plan.rows[0])).toEqual({ zoho_invoice_id: "7001", customer_id: "cust-vz", item_ids: ["ITEM-CSP"] });
    expect(plan.gstinChoices).toEqual([]);
  });

  it("different PAN, not ticked → skipped with 'Name matches … but GSTIN differs', never 'No customer'", () => {
    const plan = buildSalesPlan([abrafInvoice(), abrafInvoice({ id: "7003", number: "INV/25-26/0103" })], c());
    expect(plan.rows[0]).toMatchObject({ verdict: "skip", customerId: null });
    expect(plan.rows[0].reason).toBe('Name matches "Abraf Traders" but the GSTIN differs (invoice "07AAHCB0569M1ZD" vs customer "07AAMPB0782G1ZV") — tick "Use this customer anyway" if it is the same buyer.');
    expect(plan.rows[0].reason).not.toMatch(/No (app )?customer/);
    // One choice per Zoho customer, with what the owner needs to decide.
    expect(plan.gstinChoices).toEqual([{
      key: "abraf traders", zohoName: "Abraf Traders", customerId: "cust-ab", customerName: "Abraf Traders",
      customerGstin: "07AAMPB0782G1ZV", invoiceGstins: ["07AAHCB0569M1ZD"], count: 2, amount: 236000, chosen: false,
    }]);
    // Both invoices fall under ONE skip reason.
    expect(plan.skipReasons).toHaveLength(1);
    expect(plan.skipReasons[0].count).toBe(2);
  });

  it("different PAN, ticked → imported onto that customer; the invoice keeps its own GSTIN", () => {
    const plan = buildSalesPlan([abrafInvoice()], c({ useAnyway: { "abraf traders": "cust-ab" } }));
    expect(plan.rows[0]).toMatchObject({ verdict: "import", customerId: "cust-ab", matchedBy: "chosen", reason: null });
    expect(plan.rows[0].facts.gstin).toBe("07AAHCB0569M1ZD");
    expect(plan.gstinChoices[0]).toMatchObject({ customerId: "cust-ab", chosen: true, count: 1 });
  });

  it("a tick naming any other customer is ignored (the browser cannot pick a customer the name did not match)", () => {
    const plan = buildSalesPlan([abrafInvoice()], c({ useAnyway: { "abraf traders": "cust-dl" } }));
    expect(plan.rows[0]).toMatchObject({ verdict: "skip", customerId: null });
    expect(plan.gstinChoices[0].chosen).toBe(false);
  });

  it("a customer GSTIN with a bad checksum never 'shares' a PAN — the owner decides", () => {
    const typo = { ...SAME_PAN_CUST, gstin: "07AAFCV5915P1ZX" };   // same characters 3–12, invalid GSTIN
    const plan = buildSalesPlan([hrInvoice()], ctx({ customers: [...base, typo] }));
    expect(plan.rows[0]).toMatchObject({ verdict: "skip", customerId: null });
    expect(plan.gstinChoices[0]).toMatchObject({ customerId: "cust-vz", customerGstin: "07AAFCV5915P1ZX" });
  });

  it("an ARCHIVED customer carrying the invoice's GSTIN loses to the one active customer with that name", () => {
    const archived = { id: "cust-vz-hr-old", name: "Vizira Media Pvt Ltd", gstin: "06AAFCV5915P1ZR", active: false };
    const plan = buildSalesPlan([hrInvoice()], ctx({ customers: [...base, SAME_PAN_CUST, archived] }));
    expect(plan.rows[0]).toMatchObject({ verdict: "import", customerId: "cust-vz", matchedBy: "pan" });
  });

  it("an inactive duplicate no longer blocks: the one active customer with that name is used", () => {
    const customers = [...base, SAME_PAN_CUST, { ...SAME_PAN_CUST, id: "cust-vz-old", active: false }];
    const plan = buildSalesPlan([hrInvoice()], ctx({ customers }));
    expect(plan.rows[0]).toMatchObject({ verdict: "import", customerId: "cust-vz", matchedBy: "pan" });
    // Same for a GSTIN shared by an active and an archived customer with different names.
    const byG = buildSalesPlan([zohoSaleFacts(detail(), SELLER)], ctx({ customers: [...base, { id: "cust-ka-old", name: "Old KA Name", gstin: "29ABCDE1234F1Z5", active: false }] }));
    expect(byG.rows[0]).toMatchObject({ verdict: "import", customerId: "cust-ka", matchedBy: "gstin" });
  });

  it("two ACTIVE customers with that name still need the owner (no guess)", () => {
    const customers = [...base, SAME_PAN_CUST, { ...SAME_PAN_CUST, id: "cust-vz-2" }];
    const plan = buildSalesPlan([hrInvoice()], ctx({ customers }));
    expect(plan.rows[0].verdict).toBe("skip");
    expect(plan.rows[0].reason).toMatch(/2 customers are named "VIZIRA MEDIA PVT. LTD."/);
  });

  it("no customer by name or GSTIN → the message says both, not a bare 'No customer'", () => {
    const plan = buildSalesPlan([zohoSaleFacts(detail({ contactName: "Nobody Ltd", gstNo: "27ZZZZZ9999Z1Z5", placeOfSupply: "MH" }), SELLER)], c());
    expect(plan.rows[0].reason).toBe('No app customer is named "Nobody Ltd" or has GSTIN "27ZZZZZ9999Z1Z5" — import customers from Zoho first, then preview again.');
  });

  it("GST split follows each invoice's own place of supply: IGST for the Haryana branch, CGST + SGST for Delhi, same customer", () => {
    const hr = hrInvoice();
    const dl = zohoSaleFacts(intra({ id: "7004", number: "INV/25-26/0104", contactName: "Vizira Media Pvt Ltd", gstNo: "07AAFCV5915P1ZP" }), SELLER);
    const plan = buildSalesPlan([hr, dl], c());
    expect(plan.rows.map((r) => [r.customerId, r.matchedBy, r.facts.head])).toEqual([["cust-vz", "pan", "igst"], ["cust-vz", "gstin", "cgst_sgst"]]);
    expect(plan.importByMonth).toEqual([{ month: "2025-05", count: 2, taxable: 200000, igst: 18000, cgst: 9000, sgst: 9000, amount: 236000 }]);
  });

  it("GSTR-1 B2B shows the invoice's GSTIN and place of supply, not the customer's current one", () => {
    const f = buildSalesPlan([hrInvoice()], c()).rows[0].facts;
    /* What import_zoho_fy_sales inserts (customer_gstin / pos_state_code from the scan) and the
       snapshot trigger keeps (coalesce: a value given is never replaced by the customer's). */
    const row = { customer_gstin: f.gstin, pos_state_code: f.posStateCode, seller_state_code: SELLER, billing_address: null, customer_country: null };
    const live = { gstin: SAME_PAN_CUST.gstin, stateCode: "07", state: "Delhi", country: "India" };
    const p = frozenParty(row, live);
    const doc: Gstr1Doc = {
      id: f.number, date: f.date, docType: "invoice", customerName: SAME_PAN_CUST.name,
      customerGstin: p.gstin, customerStateCode: p.stateCode, customerState: p.state, customerCountry: p.country,
      amount: f.amount, taxableValue: f.taxable, gst: f.tax, taxRate: f.taxRate ?? 0, interState: f.head === "igst",
    };
    const g = buildGstr1([doc], { stateCode: SELLER, state: "Delhi" });
    expect(g.b2b).toHaveLength(1);
    expect(g.b2b[0]).toMatchObject({ gstin: "06AAFCV5915P1ZR", id: "INV/25-26/0101", taxable: 100000 });
    expect(g.b2b[0].pos.startsWith("06")).toBe(true);
    expect(g.b2b[0].heads).toEqual({ igst: 18000, cgst: 0, sgst: 0 });
  });
});
