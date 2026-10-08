/**
 * R-164 — Google bill check. The text below is the shape a select-all copy of Google's invoice
 * PDF gives (Invoice 5702996051, Sept 2026): amounts and labels on separate lines.
 */
import { describe, it, expect } from "vitest";
import { parseGoogleBill, checkBill, expectedPartnerBill, normDomain, type SubLite, type CustomerLite } from "./google-bill";

const PDF_TEXT = `For questions about this invoice please email collections@google.com Page 1 of 7
Invoice
Invoice number: 5702996051
₹1,020.00
₹183.60
₹1,203.60
Summary for 1 Sept 2026 - 30 Sept 2026
Pay in INR:
Subtotal in INR
Integrated GST (18%)
Total amount due in INR
Summary of costs by domain
1 Sept 2026 - 30 Sept 2026
Domain name Customer ID Amount(₹)
accesstel.in C04e9zwp8 529.20
adclues.com C00nlpovy 229.32
hindustanayinda.com C01crmkqv 8.82
Invoice Invoice number: 5702996051
Domain name Customer ID Amount(₹)
ipcapitalcorp.co.uk C00qu36m5 49.00
ai.tattvaspa.org C01o0rdg5 203.66
murli-terracotta.com C02kkljwy 0.00
`;

describe("parseGoogleBill", () => {
  const b = parseGoogleBill(PDF_TEXT);
  it("reads every domain line, multi-part TLDs and hyphens included", () => {
    expect(b.lines.map((l) => l.domain)).toEqual([
      "accesstel.in", "adclues.com", "hindustanayinda.com", "ipcapitalcorp.co.uk", "ai.tattvaspa.org", "murli-terracotta.com",
    ]);
    expect(b.lines[0]).toEqual({ domain: "accesstel.in", customerId: "C04e9zwp8", amount: 529.2 });
  });
  it("finds subtotal / GST / total by their maths when labels sit on other lines", () => {
    expect([b.subtotal, b.gst, b.total]).toEqual([1020, 183.6, 1203.6]);
    expect(b.linesTotal).toBe(1020);
    expect(b.invoiceNo).toBe("5702996051");
    expect(b.periodLabel).toBe("1 Sept 2026 - 30 Sept 2026");
  });
  it("takes the tax once when the summary is printed on two pages (real Sept 2026 bill)", () => {
    const t = ["Subtotal in INR ₹ 562,110.28", "Integrated GST (18%) ₹ 101,179.85", "Total amount due in INR ₹ 663,290.13", "Subtotal in INR ₹ 562,110.28", "Integrated GST (18%) ₹ 101,179.85", "Total in INR ₹ 663,290.13"].join(String.fromCharCode(10));
    const x = parseGoogleBill(t);
    expect([x.subtotal, x.gst, x.total]).toEqual([562110.28, 101179.85, 663290.13]);
  });
  it("does not double a page pasted twice", () => {
    expect(parseGoogleBill(PDF_TEXT + PDF_TEXT).lines).toHaveLength(6);
  });
  it("reports a domain-looking line it could not read instead of dropping it", () => {
    expect(parseGoogleBill("broken.in C01abcdef 12,3").unread).toEqual(["broken.in C01abcdef 12,3"]);
  });
});

const sub = (over: Partial<SubLite>): SubLite => ({
  id: "s1", customer_id: "c1", customer_name: "Accesstel", domain: "accesstel.in", vendor: "google",
  status: "active", seats: 3, vendor_seats: null, mrr: 750, plan: "Business Starter", ...over,
});

