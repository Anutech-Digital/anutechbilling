/**
 * R-2406 — choose what comes in from Zoho; open invoices already paid in the app stay out.
 * Made-up T- data only. The owner's case first: customers + subscriptions, Open invoices off.
 */
import { describe, expect, it } from "vitest";
import {
  buildImportPlan, type AppSale, type PlanInput, type ZohoContactRec, type ZohoInvoiceRec,
} from "./import-plan";
import {
  choosePlan, DEFAULT_CHOICE, monthsBefore, OPEN_INVOICES_OFF_REASON, parseChoice, summariseChoice,
} from "./import-choice";

const contact = (zohoId: string, name: string): ZohoContactRec => ({
  zohoId, name, gstin: null, gstTreatment: "business_none", placeOfContact: "DL", paymentTermsDays: null,
  email: null, phone: null, personName: null, subType: "business",
});
const invoice = (o: Partial<ZohoInvoiceRec> & { zohoId: string; number: string; zohoCustomerId: string }): ZohoInvoiceRec => ({
  date: "2026-09-01", dueDate: "2026-09-15", customerName: "T-Cust", status: "paid", total: 0, balance: 0,
  currency: "INR", gstin: null, placeOfSupply: null, subsPeriod: null, newBusiness: null, serviceExpiry: null, lines: [], ...o,
});
const subLine = (domain: string) => ({
  plan: "Google Workspace Business Starter", quantity: 5, itemTotal: 9000, rate: 1800,
  description: `Domain Name: ${domain} Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)`,
});

/** c-live: a live subscription (Apr 2026); c-recent: an open invoice (Sep 2026); c-old: last invoice 2023; c-here: already a customer. */
const input = (o: Partial<PlanInput> = {}): PlanInput => ({
  contacts: [contact("c-live", "T-Live"), contact("c-recent", "T-Recent"), contact("c-old", "T-Old"), contact("c-here", "T-Here")],
  invoices: [
    invoice({ zohoId: "i1", number: "INV-T-001", zohoCustomerId: "c-live", customerName: "T-Live", date: "2026-04-01", subsPeriod: "Yearly", total: 10620, lines: [subLine("t-live.in")] }),
    invoice({ zohoId: "i2", number: "INV-T-002", zohoCustomerId: "c-recent", customerName: "T-Recent", status: "overdue", total: 5900, balance: 5900 }),
    invoice({ zohoId: "i3", number: "INV-T-003", zohoCustomerId: "c-old", customerName: "T-Old", date: "2023-02-01", total: 1180 }),
    invoice({ zohoId: "i4", number: "INV-T-004", zohoCustomerId: "c-here", customerName: "T-Here", status: "overdue", date: "2026-08-10", total: 2360, balance: 2360 }),
  ],
  existingCustomers: [{ id: "cust-here", name: "T-Here", gstin: null }],
  existingSubscriptions: [], items: [], existingInvoiceNumbers: new Set(),
  today: "2026-11-03", since: "2024-11-03",
  ...o,
});
const plan = (o: Partial<PlanInput> = {}) => { const i = input(o); return { i, p: buildImportPlan(i) }; };

describe("parseChoice", () => {
  it("no choice sent → customers + subscriptions, open invoices OFF, last 12 months", () => {
    expect(parseChoice({})).toEqual({ customers: true, subscriptions: true, invoices: false, customerMonths: 12 });
    expect(DEFAULT_CHOICE.invoices).toBe(false);
    expect(OPEN_INVOICES_OFF_REASON).toMatch(/count the same money twice/);
  });
  it("ticks and months as sent; junk falls back to the default; 'all' = no filter", () => {
    expect(parseChoice({ parts: { customers: false, subscriptions: true, invoices: true }, customer_months: 24 }))
      .toEqual({ customers: false, subscriptions: true, invoices: true, customerMonths: 24 });
    expect(parseChoice({ parts: { invoices: "yes" }, customer_months: 7 })).toEqual(DEFAULT_CHOICE);
    expect(parseChoice({ customer_months: "all" }).customerMonths).toBeNull();
    expect(parseChoice({ customer_months: null }).customerMonths).toBeNull();
  });
  it("monthsBefore", () => {
    expect(monthsBefore("2026-11-03", 12)).toBe("2025-11-03");
  });
});

