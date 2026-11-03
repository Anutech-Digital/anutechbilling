/**
 * R-2402 — the bulk "Reconcile from Zoho" plan. Owner's examples from HDFC 4523 (3 Nov, done by
 * hand first — Anutech-HQ/drafts/RECON-4523/progress-2026-11-03.md): Venus / cavaathleisure.com
 * (existing subscription → none made, seats differ), Zuna (pro-rata add-on seat to the existing
 * zuna.one subscription), Crestsol (lines with different periods keep their OWN renewal; dharasa.com
 * renews 20 Oct, not the max date), NAVAS paying for RANZ (payer differs, Zoho matched by UTR →
 * recorded as paid on the customer's behalf), Sangat Printers (new customer, state from GSTIN).
 * Values are made up; Zoho is never called.
 */
import { describe, it, expect } from "vitest";
import {
  liveSubFor, planFromResult, planRow, rowsToBook, tdsRate, zohoContactInfo,
  type BulkLine, type PlanContext, type PlanSubRow,
} from "./bulk-reconcile-plan";
import type { ZohoMatchLine, ZohoPaymentMatch } from "./payment-match";

const catalog: PlanContext["catalog"] = [
  { id: "it-bs", name: "Google Workspace Business Starter", sku: "GWS-BS", vendor: "google", msrp: 2100, wholesale: 1700, prices: { annual: { msrp: 2100, wholesale: 1700 } }, is_active: true, item_type: null },
  { id: "it-std", name: "Google Workspace Business Standard", sku: "GWS-STD", vendor: "google", msrp: 8000, wholesale: 6000, prices: { annual: { msrp: 8000, wholesale: 6000 } }, is_active: true, item_type: null },
];

const customers: PlanContext["customers"] = [
  { id: "c-venus", name: "Venus Infotech", gstin: "07AAACV1234A1Z5", state_code: "07", country: "India", domain: "venus.in" },
  { id: "c-zuna", name: "Zuna Private Limited", gstin: null, state_code: "06", country: "India", domain: "zuna.one" },
  { id: "c-crest", name: "Crestsol Pvt Ltd", gstin: null, state_code: "07", country: "India", domain: "crestsol.in" },
  { id: "c-nostate", name: "No State Traders", gstin: null, state_code: null, country: "India", domain: null },
];

const subs: PlanSubRow[] = [
  { id: "s-venus-bs", customer_id: "c-venus", plan: "Google Workspace Business Starter", domain: "cavaathleisure.com", seats: 93, status: "active", start_date: "2026-08-01", renewal_date: "2027-08-01" },
  { id: "s-venus-std", customer_id: "c-venus", plan: "Google Workspace Business Standard", domain: "cavaathleisure.com", seats: 5, status: "active", start_date: "2026-08-01", renewal_date: "2027-08-01" },
  { id: "s-zuna", customer_id: "c-zuna", plan: "Google Workspace Business Starter", domain: "zuna.one", seats: 10, status: "active", start_date: "2026-05-23", renewal_date: "2027-05-23" },
  { id: "s-old", customer_id: "c-crest", plan: "Google Workspace Business Starter", domain: "old.crestsol.in", seats: 2, status: "cancelled", start_date: "2025-01-01", renewal_date: "2026-01-01" },
];

const ctx: PlanContext = { customers, subscriptions: subs, catalog, payers: [], ownNames: ["Our Own Company"] };

const zl = (over: Partial<ZohoMatchLine>): ZohoMatchLine => ({
  invoiceNumber: "INV/26-27/1000", name: "Google Workspace Business Starter", sku: "GWS-BS", qty: 1, rate: 1000, itemTotal: null,
  start: "2026-10-29", end: "2027-10-28", months: 12, domain: null, ...over,
});

function match(customer: { name: string; gstin?: string | null; zohoId?: string }, lines: ZohoMatchLine[], over: Partial<ZohoPaymentMatch> = {}, amount?: number): ZohoPaymentMatch {
  const taxable = lines.reduce((s, l) => s + l.qty * (l.rate ?? 0), 0);
  const amt = amount ?? Math.round(taxable * 1.18);
  return {
    by: "utr",
    payment: { zohoId: "pay-1", number: "8690", date: "2026-10-29", amount: amt, reference: "UTR123456789012", customerZohoId: customer.zohoId ?? "zc-1", customerName: customer.name },
    customer: { zohoId: customer.zohoId ?? "zc-1", name: customer.name, gstin: customer.gstin ?? null },
    invoices: [{ zohoId: "zi-1", number: "INV/26-27/1000", date: "2026-10-29", amountApplied: amt, total: amt, lines }],
    moreInvoices: [],
    ...over,
  };
}
const bank = (credit: number, description = "NEFT CR-HDFC0000001-VENUS INFOTECH-UTR123456789012"): BulkLine =>
  ({ id: "t-1", txnDate: "2026-10-29", credit, description, reference: null });