describe("checkBill", () => {
  const lines = parseGoogleBill(PDF_TEXT).lines;
  const subs: SubLite[] = [
    sub({}),
    sub({ id: "s2", customer_id: "c2", customer_name: "Adclues", domain: "www.AdClues.com", mrr: 200, seats: 1 }),        // billed below cost
    sub({ id: "s3", customer_id: "c3", customer_name: "Old Client", domain: "gone-away.in", mrr: 900, seats: 4 }),       // not on Google's bill
    sub({ id: "s4", customer_id: "c4", customer_name: "Cancelled Co", domain: "ipcapitalcorp.co.uk", status: "cancelled" }),
    sub({ id: "s5", customer_id: "c5", customer_name: "M365 Co", domain: "hindustanayinda.com", vendor: "microsoft" }),
  ];
  const customers: CustomerLite[] = [{ id: "c6", name: "Tattva Spa", domain: "ai.tattvaspa.org" }];
  const r = checkBill(lines, subs, customers);
  const by = (d: string) => r.rows.find((x) => x.domain === d)!;

  it("matches by domain, ignoring case and www", () => {
    expect(by("accesstel.in")).toMatchObject({ status: "ok", customerName: "Accesstel", ourMonthly: 750, margin: 220.8, seats: 3 });
    expect(by("adclues.com")).toMatchObject({ status: "loss", margin: -29.32 });
  });
  it("calls out leakage: no customer at all, or a customer with no live Google subscription", () => {
    expect(by("murli-terracotta.com").status).toBe("no_customer");
    expect(by("ipcapitalcorp.co.uk").status).toBe("no_customer"); // its only sub is cancelled
    expect(by("hindustanayinda.com").status).toBe("no_customer"); // a Microsoft sub is not a Google one
    expect(by("ai.tattvaspa.org")).toMatchObject({ status: "no_subscription", customerName: "Tattva Spa" });
    expect(r.totals.leakageCount).toBe(4);
    expect(r.totals.leakage).toBe(261.48);
  });
  it("lists what we bill that Google did not charge", () => {
    expect(r.notOnBill).toEqual([{ domain: "gone-away.in", customerName: "Old Client", ourMonthly: 900, seats: 4 }]);
  });
  it("puts the money problems first", () => {
    expect(r.rows.map((x) => x.status)).toEqual(["no_customer", "no_customer", "no_customer", "no_subscription", "loss", "ok"]);
    expect(r.rows.slice(0, 3).map((x) => x.domain)).toEqual(["ipcapitalcorp.co.uk", "hindustanayinda.com", "murli-terracotta.com"]); // biggest leak first
    expect(r.rows.at(-1)!.status).toBe("ok");
  });
});

describe("Net2Secure margin", () => {
  it("is ₹10 per seat per year, spread monthly, on top of Google's subtotal", () => {
    expect(expectedPartnerBill(562110.28, 1200)).toEqual({ margin: 1000, expected: 563110.28 });
    expect(expectedPartnerBill(1000, 7, 10).margin).toBe(5.83);
  });
  it("normalises domains", () => {
    expect(normDomain(" https://www.Example.co.in/path ")).toBe("example.co.in");
  });
});

describe("making the missing customer + subscription from the bill", async () => {
  const { newSubscriptionRow, nameFromDomain } = await import("./google-bill");
  const base = { tenantId: "t", customerId: "c", customerName: "Freight Tiger", domain: "WWW.FreightTiger.com", plan: "Business Starter", syncedAt: "2026-10-05T00:00:00Z" };
  it("spreads Google's monthly cost over the users and bills the selling price", () => {
    const r = newSubscriptionRow({ ...base, users: 4, sellPerUserMonth: 270, googleCostMonth: 1058.4 });
    expect(r).toMatchObject({ domain: "freighttiger.com", vendor: "google", status: "active", seats: 4, vendor_seats: 4, vendor_cost_per_seat_month: 265, mrr: 1080 });
  });
  it("leaves the price at 0 when none is given, so the page asks for it instead of inventing a margin", () => {
    const r = newSubscriptionRow({ ...base, users: 0, sellPerUserMonth: null, googleCostMonth: 529.2 });
    expect(r).toMatchObject({ seats: 1, mrr: 0, vendor_cost_per_seat_month: 529 });
  });
  it("a subscription billed at ₹0 shows as needs setup, not as a loss", () => {
    const res = checkBill([{ domain: "a.in", customerId: "C1", amount: 100 }], [sub({ domain: "a.in", mrr: 0 })], []);
    expect(res.rows[0].status).toBe("needs_setup");
  });
  it("names a customer after the domain", () => {
    expect(nameFromDomain("freighttiger.com")).toBe("Freighttiger");
    expect(nameFromDomain("murli-terracotta.com")).toBe("Murli Terracotta");
    expect(nameFromDomain("ai.tattvaspa.org")).toBe("Tattvaspa");      // subdomain skipped
    expect(nameFromDomain("merrymen.co.in")).toBe("Merrymen");         // .co.in
    expect(nameFromDomain("ipcapitalcorp.co.uk")).toBe("Ipcapitalcorp");
    expect(nameFromDomain("samruddha.co.ke")).toBe("Samruddha");
    expect(nameFromDomain("gcs.in.net")).toBe("Gcs");                  // a 2-letter label is never the company
  });
});

