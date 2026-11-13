/* R-2744 — an issued invoice stores each line's service period (invoices.line_items[i].service_period,
   written by the BEFORE INSERT trigger of migration 20261113210500), and every invoice surface prints
   THAT, so a re-printed GST invoice never changes when the quote or the subscription is edited later.
   An invoice without stored periods (issued before this card) prints exactly as before.

   PARITY: the SQL trigger works the period out with its own copy of the rule
   (public.invoice_line_service_period). The case list lives ONCE, in the SQL test
   (supabase/tests/r2744_invoice_line_period.test.sql), which asserts the SQL side; this file reads
   the same list and asserts the TypeScript side — so the two cannot drift silently. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  lineServicePeriod, linePeriodText, quoteLinePeriodContext, invoicePeriodSubscription,
  type LinePeriodLine, type RenewedSubscriptionFacts,
} from "./service-period";
import {
  storedLinePeriod, invoiceStoredLinePeriods, withStoredLinePeriods, STORED_PERIOD_KEY,
} from "./stored-line-period";
import { buildInvoicePdfProps, type TenantPdfInfo } from "@/lib/pdf/build-props";
import { lineDetailNotes } from "@/lib/pdf/invoice-display";
import type { Invoice, Quote, QuoteLineItem } from "@/lib/supabase/database.types";

interface ParityCase {
  name: string;
  quote: Record<string, unknown>;
  sub?: RenewedSubscriptionFacts | null;
  ruleFrom?: string | null;
  createdAt?: string;
  line: LinePeriodLine;
  expect: { from: string; to: string; months: number | null } | null;
}

function parityCases(): ParityCase[] {
  const sql = readFileSync(join(process.cwd(), "supabase/tests/r2744_invoice_line_period.test.sql"), "utf8");
  const start = sql.indexOf("$cases$[");
  const end = sql.indexOf("]$cases$");
  if (start < 0 || end < start) throw new Error("R2744 parity cases not found in the SQL test");
  return JSON.parse(sql.slice(start + "$cases$".length, end + 1)) as ParityCase[];
}

/** What an invoice surface computes today for one line (the PDF / screen path, R-2727 cutoff included). */
function computedToday(c: ParityCase) {
  const quote = { domain: null, ...c.quote };
  const sub = invoicePeriodSubscription({ created_at: c.createdAt ?? "2026-11-14T10:00:00Z" }, c.ruleFrom ?? null, quote, c.sub ?? null);
  return lineServicePeriod(c.line, quoteLinePeriodContext(quote, sub));
}

describe("R-2744 parity — TS lineServicePeriod = the SQL trigger's rule, on the SQL test's own cases", () => {
  const cases = parityCases();
  it("reads the shared case list", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });
  for (const c of cases) {
    it(c.name, () => {
      expect(computedToday(c)).toEqual(c.expect);
    });
  }
});

describe("storedLinePeriod — what one invoice line stored at issue", () => {
  it("key absent → undefined (an invoice issued before R-2744)", () => {
    expect(storedLinePeriod({ name: "x" })).toBeUndefined();
    expect(storedLinePeriod(null)).toBeUndefined();
  });
  it("explicit null → null (stored: this line has no period)", () => {
    expect(storedLinePeriod({ [STORED_PERIOD_KEY]: null })).toBeNull();
  });
  it("a valid period comes back as stored", () => {
    expect(storedLinePeriod({ service_period: { from: "2026-12-01", to: "2027-11-30", months: 12 } }))
      .toEqual({ from: "2026-12-01", to: "2027-11-30", months: 12 });
    expect(storedLinePeriod({ service_period: { from: "2026-11-14", to: "2027-03-31", months: null } }))
      .toEqual({ from: "2026-11-14", to: "2027-03-31", months: null });
  });
  it("a malformed stored value prints nothing rather than a wrong date", () => {
    expect(storedLinePeriod({ service_period: { from: "2026-02-30", to: "2027-01-01", months: 12 } })).toBeNull();
    expect(storedLinePeriod({ service_period: { from: "2027-01-01", to: "2026-01-01", months: 12 } })).toBeNull();
    expect(storedLinePeriod({ service_period: { from: "2026-01-01", to: "2026-12-31", months: 0 } })).toBeNull();
    expect(storedLinePeriod({ service_period: "2026-01-01" })).toBeNull();
  });
});