describe("R-2402 plan: an existing subscription for customer + domain → no new subscription", () => {
  it("Venus / cavaathleisure.com: both lines go to their own existing subscription; seat difference listed", () => {
    const lines = [
      zl({ name: "Google Workspace Business Starter", sku: "GWS-BS", qty: 100, rate: 150, domain: "cavaathleisure.com", start: "2026-10-01", end: "2026-10-31", months: 1 }),
      zl({ name: "Google Workspace Business Standard", sku: "GWS-STD", qty: 5, rate: 700, domain: "cavaathleisure.com", start: "2026-10-01", end: "2026-10-31", months: 1 }),
    ];
    const m = match({ name: "VENUS INFOTECH", gstin: "07AAACV1234A1Z5" }, lines);
    const row = planRow(bank(m.payment.amount), m, null, ctx);
    expect(row.customer).toMatchObject({ kind: "existing", id: "c-venus", by: "gstin" });
    expect(row.lines.map((l) => [l.action, l.sub?.id])).toEqual([["existing_sub", "s-venus-bs"], ["existing_sub", "s-venus-std"]]);
    expect(row.book?.createSubscription).toBe(false);
    expect(row.book?.billingCycle).toBe("monthly");
    expect(row.seatDiffs).toEqual([{ subId: "s-venus-bs", plan: "Google Workspace Business Starter", domain: "cavaathleisure.com", appSeats: 93, zohoSeats: 100 }]);
    expect(row.problems).toEqual([]);
    expect(row.ticked).toBe(true);
  });

  it("a cancelled subscription on the domain does not count — a new one is made", () => {
    expect(liveSubFor({ name: "Google Workspace Business Starter", domain: "old.crestsol.in" }, { id: "c-crest", domain: "crestsol.in" }, subs)).toBeNull();
  });
});

describe("R-2402 plan: a pro-rata add-on line books no subscription", () => {
  it("Zuna: 1 seat billed 7 months, ending the day before zuna.one renews → 'add 1 seat to …'", () => {
    const lines = [zl({ qty: 1, rate: 1050, domain: "zuna.one", start: "2026-10-29", end: "2027-05-22", months: 7 })];
    const m = match({ name: "ZUNA PRIVATE LIMITED" }, lines);
    const row = planRow(bank(m.payment.amount, "UPI/CR/554551578/ZUNA PRIVATE LIMITED/HDFC/x@okhdfc"), m, null, ctx);
    expect(row.lines[0]).toMatchObject({ action: "add_seats", sub: { id: "s-zuna" } });
    expect(row.lines[0].text).toBe("Add 1 seat to Google Workspace Business Starter (zuna.one) — no new subscription");
    expect(row.book?.createSubscription).toBe(false);
    expect(row.ticked).toBe(true);
  });
});