/**
 * R-320 — "Add all missing" made every subscription "Google Workspace", 1 user, ₹0. The bill's
 * edition and quantity (Google's invoice CSV) now reach the subscription, priced from the tenant
 * catalogue's list price; an unknown edition or a missing catalogue row stays unpriced, never ₹0
 * passed off as a price and never an invented one.
 */
describe("R-320: edition, seats and price from the bill", async () => {
  const { billEditionOf, parseGoogleBillCsv, draftFromBill, catalogPriceForEdition, newSubscriptionRow } = await import("./google-bill");

  const CSV = [
    "Domain name,Customer ID,Description,Order name,Interval,Quantity,Amount",
    "accesstel.in,C04e9zwp8,Google Workspace Business Starter - Annual Plan (Monthly Payment),Commitment,1 Sep - 30 Sep,5,\"1,323.00\"",
    "accesstel.in,C04e9zwp8,Google Workspace Business Starter - Annual Plan (Monthly Payment),Commitment,15 Sep - 30 Sep,7,84.00",
    "adclues.com,C00nlpovy,Google Workspace Business Standard - Flexible Plan,Flexible,1 Sep - 30 Sep,3,\"2,646.00\"",
    "mixed.in,C01mixxxx,Google Workspace Business Starter,Commitment,1 Sep - 30 Sep,2,529.20",
    "mixed.in,C01mixxxx,Google Workspace Business Plus,Commitment,1 Sep - 30 Sep,1,1218.00",
    "vaultonly.com,C01vaultx,Google Vault,Flexible,1 Sep - 30 Sep,2,400.00",
  ].join("\n");

  it("reads the edition from Google's SKU descriptions, and nothing it cannot name", () => {
    expect(billEditionOf("Google Workspace Business Starter - Annual Plan")).toBe("Business Starter");
    expect(billEditionOf("Google Workspace Business Plus")).toBe("Business Plus");
    expect(billEditionOf("Google Workspace Enterprise Standard")).toBe("Enterprise Standard");
    expect(billEditionOf("G Suite Basic")).toBeNull();
    expect(billEditionOf("Google Vault")).toBeNull();
    expect(billEditionOf("Google Workspace Archived User")).toBeNull();
    expect(billEditionOf("Google Workspace")).toBeNull();
  });

  it("a CSV bill gives each domain its edition and seats; mixed editions stay unknown", () => {
    const b = parseGoogleBill(CSV);
    expect(b).toEqual(parseGoogleBillCsv(CSV));
    const by = (d: string) => b.lines.find((l) => l.domain === d)!;
    // two rows of the same edition = a mid-month change → the larger quantity, amounts added
    expect(by("accesstel.in")).toEqual({ domain: "accesstel.in", customerId: "C04e9zwp8", amount: 1407, plan: "Business Starter", seats: 7 });
    expect(by("adclues.com")).toMatchObject({ plan: "Business Standard", seats: 3, amount: 2646 });
    expect(by("mixed.in")).toMatchObject({ plan: null, seats: null, amount: 1747.2 });
    expect(by("vaultonly.com")).toMatchObject({ plan: null, seats: null, amount: 400 });
    expect(b.linesTotal).toBe(6200.2);
  });

  it("the PDF names no edition — its lines carry none, and the rows say so", () => {
    const pdf = parseGoogleBill(PDF_TEXT);
    expect(pdf.lines.every((l) => l.plan == null && l.seats == null)).toBe(true);
    const rows = checkBill(pdf.lines, [], []).rows;
    expect(rows.every((r) => r.billPlan === null && r.billSeats === null)).toBe(true);
  });

  const catalog = [
    // the old seed price, under the ₹270 list → floored by catalogYearlyPrice (R-205/R-387)
    { id: "it-starter", name: "Google Workspace Business Starter", vendor: "google", msrp: 136, wholesale: 120, prices: {}, item_type: "subscription", is_active: true },
    { id: "it-standard", name: "Google Workspace Business Standard", vendor: "google", msrp: 1100, wholesale: 900, prices: {}, item_type: "subscription", is_active: true },
    { id: "it-std-support", name: "Google Workspace Business Standard Support", vendor: "google", msrp: 50, wholesale: 0, prices: {}, item_type: "subscription", is_active: true },
    { id: "m365", name: "Business Plus", vendor: "microsoft", msrp: 999, wholesale: 800, prices: {}, item_type: "subscription", is_active: true },
  ];

  it("prices the edition from the catalogue list price (floor applied), not a support plan or another vendor", () => {
    expect(catalogPriceForEdition("Business Starter", catalog)).toEqual({ perSeatPm: 270, itemId: "it-starter" });
    expect(catalogPriceForEdition("Business Standard", catalog)).toEqual({ perSeatPm: 1100, itemId: "it-standard" });
    expect(catalogPriceForEdition("Business Plus", catalog)).toBeNull();          // only an M365 row by that name
    expect(catalogPriceForEdition("Google Workspace", [{ ...catalog[0], name: "Google Workspace" }])).toBeNull();
  });

  it("the subscription made from a CSV line has the edition, seats, MRR and catalogue item", () => {
    const row = checkBill(parseGoogleBill(CSV).lines, [], []).rows.find((r) => r.domain === "accesstel.in")!;
    const d = draftFromBill(row, catalog);
    expect(d).toEqual({ plan: "Business Starter", users: 7, sellPerUserMonth: 270, itemId: "it-starter", noCatalogPrice: false, editionUnknown: false });
    const sub = newSubscriptionRow({
      tenantId: "t", customerId: "c", customerName: "Accesstel", domain: row.domain, plan: d.plan, users: d.users,
      sellPerUserMonth: d.sellPerUserMonth, googleCostMonth: row.googleCost, syncedAt: "2026-10-07T00:00:00Z", itemId: d.itemId,
    });
    expect(sub).toMatchObject({ plan: "Business Starter", seats: 7, vendor_seats: 7, mrr: 1890, item_id: "it-starter", vendor_cost_per_seat_month: 201 });
  });

  it("no catalogue row → no price (flagged), never ₹0 presented as a price or an invented one", () => {
    const d = draftFromBill({ billPlan: "Business Plus", billSeats: 4 }, catalog);
    expect(d).toEqual({ plan: "Business Plus", users: 4, sellPerUserMonth: null, itemId: null, noCatalogPrice: true, editionUnknown: false });
    const sub = newSubscriptionRow({ tenantId: "t", customerId: "c", customerName: "X", domain: "x.in", plan: d.plan, users: d.users, sellPerUserMonth: d.sellPerUserMonth, googleCostMonth: 100, syncedAt: "s", itemId: d.itemId });
    expect(sub.mrr).toBe(0);
    expect(sub).not.toHaveProperty("item_id");
  });

  it("a bill with no edition (the PDF) is not priced, even with a catalogue", () => {
    expect(draftFromBill({ billPlan: null, billSeats: null }, catalog)).toEqual({
      plan: "Google Workspace", users: 1, sellPerUserMonth: null, itemId: null, noCatalogPrice: false, editionUnknown: true,
    });
  });
});
