/**
 * R-2419 — the plan rules that stop double bookings before "Book selected". Fixtures are shaped
 * like the six cases of the first real run on staging (3 Nov 2026, bank account 4523 — 40 rows
 * ticked, none booked): (1) a last-year invoice booked as a new sale, (2) one domain on several
 * monthly lines → a subscription each, (3) a subscription whose term already ended, (4) a big
 * shortfall called TDS, (5) an open quote of the same amount ignored, (6) possible doubles.
 * Names and amounts are made up; Zoho and the database are never called.
 */
import { describe, it, expect } from "vitest";
import {
  planAll, planRow,
  type BulkLine, type BulkMatchRow, type CustomerFacts, type PlanContext, type PlanSubRow,
} from "./bulk-reconcile-plan";
import type { ZohoMatchLine, ZohoPaymentMatch } from "./payment-match";

const TODAY = "2026-11-03";

const customers: PlanContext["customers"] = [
  { id: "c-zynk", name: "Zynk Labs", gstin: null, state_code: "07", country: "India", domain: "zynklabs.xyz" },
  { id: "c-acme", name: "Acme Tools", gstin: null, state_code: "07", country: "India", domain: "acmetools.in" },
  { id: "c-learn", name: "Learnet Academy", gstin: null, state_code: "07", country: "India", domain: "learnet.in" },
  { id: "c-inter", name: "Interspace Media", gstin: null, state_code: "07", country: "India", domain: "interspace.in" },
  { id: "c-sharp", name: "Sharp Coating", gstin: null, state_code: "07", country: "India", domain: "sharpcoat.in" },
  { id: "c-green", name: "Greentin Foods", gstin: null, state_code: "07", country: "India", domain: "greentin.in" },
  { id: "c-cava", name: "Venus Cava", gstin: null, state_code: "07", country: "India", domain: "cava.example" },
  { id: "c-chem", name: "Chemico Labs", gstin: null, state_code: "07", country: "India", domain: "chemico.in" },
  { id: "c-karma", name: "Karmaastar Exports", gstin: null, state_code: "07", country: "India", domain: "karmaastar.com" },
];

const subs: PlanSubRow[] = [
  { id: "s-cava", customer_id: "c-cava", plan: "Workspace Starter", domain: "cava.example", seats: 10, status: "active",
    start_date: "2026-04-01", renewal_date: "2027-04-01", billing_cycle: "monthly", quote_id: "Q-CAVA" },
  { id: "s-chem", customer_id: "c-chem", plan: "Workspace Starter", domain: "chemico.in", seats: 8, status: "active",
    start_date: "2026-05-01", renewal_date: "2027-05-01", billing_cycle: "yearly", quote_id: "Q-CHEM" },
  { id: "s-karma", customer_id: "c-karma", plan: "Web Hosting", domain: "karmaastar.com", seats: 1, status: "active",
    start_date: "2026-06-01", renewal_date: "2027-06-01", billing_cycle: "yearly", quote_id: "Q-KARMA" },
];

const ctx: PlanContext = { customers, subscriptions: subs, catalog: [], payers: [], ownNames: ["Our Own Company"], today: TODAY };

const zl = (over: Partial<ZohoMatchLine>): ZohoMatchLine => ({
  invoiceNumber: "INV/26-27/1000", name: "Workspace Starter", sku: null, qty: 1, rate: 1000, itemTotal: null,
  start: "2026-11-01", end: "2027-10-31", months: 12, domain: null, ...over,
});

let seq = 0;
function match(name: string, lines: ZohoMatchLine[], opt: { invoice?: string; invoiceDate?: string; amount?: number; tds?: number } = {}): ZohoPaymentMatch {
  const taxable = lines.reduce((s, l) => s + l.qty * (l.rate ?? 0), 0);
  const amt = opt.amount ?? Math.round(taxable * 1.18) - (opt.tds ?? 0);
  seq += 1;
  return {
    by: "utr",
    payment: { zohoId: `pay-${seq}`, number: String(9000 + seq), date: null, amount: amt, reference: "", customerZohoId: `z-${name}`, customerName: name, taxWithheld: opt.tds ?? 0 },
    customer: { zohoId: `z-${name}`, name, gstin: null },
    invoices: [{ zohoId: `zi-${seq}`, number: opt.invoice ?? "INV/26-27/1000", date: opt.invoiceDate ?? "2026-10-01", amountApplied: amt, total: amt, lines }],
    moreInvoices: [],
  };
}
const bank = (id: string, txnDate: string, credit: number, who: string): BulkLine =>
  ({ id, txnDate, credit, description: `NEFT CR-HDFC0000001-${who.toUpperCase()}-UTR${id}`, reference: null });