describe("choosePlan — the owner's case", () => {
  it("Customers + Subscriptions, Open invoices off: no invoice is sent, dead contacts are left out", () => {
    const { i, p } = plan();
    expect(p.invoices.map((x) => x.number)).toEqual(["INV-T-002", "INV-T-004"]);
    const c = choosePlan(p, i, DEFAULT_CHOICE);
    expect(c.invoices).toEqual([]);
    expect(c.totals.openBalance).toBe(0);
    expect(c.subscriptions.map((s) => s.domain)).toEqual(["t-live.in"]);
    /* c-old's last invoice is from 2023 → not sent; c-here is already here (matched, not created). */
    expect(c.contactRows.map((r) => r.zoho_id)).toEqual(["c-live", "c-recent", "c-here"]);
    expect(c.counts).toMatchObject({ customersNew: 2, customersLeftOut: 1, customersForOtherParts: 0, subscriptions: 1, invoices: 0 });
  });

  it("'Any time' brings every Zoho customer", () => {
    const { i, p } = plan();
    const c = choosePlan(p, i, { ...DEFAULT_CHOICE, customerMonths: null });
    expect(c.counts.customersNew).toBe(3);
    expect(c.recentSince).toBeNull();
  });

  it("Subscriptions only: the customer the subscription belongs to still comes in (and only that one)", () => {
    const { i, p } = plan();
    const c = choosePlan(p, i, { ...DEFAULT_CHOICE, customers: false });
    expect(c.contactRows.map((r) => r.zoho_id)).toEqual(["c-live"]);
    expect(c.counts).toMatchObject({ customersNew: 1, customersForOtherParts: 1, customersLeftOut: 2 });
  });

  it("Open invoices ticked: their customers come in even when older than the filter", () => {
    const { i, p } = plan({ invoices: [
      invoice({ zohoId: "i9", number: "INV-T-009", zohoCustomerId: "c-old", customerName: "T-Old", status: "overdue", date: "2023-02-01", total: 1180, balance: 1180 }),
    ] });
    const c = choosePlan(p, i, { customers: true, subscriptions: true, invoices: true, customerMonths: 6 });
    expect(c.invoices.map((x) => x.number)).toEqual(["INV-T-009"]);
    expect(c.contactRows.map((r) => r.zoho_id)).toEqual(["c-old"]);
    expect(c.totals.openBalance).toBe(1180);
  });

  it("nothing ticked → nothing to send", () => {
    const { i, p } = plan();
    const c = choosePlan(p, i, { customers: false, subscriptions: false, invoices: false, customerMonths: 12 });
    expect([c.contactRows.length, c.subscriptions.length, c.invoices.length]).toEqual([0, 0, 0]);
  });
});

describe("open invoices already paid in the app (bank reconcile)", () => {
  const sale = (o: Partial<AppSale> & { id: string }): AppSale => ({
    customerId: "cust-here", amount: 2360, paidAmount: 2360, invoiceDate: "2026-09-02", externalNumber: null, ...o,
  });

  it("a sale here carrying the Zoho number → 'already paid in the app', not imported", () => {
    const { p } = plan({ appSales: [sale({ id: "INV-APP-1", customerId: "cust-other", externalNumber: "inv-t-002" })] });
    expect(p.invoices.map((x) => x.number)).toEqual(["INV-T-004"]);
    expect(p.paidInApp).toEqual([{ number: "INV-T-002", customerName: "T-Recent", balance: 5900, appInvoice: "INV-APP-1", by: "zoho_number" }]);
    expect(p.counts.invoicesPaidInApp).toBe(1);
    expect(p.totals).toMatchObject({ openBalance: 2360, paidInAppBalance: 5900 });
  });

  it("same customer + same amount, paid, on or after the Zoho date → already paid; each sale used once", () => {
    const { p } = plan({
      invoices: [
        invoice({ zohoId: "a", number: "INV-T-010", zohoCustomerId: "c-here", customerName: "T-Here", status: "overdue", date: "2026-08-10", total: 2360, balance: 2360 }),
        invoice({ zohoId: "b", number: "INV-T-011", zohoCustomerId: "c-here", customerName: "T-Here", status: "overdue", date: "2026-08-20", total: 2360, balance: 2360 }),
      ],
      appSales: [sale({ id: "INV-APP-2" })],
    });
    expect(p.paidInApp.map((x) => [x.number, x.appInvoice, x.by])).toEqual([["INV-T-010", "INV-APP-2", "customer_amount"]]);
    expect(p.invoices.map((x) => x.number)).toEqual(["INV-T-011"]);
  });

  it("not paid, another amount, older than the Zoho invoice, or a new customer → still open", () => {
    const { p } = plan({ appSales: [
      sale({ id: "S1", paidAmount: 0 }),
      sale({ id: "S2", amount: 2400, paidAmount: 2400 }),
      sale({ id: "S3", invoiceDate: "2026-08-01" }),
      sale({ id: "S4", customerId: "cust-recent", amount: 5900, paidAmount: 5900 }),
    ] });
    expect(p.paidInApp).toEqual([]);
    expect(p.invoices.map((x) => x.number)).toEqual(["INV-T-002", "INV-T-004"]);
  });

  it("the dry run lists them", () => {
    const { i, p } = plan({ appSales: [sale({ id: "INV-APP-1", externalNumber: "INV-T-004" })] });
    const s = summariseChoice(p, choosePlan(p, i, DEFAULT_CHOICE));
    expect(s.paidInApp).toEqual({ count: 1, balance: 2360, examples: [expect.stringMatching(/^INV-T-004 · T-Here · ₹2,360 — booked here as INV-APP-1$/)] });
    expect(s.chosen.invoices).toBe(0);
  });
});
