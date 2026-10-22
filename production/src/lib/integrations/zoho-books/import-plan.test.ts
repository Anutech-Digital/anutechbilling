/**
 * R-1753 — the import plan, from the owner's own invoice rules (card examples first).
 * Fixtures are made up (T- names, example domains); GSTINs carry a computed checksum.
 */
import { describe, expect, it } from "vitest";
import {
  buildImportPlan, cycleOf, mapGstTreatment, monthsOf, parseLineDescription, subsPeriodMonths,
  summarisePlan, type PlanInput, type ZohoContactRec, type ZohoInvoiceRec, type ZohoLineRec,
} from "./import-plan";

/** A checksum-valid GSTIN from its first 14 characters (same mod-36 rule as isValidGstin). */
function gstin(first14: string): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = chars.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return first14 + chars[(36 - (sum % 36)) % 36];
}
const G_ALPHA = gstin("07AAACT1111A1Z");
const G_BETA = gstin("27AABCT2222B1Z");

const contact = (o: Partial<ZohoContactRec> & { zohoId: string; name: string }): ZohoContactRec => ({
  gstin: null, gstTreatment: null, placeOfContact: null, paymentTermsDays: null,
  email: null, phone: null, personName: null, subType: "business", ...o,
});
const line = (plan: string, quantity: number, itemTotal: number, description: string): ZohoLineRec => ({
  plan, quantity, itemTotal, rate: itemTotal / quantity, description,
});
const invoice = (o: Partial<ZohoInvoiceRec> & { zohoId: string; number: string; zohoCustomerId: string }): ZohoInvoiceRec => ({
  date: "2026-04-01", dueDate: "2026-04-15", customerName: "T-Alpha Pvt Ltd", status: "paid",
  total: 0, balance: 0, currency: "INR", gstin: null, placeOfSupply: null,
  subsPeriod: "Yearly", newBusiness: null, serviceExpiry: null, lines: [], ...o,
});

const STARTER = "Google Workspace Business Starter";
const base = (o: Partial<PlanInput> = {}): PlanInput => ({
  contacts: [contact({ zohoId: "c1", name: "T-Alpha Pvt Ltd", gstin: G_ALPHA, gstTreatment: "business_gst", placeOfContact: "DL", email: "t-accounts@t-alpha.example", personName: "T-Ravi" })],
  invoices: [],
  existingCustomers: [],
  existingSubscriptions: [],
  items: [{ name: STARTER, vendor: "google" }],
  existingInvoiceNumbers: new Set(),
  today: "2026-10-22",
  since: "2024-10-22",
  ...o,
});

describe("parseLineDescription — the owner's line text", () => {
  it("reads domain and a day-first period", () => {
    const r = parseLineDescription("Domain Name: t-alpha.in Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)");
    expect(r).toEqual({ domain: "t-alpha.in", period: { n: 1, unit: "year", start: "2026-04-01", end: "2027-03-31" } });
  });
  it("Validity Period, months, line breaks and www", () => {
    const r = parseLineDescription("Domain Name : www.T-Beta.co.in\nValidity Period: 3 Month/s (05/08/2026 - 04/11/2026)");
    expect(r.domain).toBe("t-beta.co.in");
    expect(r.period).toEqual({ n: 3, unit: "month", start: "2026-08-05", end: "2026-11-04" });
  });
  it("no period → null period", () => {
    expect(parseLineDescription("Domain Name: t-alpha.in").period).toBeNull();
  });
  it("months and cycle", () => {
    expect(monthsOf({ n: 1, unit: "year" })).toBe(12);
    expect(monthsOf({ n: 30, unit: "day" })).toBe(1);
    expect(cycleOf(1)).toBe("monthly");
    expect(cycleOf(12)).toBe("yearly");
    expect(subsPeriodMonths("One-Time")).toBe("one_time");
    expect(subsPeriodMonths("Monthly")).toBe(1);
  });
  it("Zoho GST treatment codes → ours", () => {
    expect(mapGstTreatment("business_gst")).toBe("registered_regular");
    expect(mapGstTreatment("business_none")).toBe("unregistered_business");
    expect(mapGstTreatment("consumer")).toBe("consumer");
    expect(mapGstTreatment("overseas")).toBe("overseas");
    expect(mapGstTreatment("business_sez")).toBe("sez_with_payment");
    expect(mapGstTreatment("something_else")).toBeNull();
  });
});