const noFacts = (customerId: string, over: Partial<CustomerFacts> = {}): CustomerFacts =>
  ({ customerId, openItems: [], openings: [], receipts: [], billed: [], ...over });
const rowOf = (line: BulkLine, m: ZohoPaymentMatch, facts: CustomerFacts | null, booksStart: string | null = null): BulkMatchRow =>
  ({ line, result: { kind: "match", match: m }, contact: null, facts, booksStart });

describe("R-2419 (a) an earlier financial year's invoice settles the opening balance — never a new sale", () => {
  const lines = [zl({ rate: 5000, start: "2025-04-01", end: "2026-03-31" })];

  it("INV/25-26/… paid in May 2026 → pays the opening invoice imported from Zoho", () => {
    const m = match("Acme Tools", lines, { invoice: "INV/25-26/0412", invoiceDate: "2025-04-01" });
    const facts = noFacts("c-acme", { openings: [{ id: "OPN-7", number: "INV/25-26/0412", date: "2025-04-01", due: 5900 }] });
    const [row] = planAll([rowOf(bank("t-a1", "2026-05-12", m.payment.amount, "Acme Tools"), m, facts)], ctx);
    expect(row.book?.kind).toBe("opening");
    expect(row.book?.opening).toMatchObject({ invoiceId: "OPN-7", number: "INV/25-26/0412", received: 5900 });
    expect(row.book?.createSubscription).toBe(false);
    expect(row.summary).toBe("Last year's invoice INV/25-26/0412 — settles its opening balance (₹5,900 due), no new sale");
    expect(row.problems).toEqual([]);
    expect(row.ticked).toBe(true);
  });

  it("no opening invoice in the app → unticked, cannot be booked as a sale, says why", () => {
    const m = match("Acme Tools", lines, { invoice: "INV/25-26/0413", invoiceDate: "2025-04-01" });
    const [row] = planAll([rowOf(bank("t-a2", "2026-05-12", m.payment.amount, "Acme Tools"), m, noFacts("c-acme"))], ctx);
    expect(row.ticked).toBe(false);
    expect(row.book).toBeNull();
    expect(row.problems[0]).toMatch(/^No opening balance: Acme Tools has no open opening invoice INV\/25-26\/0413 in the app/);
  });

  it("a Zoho number without a year, dated before the books' start → also last year's", () => {
    const m = match("Acme Tools", lines, { invoice: "INV-000412", invoiceDate: "2026-03-20" });
    const facts = noFacts("c-acme", { openings: [{ id: "OPN-8", number: "INV-000412", date: "2026-03-20", due: 5900 }] });
    const [row] = planAll([rowOf(bank("t-a3", "2026-04-10", m.payment.amount, "Acme Tools"), m, facts, "2026-04-01")], ctx);
    expect(row.book?.kind).toBe("opening");
  });

  it("a customer new from Zoho has no opening balance in the app → unticked", () => {
    const m = match("Brand New Co", lines, { invoice: "INV/25-26/0500", invoiceDate: "2025-04-01" });
    const [row] = planAll([rowOf(bank("t-a4", "2026-05-12", m.payment.amount, "Brand New Co"), m, null)], ctx);
    expect(row.book).toBeNull();
    expect(row.problems.join(" ")).toMatch(/No opening balance: Brand New Co is not in the app/);
  });
});

describe("R-2419 (b)+(c) Zynk Labs: three monthly lines of zynklabs.xyz → one subscription", () => {
  const month = (start: string, end: string) => [zl({ qty: 3, rate: 160, months: 1, domain: "zynklabs.xyz", start, end })];
  const m1 = match("Zynk Labs", month("2026-10-03", "2026-11-02"));
  const m2 = match("Zynk Labs", month("2026-10-20", "2026-11-19"));
  const m3 = match("Zynk Labs", month("2026-11-02", "2026-12-01"));
  const rows = planAll([
    rowOf(bank("t-z1", "2026-10-03", m1.payment.amount, "Zynk Labs"), m1, noFacts("c-zynk")),
    rowOf(bank("t-z2", "2026-10-20", m2.payment.amount, "Zynk Labs"), m2, noFacts("c-zynk")),
    rowOf(bank("t-z3", "2026-11-02", m3.payment.amount, "Zynk Labs"), m3, noFacts("c-zynk")),
  ], ctx);

  it("only the newest line makes the subscription", () => {
    expect(rows.flatMap((r) => r.lines.map((l) => l.action))).toEqual(["past_charge", "charge_on_new", "new_sub"]);
    expect(rows.map((r) => r.book?.createSubscription)).toEqual([false, false, true]);
    expect(rows[2].book).toMatchObject({ subStart: "2026-11-02", subRenewal: "2026-12-02", billingCycle: "monthly" });
  });

  it("the older line says it is a charge on the newest line's subscription; all three stay ticked", () => {
    expect(rows[1].lines[0].text).toBe("Charge only — the newest line for zynklabs.xyz (2 Nov 2026) makes the subscription");
    expect(rows.map((r) => r.ticked)).toEqual([true, true, true]);
  });
});