describe("invoiceStoredLinePeriods / withStoredLinePeriods", () => {
  const p = { from: "2026-12-01", to: "2027-11-30", months: 12 };
  const stamped = { line_items: [{ name: "A", service_period: p }, { name: "Setup", service_period: null }] };
  const ctx = { isRenewal: true, extensionMonths: 12, renewalTermDate: "2026-12-01", domain: "x.in" };

  it("every line stamped → the stored list; any line without the key, no lines, or not an array → null", () => {
    expect(invoiceStoredLinePeriods(stamped)).toEqual([p, null]);
    expect(invoiceStoredLinePeriods({ line_items: [{ name: "A", service_period: p }, { name: "B" }] })).toBeNull();
    expect(invoiceStoredLinePeriods({ line_items: [] })).toBeNull();
    expect(invoiceStoredLinePeriods({ line_items: null })).toBeNull();
  });

  it("stamped invoice + same number of printed lines → each printed line carries its stored period, the context says so", () => {
    const out = withStoredLinePeriods([{ name: "A" }, { name: "Setup" }], stamped, ctx);
    expect(out.lines).toEqual([{ name: "A", service_period: p }, { name: "Setup", service_period: null }]);
    expect(out.ctx).toEqual({ ...ctx, storedPeriods: true });
  });

  it("not stamped, printed line count differs, or no context → printed lines and context untouched (same objects)", () => {
    const lines = [{ name: "A" }, { name: "Setup" }];
    for (const [inv, printed, c] of [
      [{ line_items: [{ name: "A" }, { name: "Setup" }] }, lines, ctx],
      [stamped, [{ name: "A" }], ctx],
      [stamped, lines, null],
    ] as const) {
      const out = withStoredLinePeriods(printed as typeof lines, inv, c);
      expect(out.lines).toBe(printed);
      expect(out.ctx).toBe(c);
    }
  });

  it("lineServicePeriod with stored periods prints the stored dates even when the live inputs say otherwise", () => {
    const { lines, ctx: c } = withStoredLinePeriods([{ name: "A", commitment: "annual_yearly" }], { line_items: [{ service_period: p }] }, {
      ...ctx, renewalTermDate: "2027-03-01", // quote edited after issue
    });
    expect(lineServicePeriod(lines[0], c!)).toEqual(p);
    expect(linePeriodText(lines[0], c!)).toBe("Subscription period: 1 Year (01/12/2026 – 30/11/2027)");
  });

  it("a stored null prints no period line, even on a line the live rule would date", () => {
    const { lines, ctx: c } = withStoredLinePeriods([{ name: "A", commitment: "annual_yearly" }], { line_items: [{ service_period: null }] }, ctx);
    expect(lineServicePeriod(lines[0], c!)).toBeNull();
    expect(lineDetailNotes(lines[0] as QuoteLineItem, c)).toEqual(["Domain: x.in"]);
  });
});

/* The owner's path: a renewal invoice with two subscription lines, issued, then the quote and the
   subscription are edited. The PDF props must keep the issued dates. */