describe("R-2402 plan: each new subscription keeps its own dates", () => {
  it("Crestsol: crestsol.in renews 18 Sep, dharasa.com renews 20 Oct — never one max date for both; the pro-rata add-on joins the new crestsol.in one", () => {
    const lines = [
      zl({ qty: 9, rate: 1000, domain: "crestsol.in", start: "2026-09-18", end: "2027-09-17", months: 12 }),
      zl({ qty: 3, rate: 900, domain: "crestsol.in", start: "2026-10-29", end: "2027-09-17", months: 11 }),
      zl({ qty: 1, rate: 1000, domain: "dharasa.com", start: "2026-10-20", end: "2027-10-19", months: 12 }),
    ];
    const m = match({ name: "CRESTSOL PVT LTD" }, lines);
    const row = planRow(bank(m.payment.amount, "NEFT CR-ICIC0000001-CRESTSOL PVT LTD-IN42630258626558"), m, null, ctx);
    expect(row.lines.map((l) => l.action)).toEqual(["new_sub", "add_seats", "new_sub"]);
    expect(row.lines.map((l) => l.renewal)).toEqual(["2027-09-18", "2027-09-18", "2027-10-20"]);
    expect(row.book).toMatchObject({ createSubscription: true, subStart: "2026-09-18", subRenewal: "2027-09-18" });
    expect(row.book?.dateFixes).toEqual([{ name: "Google Workspace Business Starter", qty: 1, domain: "dharasa.com", start: "2026-10-20", renewal: "2027-10-20" }]);
    /* The add-on is a charge on this sale, not its own subscription. */
    expect(row.book?.lines.map((l) => l.cycle)).toEqual(["annual_yearly", "one_time", "annual_yearly"]);
    expect(row.notes.join(" ")).toContain("12 seats (9 + 3 added)");
  });

  it("new and existing on one bill: only the new line makes a subscription", () => {
    const lines = [
      zl({ qty: 10, rate: 1000, domain: "zuna.one", start: "2026-05-23", end: "2027-05-22", months: 12 }),
      zl({ qty: 2, rate: 1000, domain: "zuna.store", start: "2026-10-29", end: "2027-10-28", months: 12 }),
    ];
    const m = match({ name: "Zuna Private Limited" }, lines);
    const row = planRow(bank(m.payment.amount, "NEFT CR-X-ZUNA PRIVATE LIMITED-UTR123456789012"), m, null, ctx);
    expect(row.lines.map((l) => l.action)).toEqual(["existing_sub", "new_sub"]);
    expect(row.book).toMatchObject({ createSubscription: true, subStart: "2026-10-29", subRenewal: "2027-10-29" });
    expect(row.book?.lines.map((l) => l.cycle)).toEqual(["one_time", "annual_yearly"]);
  });
});