describe("R-2419 (c) never a subscription whose term has already ended", () => {
  it("Learnet: Zoho term ended 6 Oct 2026 → a past-period charge, no subscription, and the row says so", () => {
    const m = match("Learnet Academy", [zl({ qty: 4, rate: 160, months: 1, domain: "learnet.in", start: "2026-09-07", end: "2026-10-06" })]);
    const [row] = planAll([rowOf(bank("t-l1", "2026-09-08", m.payment.amount, "Learnet Academy"), m, noFacts("c-learn"))], ctx);
    expect(row.lines[0].action).toBe("past_charge");
    expect(row.lines[0].text).toBe("Term ended 6 Oct 2026 — booked as a past-period charge, no subscription");
    expect(row.book?.createSubscription).toBe(false);
    expect(row.ticked).toBe(true);
  });
});

describe("R-2419 (d) TDS only when it is 1 / 2 / 10 % of the taxable value", () => {
  it("Interspace: ₹27,599 withheld on ₹2,00,000 (13.8%) → unticked 'Short by ₹27,599'", () => {
    const m = match("Interspace Media", [zl({ qty: 1, rate: 200000, domain: "interspace.in" })], { tds: 27599 });
    const [row] = planAll([rowOf(bank("t-i1", "2026-11-01", m.payment.amount, "Interspace Media"), m, noFacts("c-inter"))], ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems[0]).toMatch(/^Short by ₹27,599: Zoho records it as TDS, but it is not 1%, 2% or 10% of the taxable ₹2,00,000/);
  });

  it("2% within ₹2 is still TDS", () => {
    const m = match("Interspace Media", [zl({ qty: 1, rate: 100000, domain: "interspace.in" })], { tds: 2001 });
    const [row] = planAll([rowOf(bank("t-i2", "2026-11-01", m.payment.amount, "Interspace Media"), m, noFacts("c-inter"))], ctx);
    expect(row.problems).toEqual([]);
    expect(row.book?.tdsAmount).toBe(2001);
  });
});

describe("R-2419 (e) an open quote of the same amount is PAID, not sold again", () => {
  const lines = [zl({ qty: 1, rate: 2572, domain: "sharpcoat.in" })];
  const item = { kind: "renewal", quoteId: "Q-A378-27-0901", invoiceId: null, docDate: "2026-10-20", due: 3035, taxable: 2572, makesSubscription: false, approvalBlock: null };

  it("Sharp Coating: ₹3,035 → pays Q-A378-27-0901", () => {
    const m = match("Sharp Coating", lines, { amount: 3035 });
    const [row] = planAll([rowOf(bank("t-s1", "2026-10-28", 3035, "Sharp Coating"), m, noFacts("c-sharp", { openItems: [item] }))], ctx);
    expect(row.book?.kind).toBe("pay_item");
    expect(row.book?.item).toMatchObject({ quoteId: "Q-A378-27-0901", invoiceId: null, due: 3035 });
    expect(row.summary).toBe("Pays open quote Q-A378-27-0901 (₹3,035 due) — no new sale");
    expect(row.ticked).toBe(true);
  });

  it("the quote is below cost and not approved → 'approve it first', nothing to book", () => {
    const m = match("Sharp Coating", lines, { amount: 3035 });
    const blocked = { ...item, approvalBlock: "Quote Q-A378-27-0901 is priced below cost and is not approved yet." };
    const [row] = planAll([rowOf(bank("t-s2", "2026-10-28", 3035, "Sharp Coating"), m, noFacts("c-sharp", { openItems: [blocked] }))], ctx);
    expect(row.ticked).toBe(false);
    expect(row.book).toBeNull();
    expect(row.problems[0]).toMatch(/^Approve Q-A378-27-0901 first: Quote Q-A378-27-0901 is priced below cost/);
  });

  it("two open items of that amount → unticked, pick one by hand", () => {
    const m = match("Sharp Coating", lines, { amount: 3035 });
    const two = [item, { ...item, quoteId: "Q-A378-27-0950" }];
    const [row] = planAll([rowOf(bank("t-s3", "2026-10-28", 3035, "Sharp Coating"), m, noFacts("c-sharp", { openItems: two }))], ctx);
    expect(row.book).toBeNull();
    expect(row.problems[0]).toMatch(/^2 open quotes \/ invoices of Sharp Coating are for ₹3,035/);
  });
});

