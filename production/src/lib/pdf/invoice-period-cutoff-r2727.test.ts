/* R-2727 review (HIGH + MED): an issued invoice's PDF never re-prints a different period. The
   billing-rule start (followingTermStart) applies to an invoice only when the invoice was CREATED
   on/after the moment the rule went live on THIS database (app_rule_dates.from_at, written by
   migration 20261113181025 with now()) — not a hard-coded date, which staging/live, deploying on
   different days, would each get wrong. An older invoice renders exactly as before R-2727. */
import { describe, it, expect } from "vitest";
import { buildInvoicePdfProps, type TenantPdfInfo } from "./build-props";
import {
  R2727_PERIOD_RULE_KEY, invoiceUnderPeriodRule, linePeriodText, invoicePeriodSubscription,
} from "@/lib/quotes/service-period";
import type { Invoice, Quote, QuoteLineItem } from "@/lib/supabase/database.types";

const starter = { id: "renewal-1", name: "Google Workspace - Business Starter", qty: 7, rate: 3099, cost: 2000, commitment: "annual_yearly" };
/* A renewal quote of an APP-made subscription (started 26 Oct 2025, renews on 26 Oct 2026). */
const quote = {
  id: "Q-1", tenant_id: "t1", customer_name: "X", status: "sent",
  subtotal: 21693, discount_pct: 0, tax_rate: 18, amount: 25598, line_items: [starter] as unknown as QuoteLineItem[],
  created_date: "2026-10-22", expires_date: "2026-11-05", notes: null, billing_cycle: "yearly",
  is_renewal: true, is_extension: false, is_add_seats: false, is_one_off: false, extension_months: 12,
  renewal_term_date: "2026-10-26", renewal_subscription_id: "sub-1", domain: null,
} as unknown as Quote;
const tenant: TenantPdfInfo = {
  name: "T", gstin: null, email: null, phone: null, address: null, state: null, state_code: "06",
  logo_url: null, upi_vpa: null, remit_bank_name: null, remit_account_name: null,
  remit_account_number: null, remit_ifsc: null, remit_branch: null,
};
/* buildInvoicePdfProps output for this invoice (dated 13 Nov 2026) captured from the code BEFORE R-2727
   (anutech/manager-pardeep eda9bfe20 + 2, route passing the subscription domain string). */
const PRE_R2727_PROPS = "{\"invoice\":{\"id\":\"INV-1\",\"tenant_id\":\"t1\",\"customer_name\":\"X\",\"amount\":25598,\"invoice_date\":\"2026-11-13\",\"created_at\":\"2026-11-13T09:00:00.000Z\",\"status\":\"unpaid\"},\"lineItems\":[{\"id\":\"renewal-1\",\"name\":\"Google Workspace - Business Starter\",\"qty\":7,\"rate\":3099,\"cost\":2000,\"commitment\":\"annual_yearly\"}],\"periodContext\":{\"isRenewal\":true,\"isExtension\":false,\"isAddSeats\":false,\"isOneOff\":false,\"extensionMonths\":12,\"renewalTermDate\":\"2026-10-26\",\"startFallback\":\"2026-10-22\",\"domain\":\"x.in\"},\"subtotal\":21693,\"discountPct\":0,\"discount\":0,\"taxable\":21693,\"taxRate\":18,\"tax\":3905,\"total\":25598,\"interState\":false,\"customerGstin\":null,\"customerEmail\":null,\"customerAddress\":null,\"customerState\":null,\"placeOfSupply\":\"Intra-state (CGST + SGST)\",\"tenantName\":\"T\",\"tenantGstin\":null,\"tenantEmail\":null,\"tenantPhone\":null,\"tenantAddress\":null,\"tenantState\":null,\"tenantLogo\":null,\"lutNumber\":null,\"udyamNumber\":null,\"customerCountry\":null,\"currency\":null,\"exchangeRate\":null,\"fxSource\":null,\"fxDate\":null,\"termsConditions\":null,\"payMethods\":{\"line\":null,\"bank\":null,\"hasUpi\":false,\"hasBank\":false,\"hasRazorpay\":false}}";
const facts = { domain: "x.in", start_date: "2025-10-26", term_months: 12 };
/* The rule went live on this database at 10:00 UTC on 13 Nov (the migration's now()). */
const RULE_FROM = "2026-11-13T10:00:00.000Z";
const madeAt = (created_at: string, invoice_date = "2026-11-13") =>
  ({ id: "INV-1", tenant_id: "t1", customer_name: "X", amount: 25598, invoice_date, created_at, status: "unpaid" }) as unknown as Invoice;
const BEFORE = "2026-11-13T09:00:00.000Z";
const AFTER = "2026-11-13T10:00:00.001Z";