describe("invoice PDF (buildInvoicePdfProps) — stored periods win, old invoices unchanged", () => {
  const lines = [
    { id: "a", name: "Business Starter", qty: 2, rate: 5000, cost: 4000, commitment: "annual_yearly" },
    { id: "b", name: "Archive add-on", qty: 1, rate: 1000, cost: 800, commitment: "annual_monthly" },
  ];
  const quote = {
    id: "Q-1", tenant_id: "t1", customer_name: "X", status: "accepted",
    subtotal: 11000, discount_pct: 0, tax_rate: 18, amount: 12980, line_items: lines as unknown as QuoteLineItem[],
    created_date: "2026-11-01", is_renewal: true, is_extension: false, is_add_seats: false, is_one_off: false,
    extension_months: 12, renewal_term_date: "2026-12-01", renewal_subscription_id: "sub-1", domain: null,
  } as unknown as Quote;
  const tenant: TenantPdfInfo = {
    name: "T", gstin: null, email: null, phone: null, address: null, state: null, state_code: "06",
    logo_url: null, upi_vpa: null, remit_bank_name: null, remit_account_name: null,
    remit_account_number: null, remit_ifsc: null, remit_branch: null,
  };
  const facts = { domain: "x.in", start_date: "2025-12-01", term_months: 12 };
  const RULE_FROM = "2026-11-13T19:21:33Z";
  const issued = { from: "2026-12-01", to: "2027-11-30", months: 12 };
  const invoice = (lineItems: unknown) => ({
    id: "INV-1", tenant_id: "t1", customer_name: "X", amount: 12980, invoice_date: "2026-11-14",
    created_at: "2026-11-14T10:00:00Z", status: "pending", line_items: lineItems,
  }) as unknown as Invoice;
  const stampedInvoice = invoice(lines.map((l) => ({ ...l, service_period: issued })));

  const periods = (props: ReturnType<typeof buildInvoicePdfProps>) =>
    props.lineItems.map((li) => lineDetailNotes(li, props.periodContext).find((n) => n.startsWith("Subscription period")) ?? null);

  it("at issue: stored = what the PDF computed (no change for the customer)", () => {
    const stored = buildInvoicePdfProps({ invoice: stampedInvoice, quote, customer: null, tenant, subscriptionDomain: facts, periodRuleFrom: RULE_FROM });
    const computed = buildInvoicePdfProps({ invoice: invoice(lines), quote, customer: null, tenant, subscriptionDomain: facts, periodRuleFrom: RULE_FROM });
    expect(periods(stored)).toEqual(periods(computed));
    expect(periods(stored)).toEqual(["Subscription period: 1 Year (01/12/2026 – 30/11/2027)", "Subscription period: 1 Year (01/12/2026 – 30/11/2027)"]);
  });

  it("after the quote's renewal date and the subscription's start are edited: the stamped invoice re-prints the SAME period", () => {
    const edited = { ...quote, renewal_term_date: "2027-03-01", created_date: "2026-01-01" } as Quote;
    const p = buildInvoicePdfProps({ invoice: stampedInvoice, quote: edited, customer: null, tenant,
      subscriptionDomain: { ...facts, start_date: "2025-06-01" }, periodRuleFrom: RULE_FROM });
    expect(periods(p)).toEqual(["Subscription period: 1 Year (01/12/2026 – 30/11/2027)", "Subscription period: 1 Year (01/12/2026 – 30/11/2027)"]);
    expect(p.periodContext?.domain).toBe("x.in");
  });

  it("an invoice without stored periods: props byte-identical to before this card (no extra keys)", () => {
    const plain = buildInvoicePdfProps({ invoice: invoice(lines), quote, customer: null, tenant, subscriptionDomain: facts, periodRuleFrom: RULE_FROM });
    expect(plain.periodContext).not.toHaveProperty("storedPeriods");
    expect(plain.lineItems).toBe(quote.line_items);
    expect(JSON.stringify(plain.lineItems)).not.toContain("service_period");
  });

  it("an instalment / part invoice (its own figures, not the quote's) still prints no period", () => {
    const part = { ...stampedInvoice, amount: 5000, taxable_value: 4237, tax_amount: 763 } as Invoice;
    const p = buildInvoicePdfProps({ invoice: part, quote, customer: null, tenant, subscriptionDomain: facts, periodRuleFrom: RULE_FROM });
    expect(p.periodContext).toBeNull();
  });
});