describe("R-2419 (f) possible doubles are unticked with the reason", () => {
  it("Greentin: the same ₹9,912 was received on 15 Oct (within 35 days)", () => {
    const m = match("Greentin Foods", [zl({ qty: 1, rate: 8400, domain: "greentin.in" })]);
    expect(m.payment.amount).toBe(9912);
    const facts = noFacts("c-green", { receipts: [{ id: "pay-g", date: "2026-10-15", amount: 9912, reference: "UTR998877" }] });
    const [row] = planAll([rowOf(bank("t-g1", "2026-11-01", 9912, "Greentin Foods"), m, facts)], ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems[0]).toBe("Possible double: Greentin Foods already paid ₹9,912 on 15 Oct 2026 (ref UTR998877) — within 35 days. Check it is not this payment booked already.");
  });

  it("Venus Cava: the monthly subscription is already billed for October", () => {
    const m = match("Venus Cava", [zl({ qty: 10, rate: 3315, months: 1, domain: "cava.example", start: "2026-10-01", end: "2026-10-31" })]);
    const facts = noFacts("c-cava", { billed: [{ subId: "s-cava", start: "2026-10-01", end: "2026-10-31", invoiceId: "INV-0077" }] });
    const [row] = planAll([rowOf(bank("t-v1", "2026-10-05", m.payment.amount, "Venus Cava"), m, facts)], ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems[0]).toBe("Already billed: Workspace Starter (cava.example) has invoice INV-0077 for 1 Oct 2026 – 31 Oct 2026, the same period as this Zoho bill.");
  });

  it("Chemico: the yearly subscription is already paid till 30 Apr 2027, past the Zoho period", () => {
    const m = match("Chemico Labs", [zl({ qty: 8, rate: 2000, domain: "chemico.in", start: "2026-05-01", end: "2027-04-30" })]);
    const [row] = planAll([rowOf(bank("t-c1", "2026-10-30", m.payment.amount, "Chemico Labs"), m, noFacts("c-chem"))], ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems[0]).toBe("Already paid: Workspace Starter (chemico.in) is paid till 30 Apr 2027 in the app, and this Zoho bill is for 1 May 2026 – 30 Apr 2027 — it looks booked already.");
  });

  it("Karmaastar: a hosting line with no domain falls inside the hosting subscription the app has", () => {
    const m = match("Karmaastar Exports", [zl({ name: "Linux Hosting Plan", qty: 1, rate: 4000, start: "2026-06-01", end: "2027-05-31" })]);
    const [row] = planAll([rowOf(bank("t-k1", "2026-10-30", m.payment.amount, "Karmaastar Exports"), m, noFacts("c-karma"))], ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems[0]).toMatch(/^Already paid: Web Hosting \(karmaastar.com\) is paid till 31 May 2027/);
  });

  it("an imported subscription with no sale in the app is not proof of payment — booked as before, with a note", () => {
    const imported: PlanSubRow = { ...subs[1], id: "s-imp", quote_id: null, external_source: "zoho" };
    const c2: PlanContext = { ...ctx, subscriptions: [imported] };
    const m = match("Chemico Labs", [zl({ qty: 8, rate: 2000, domain: "chemico.in", start: "2026-05-01", end: "2027-04-30" })]);
    const [row] = planAll([rowOf(bank("t-c2", "2026-10-30", m.payment.amount, "Chemico Labs"), m, noFacts("c-chem"))], c2);
    expect(row.problems).toEqual([]);
    expect(row.notes.join(" ")).toContain("imported");
  });
});

describe("R-2419 a row read before these checks is never ticked", () => {
  it("an app customer's row without facts → unticked 'press Start again'", () => {
    const m = match("Greentin Foods", [zl({ qty: 1, rate: 8400, domain: "greentin.in" })]);
    const [row] = planAll([{ line: bank("t-x", "2026-11-01", 9912, "Greentin Foods"), result: { kind: "match", match: m }, contact: null }], ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toMatch(/Not checked for doubles/);
  });

  it("planRow without facts still plans a plain new sale (the R-2402 behaviour)", () => {
    const m = match("Greentin Foods", [zl({ qty: 1, rate: 8400, domain: "greentin.in" })]);
    const row = planRow(bank("t-y", "2026-11-01", 9912, "Greentin Foods"), m, null, ctx);
    expect(row.book?.kind).toBe("new_sale");
    expect(row.ticked).toBe(true);
  });
});