describe("invoiceUnderPeriodRule — created_at vs the rule's go-live moment", () => {
  it("the key the migration inserts", () => {
    expect(R2727_PERIOD_RULE_KEY).toBe("r2727_invoice_period_rule");
  });
  it("created before the row → old rule; on / after → new rule (Postgres '+00' timestamps too)", () => {
    expect(invoiceUnderPeriodRule({ created_at: BEFORE }, RULE_FROM)).toBe(false);
    expect(invoiceUnderPeriodRule({ created_at: RULE_FROM }, RULE_FROM)).toBe(true);
    expect(invoiceUnderPeriodRule({ created_at: AFTER }, RULE_FROM)).toBe(true);
    expect(invoiceUnderPeriodRule({ created_at: "2026-11-13 10:00:00.5+00" }, "2026-11-13 10:00:00+00")).toBe(true);
    expect(invoiceUnderPeriodRule({ created_at: "2026-11-13 09:59:59+00" }, "2026-11-13 10:00:00+00")).toBe(false);
  });
  it("no row yet (migration not applied), unreadable row, or no created_at → the old rule, never the new one", () => {
    expect(invoiceUnderPeriodRule({ created_at: AFTER }, null)).toBe(false);
    expect(invoiceUnderPeriodRule({ created_at: AFTER }, undefined)).toBe(false);
    expect(invoiceUnderPeriodRule({ created_at: AFTER }, "not a time")).toBe(false);
    expect(invoiceUnderPeriodRule({ created_at: null }, RULE_FROM)).toBe(false);
    expect(invoiceUnderPeriodRule({}, RULE_FROM)).toBe(false);
  });
  it("invoice_date plays no part: a re-dated invoice keeps the rule of the day it was made", () => {
    const old = madeAt(BEFORE, "2026-11-20");
    expect(invoicePeriodSubscription(old, RULE_FROM, { domain: null }, facts)).toBe("x.in");
    const fresh = madeAt(AFTER, "2026-11-01");
    expect(invoicePeriodSubscription(fresh, RULE_FROM, { domain: null }, facts)).toBe(facts);
  });
});

describe("invoice PDFs — old invoices byte-identical, new ones on billing's rule", () => {
  it("an invoice created BEFORE the rule went live: props byte-identical to the pre-R-2727 output (route passed the domain string)", () => {
    const now = buildInvoicePdfProps({ invoice: madeAt(BEFORE), quote, customer: null, tenant, subscriptionDomain: facts, periodRuleFrom: RULE_FROM });
    const before = buildInvoicePdfProps({ invoice: madeAt(BEFORE), quote, customer: null, tenant, subscriptionDomain: "x.in" });
    expect(JSON.stringify(now)).toBe(JSON.stringify(before));
    expect(JSON.stringify(now)).toBe(PRE_R2727_PROPS);
    /* The exact pre-R-2727 context object (keys and order of quoteLinePeriodContext before this card). */
    expect(JSON.stringify(now.periodContext)).toBe(JSON.stringify({
      isRenewal: true, isExtension: false, isAddSeats: false, isOneOff: false, extensionMonths: 12,
      renewalTermDate: "2026-10-26", startFallback: "2026-10-22", domain: "x.in",
    }));
    expect(linePeriodText(starter, now.periodContext!)).toBe("Subscription period: 1 Year (27/10/2026 – 26/10/2027)");
  });

  it("the row not there yet (migration pending / unreadable): EVERY invoice prints as before, even one created today", () => {
    const p = buildInvoicePdfProps({ invoice: madeAt(AFTER), quote, customer: null, tenant, subscriptionDomain: facts, periodRuleFrom: null });
    expect(linePeriodText(starter, p.periodContext!)).toBe("Subscription period: 1 Year (27/10/2026 – 26/10/2027)");
    const omitted = buildInvoicePdfProps({ invoice: madeAt(AFTER), quote, customer: null, tenant, subscriptionDomain: facts });
    expect(JSON.stringify(omitted.periodContext)).toBe(JSON.stringify(p.periodContext));
  });

  it("an old invoice whose quote has its own domain: no subscription domain passed, as before", () => {
    expect(invoicePeriodSubscription(madeAt(BEFORE), RULE_FROM, { domain: "own.in" }, facts)).toBeNull();
    expect(invoicePeriodSubscription({ created_at: null }, RULE_FROM, { domain: null }, facts)).toBe("x.in");
  });

  it("an invoice created ON/AFTER the rule went live: billing's rule — the term starts ON 26 Oct 2026", () => {
    const p = buildInvoicePdfProps({ invoice: madeAt(AFTER), quote, customer: null, tenant, subscriptionDomain: facts, periodRuleFrom: RULE_FROM });
    expect(linePeriodText(starter, p.periodContext!)).toBe("Subscription period: 1 Year (26/10/2026 – 25/10/2027)");
  });
});