describe("R-2402 plan: payer differs", () => {
  const ranz = { zohoId: "zc-ranz", name: "RANZ INTERNATIONAL LLC" };
  const contact = zohoContactInfo(
    { contact_id: "zc-ranz", contact_name: "RANZ INTERNATIONAL LLC", place_of_contact: "DL", gst_treatment: "business_none", email: "ops@ranz.example", mobile: "+971 50 000 0000" },
    { zohoId: "zc-ranz", name: "RANZ INTERNATIONAL LLC", gstin: null },
  );
  const lines = [zl({ qty: 1, rate: 3240, domain: "ranz.ae", start: "2026-10-30", end: "2027-10-29", months: 12 })];

  it("matched by UTR → ticked, payer recorded as paying on the customer's behalf", () => {
    const m = match(ranz, lines);
    const row = planRow(bank(m.payment.amount, "UPI-NAVAS K-navas@oksbi-SBIN0000001-630466843630-PAY"), m, contact, ctx);
    expect(row.payer).toMatchObject({ name: "NAVAS K", differs: true, record: { relation: "third_party" } });
    expect(row.ticked).toBe(true);
  });

  it("matched only by amount + date → unticked with the reason", () => {
    const m = match(ranz, lines, { by: "amount_date" });
    const row = planRow(bank(m.payment.amount, "UPI-NAVAS K-navas@oksbi-SBIN0000001-630466843630-PAY"), m, contact, ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toMatch(/^Payer differs: the bank says NAVAS K/);
  });
});

describe("R-2402 plan: a new customer from Zoho", () => {
  it("Sangat Printers: state from the GSTIN, email / phone carried from Zoho's primary contact person", () => {
    const raw = {
      contact_id: "zc-sangat", contact_name: "SANGAT PRINTERS", gst_no: "06AAACS1688R2ZO", gst_treatment: "business_gst",
      contact_persons: [{ first_name: "Harpreet", last_name: "Singh", email: "accounts@sangat.example", mobile: "9810000000", is_primary_contact: true }],
    };
    const c = zohoContactInfo(raw, { zohoId: "zc-sangat", name: "SANGAT PRINTERS", gstin: null });
    expect(c).toMatchObject({ stateCode: "06", email: "accounts@sangat.example", phone: "9810000000", personName: "Harpreet Singh", country: "India" });
    const m = match({ zohoId: "zc-sangat", name: "SANGAT PRINTERS", gstin: "06AAACS1688R2ZO" }, [zl({ qty: 2, rate: 2000, domain: "sangat.in" })]);
    const row = planRow(bank(m.payment.amount, "NEFT CR-PUNB0000001-SANGAT PRINTERS-IN42630450351478"), m, c, ctx);
    expect(row.customer).toMatchObject({ kind: "new", name: "SANGAT PRINTERS", stateCode: "06", state: "Haryana", email: "accounts@sangat.example" });
    expect(row.lines[0].action).toBe("new_sub");
    expect(row.book?.createSubscription).toBe(true);
    expect(row.ticked).toBe(true);
  });

  it("no state in Zoho and no GSTIN → unticked: 'No state'", () => {
    const c = zohoContactInfo({ contact_id: "zc-x", contact_name: "Nowhere Co" }, { zohoId: "zc-x", name: "Nowhere Co", gstin: null });
    const m = match({ zohoId: "zc-x", name: "Nowhere Co" }, [zl({ qty: 1, rate: 1000, domain: "nowhere.in" })]);
    const row = planRow(bank(m.payment.amount, "IMPS-1234-NOWHERE CO-x"), m, c, ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems[0]).toMatch(/^No state: Zoho has no state or GSTIN for Nowhere Co/);
  });

  it("an app customer with no state → unticked too (its GST invoice would be refused)", () => {
    const m = match({ name: "No State Traders" }, [zl({ qty: 1, rate: 1000, domain: "nst.in" })]);
    const row = planRow(bank(m.payment.amount, "IMPS-1-NO STATE TRADERS-x"), m, null, ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems[0]).toMatch(/^No state: No State Traders/);
  });
});

describe("R-2402 plan: amounts", () => {
  it("sale total more than ₹1 away from bank + TDS → unticked", () => {
    const m = match({ name: "Zuna Private Limited" }, [zl({ qty: 2, rate: 1000, domain: "zuna.store" })], {}, 2000);
    const row = planRow(bank(2000, "IMPS-1-ZUNA PRIVATE LIMITED-x"), m, null, ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems[0]).toBe("Amount differs: the sale comes to ₹2,360, the bank line is ₹2,000.");
  });

  it("TDS withheld in Zoho closes the gap and is booked (2% → 194C)", () => {
    const m = match({ name: "Zuna Private Limited" }, [zl({ qty: 2, rate: 1000, domain: "zuna.store" })], {}, 2320);
    m.payment.taxWithheld = 40;
    const row = planRow(bank(2320, "IMPS-1-ZUNA PRIVATE LIMITED-x"), m, null, ctx);
    expect(row.problems).toEqual([]);
    expect(row.book).toMatchObject({ tdsAmount: 40, tdsRatePct: 2, tdsSection: "194C" });
  });

  it("₹1 off is booked as it is", () => {
    const m = match({ name: "Zuna Private Limited" }, [zl({ qty: 2, rate: 1000, domain: "zuna.store" })], {}, 2359);
    expect(planRow(bank(2359, "IMPS-1-ZUNA PRIVATE LIMITED-x"), m, null, ctx).ticked).toBe(true);
  });

  it("tdsRate snaps to 1 / 2 / 10 %", () => {
    expect(tdsRate(67, 3350)).toBe(2);
    expect(tdsRate(100, 1000)).toBe(10);
    expect(tdsRate(0, 1000)).toBeNull();
  });
});

describe("R-2402 plan: rows left out / waiting", () => {
  it("not in Zoho → left out; several Zoho payments → unticked, pick one by hand", () => {
    expect(planFromResult(bank(100), { kind: "none", utrs: [], from: "2026-10-26", to: "2026-11-01" }, null, ctx)).toBeNull();
    const several = planFromResult(bank(100), { kind: "several", by: "amount_date", candidates: [
      { zohoId: "a", number: "1", date: null, amount: 100, reference: "", customerZohoId: "", customerName: "" },
      { zohoId: "b", number: "2", date: null, amount: 100, reference: "", customerZohoId: "", customerName: "" },
    ] }, null, ctx);
    expect(several).toMatchObject({ kind: "several", ticked: false, book: null });
  });
});

describe("R-2402 idempotency: a line is never booked twice", () => {
  it("rowsToBook skips unticked, already-booked and repeated lines", () => {
    const m = match({ name: "Zuna Private Limited" }, [zl({ qty: 2, rate: 1000, domain: "zuna.store" })]);
    const a = planRow({ ...bank(m.payment.amount, "IMPS-1-ZUNA PRIVATE LIMITED-x"), id: "t-a" }, m, null, ctx);
    const b = planRow({ ...bank(m.payment.amount, "IMPS-1-ZUNA PRIVATE LIMITED-x"), id: "t-b" }, m, null, ctx);
    const c = planRow({ ...bank(m.payment.amount, "IMPS-1-ZUNA PRIVATE LIMITED-x"), id: "t-c" }, m, null, ctx);
    const picked = rowsToBook([a, b, c, a], new Set(["t-a", "t-b"]), new Set(["t-b"]));
    expect(picked.map((r) => r.txnId)).toEqual(["t-a"]);
  });
});