describe("buildImportPlan — card examples", () => {
  it("example 1: one live annual subscription t-alpha.in, 5 seats, end 31/03/2027", () => {
    const plan = buildImportPlan(base({
      invoices: [invoice({
        zohoId: "i1", number: "INV-T-001", zohoCustomerId: "c1",
        lines: [line(STARTER, 5, 9000, "Domain Name: t-alpha.in Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)")],
      })],
    }));
    expect(plan.subscriptions).toHaveLength(1);
    const s = plan.subscriptions[0];
    expect(s).toMatchObject({
      domain: "t-alpha.in", plan: STARTER, seats: 5, renewal_date: "2027-03-31", start_date: "2026-04-01",
      billing_cycle: "yearly", term_months: 12, vendor: "google", mrr: 750,
    });
    expect(plan.customers).toHaveLength(1);
    expect(plan.customers[0]).toMatchObject({ name: "T-Alpha Pvt Ltd", gstin: G_ALPHA, gst_treatment: "registered_regular", state_code: "07", state: "Delhi", contact_name: "T-Ravi" });
    expect(plan.customers[0].since).toBe("2026-04-01");
  });

  it("example 2: 2025 and 2026 lines → only the latest; since = 2025 start", () => {
    const plan = buildImportPlan(base({
      invoices: [
        invoice({ zohoId: "i0", number: "INV-T-000", zohoCustomerId: "c1", date: "2025-04-01",
          lines: [line(STARTER, 4, 7200, "Domain Name: t-alpha.in Subscription Period: 1 Year/s (01/04/2025 - 31/03/2026)")] }),
        invoice({ zohoId: "i1", number: "INV-T-001", zohoCustomerId: "c1",
          lines: [line(STARTER, 5, 9000, "Domain Name: t-alpha.in Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)")] }),
      ],
    }));
    expect(plan.subscriptions).toHaveLength(1);
    expect(plan.subscriptions[0]).toMatchObject({ seats: 5, start_date: "2025-04-01", renewal_date: "2027-03-31", source_invoice: "INV-T-001" });
  });

  it("example 3: New Business? = Pro-rata, 2 seats → 5 + 2 = 7 seats, no new subscription", () => {
    const plan = buildImportPlan(base({
      invoices: [
        invoice({ zohoId: "i1", number: "INV-T-001", zohoCustomerId: "c1",
          lines: [line(STARTER, 5, 9000, "Domain Name: t-alpha.in Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)")] }),
        invoice({ zohoId: "i2", number: "INV-T-002", zohoCustomerId: "c1", date: "2026-08-01", newBusiness: "Pro-rata",
          lines: [line(STARTER, 2, 2400, "Domain Name: t-alpha.in Subscription Period: 243 Day/s (01/08/2026 - 31/03/2027)")] }),
      ],
    }));
    expect(plan.subscriptions).toHaveLength(1);
    expect(plan.subscriptions[0]).toMatchObject({ seats: 7, prorata_seats: 2, mrr: 1050 });
  });

  it("example 4: Subs Period One-Time or no period → not a subscription; no period is a problem", () => {
    const plan = buildImportPlan(base({
      invoices: [
        invoice({ zohoId: "i3", number: "INV-T-003", zohoCustomerId: "c1", subsPeriod: "One-Time",
          lines: [line("T-Setup", 1, 5000, "Domain Name: t-alpha.in Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)")] }),
        invoice({ zohoId: "i4", number: "INV-T-004", zohoCustomerId: "c1",
          lines: [line(STARTER, 3, 5400, "Domain Name: t-gamma.in")] }),
      ],
    }));
    expect(plan.subscriptions).toHaveLength(0);
    expect(plan.counts.oneTimeInvoices).toBe(1);
    expect(plan.problems.map((p) => p.code)).toEqual(["no_period"]);
  });

  it("Service Expiry is only a fallback when the line has no period", () => {
    const plan = buildImportPlan(base({
      invoices: [invoice({ zohoId: "i5", number: "INV-T-005", zohoCustomerId: "c1", date: "2026-05-10",
        serviceExpiry: "09/05/2027", subsPeriod: "Yearly",
        lines: [line(STARTER, 2, 3600, "Domain Name: t-delta.in")] })],
    }));
    expect(plan.subscriptions[0]).toMatchObject({ domain: "t-delta.in", renewal_date: "2027-05-09", start_date: "2026-05-10", term_months: 12, from_service_expiry: true });
    // …and it never overrides the line's own period
    const plan2 = buildImportPlan(base({
      invoices: [invoice({ zohoId: "i6", number: "INV-T-006", zohoCustomerId: "c1", serviceExpiry: "01/01/2030",
        lines: [line(STARTER, 2, 3600, "Domain Name: t-delta.in Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)")] })],
    }));
    expect(plan2.subscriptions[0].renewal_date).toBe("2027-03-31");
  });

  it("example 5: GSTIN already on a customer → 'already exists', nothing new, subscription attaches to it", () => {
    const plan = buildImportPlan(base({
      existingCustomers: [{ id: "cust-1", name: "T-Alpha (old name)", gstin: G_ALPHA }],
      invoices: [invoice({ zohoId: "i1", number: "INV-T-001", zohoCustomerId: "c1",
        lines: [line(STARTER, 5, 9000, "Domain Name: t-alpha.in Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)")] })],
    }));
    expect(plan.customers).toHaveLength(0);
    expect(plan.matches.c1).toEqual({ kind: "existing", id: "cust-1", name: "T-Alpha (old name)", by: "gstin" });
    expect(plan.counts.customersExisting).toBe(1);
    expect(plan.subscriptions).toHaveLength(1);
  });

  it("re-run: the domain already has a subscription here → skipped, counted as already", () => {
    const plan = buildImportPlan(base({
      existingCustomers: [{ id: "cust-1", name: "T-Alpha Pvt Ltd", gstin: G_ALPHA }],
      existingSubscriptions: [{ domain: "t-alpha.in", customer_id: "cust-1", plan: STARTER }],
      invoices: [invoice({ zohoId: "i1", number: "INV-T-001", zohoCustomerId: "c1",
        lines: [line(STARTER, 5, 9000, "Domain Name: t-alpha.in Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)")] })],
    }));
    expect(plan.subscriptions).toHaveLength(0);
    expect(plan.counts.subscriptionsAlready).toBe(1);
  });

  it("example 6: open invoice balance 1180 → opening invoice row; already imported → skipped", () => {
    const inv = invoice({ zohoId: "i9", number: "INV-T-009", zohoCustomerId: "c1", status: "overdue",
      total: 1180, balance: 1180, date: "2023-01-10", dueDate: "2023-01-25", placeOfSupply: "DL", lines: null });
    const plan = buildImportPlan(base({ invoices: [inv] }));
    expect(plan.invoices).toEqual([{ number: "INV-T-009", invoice_date: "2023-01-10", due_date: "2023-01-25", zoho_customer_id: "c1",
      total: 1180, balance: 1180, currency: "INR", gstin: null, pos_state_code: "07" }]);
    expect(plan.totals.openBalance).toBe(1180);
    const again = buildImportPlan(base({ invoices: [inv], existingInvoiceNumbers: new Set(["INV-T-009"]) }));
    expect(again.invoices).toHaveLength(0);
    expect(again.counts.invoicesAlready).toBe(1);
  });

  it("ended subscriptions are not imported; unknown plan imports with a warning", () => {
    const plan = buildImportPlan(base({
      items: [],
      invoices: [
        invoice({ zohoId: "i1", number: "INV-T-001", zohoCustomerId: "c1",
          lines: [line("T-Mystery Plan", 1, 1200, "Domain Name: t-alpha.in Subscription Period: 1 Month/s (01/10/2026 - 31/10/2026)")] }),
        invoice({ zohoId: "i2", number: "INV-T-002", zohoCustomerId: "c1", date: "2025-01-01",
          lines: [line(STARTER, 1, 1800, "Domain Name: t-old.in Subscription Period: 1 Year/s (01/01/2025 - 31/12/2025)")] }),
      ],
    }));
    expect(plan.subscriptions).toHaveLength(1);
    expect(plan.subscriptions[0]).toMatchObject({ plan: "T-Mystery Plan", billing_cycle: "monthly", term_months: 1, mrr: 1200, vendor: "other" });
    expect(plan.counts.subscriptionsEnded).toBe(1);
    const sum = summarisePlan(plan);
    expect(sum.problems).toEqual([expect.objectContaining({ code: "unknown_plan", count: 1, blocks: false })]);
  });

  it("customer not found / missing GSTIN / two contacts with one GSTIN", () => {
    const plan = buildImportPlan(base({
      contacts: [
        contact({ zohoId: "c1", name: "T-Alpha Pvt Ltd", gstin: G_ALPHA, gstTreatment: "business_gst" }),
        contact({ zohoId: "c2", name: "T-Alpha Branch", gstin: G_ALPHA, gstTreatment: "business_gst" }),
        contact({ zohoId: "c3", name: "T-Beta LLP", gstTreatment: "business_gst" }),
        contact({ zohoId: "c4", name: "T-Gamma", gstin: G_BETA, gstTreatment: "business_gst", placeOfContact: "MH" }),
      ],
      invoices: [invoice({ zohoId: "i1", number: "INV-T-001", zohoCustomerId: "vendor-9", customerName: "T-Vendor",
        lines: [line(STARTER, 5, 9000, "Domain Name: t-vendor.in Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)")] })],
    }));
    expect(plan.customers.map((c) => c.name)).toEqual(["T-Alpha Pvt Ltd", "T-Beta LLP", "T-Gamma"]);
    expect(plan.matches.c2).toEqual({ kind: "same_as", zohoId: "c1", name: "T-Alpha Pvt Ltd", by: "gstin" });
    expect(plan.customers[1].gst_treatment).toBeNull();
    expect(plan.customers[2].state).toBe("Maharashtra");
    const codes = plan.problems.map((p) => p.code).sort();
    expect(codes).toEqual(["customer_not_found", "missing_gstin"]);
  });
});
