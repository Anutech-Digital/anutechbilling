import { describe, it, expect } from "vitest";
import { quoteAmounts, buildInvoicePdfProps, buildQuotePdfProps, type TenantPdfInfo } from "./build-props";
import type { Invoice, Quote, Customer } from "@/lib/supabase/database.types";

const tenant: TenantPdfInfo = {
  name: "Anutech", gstin: "27AABCE1234D1Z9", email: "a@x.in", phone: "+91",
  address: "Mumbai", state: "Maharashtra", state_code: "27",
  /* The STORED url. build-props never fetches it — it is sync and pure — so the renderable
     logo arrives separately as `logoDataUri`. See the two tests at the bottom of this file. */
  logo_url: "https://cdn.example/logo.png",
  /* R-038. A tenant with nothing filled in — so the invoice footer names no payment
     method at all, which is what these tests assert below. */
  upi_vpa: null,
  remit_bank_name: null, remit_account_name: null, remit_account_number: null,
  remit_ifsc: null, remit_branch: null,
};

/** The same tenant with real remittance details, for the R-038 assertions. */
const tenantWithBank: TenantPdfInfo = {
  ...tenant,
  upi_vpa: "anutech@okhdfcbank",
  remit_bank_name: "HDFC Bank",
  remit_account_name: "ANUTECH DIGITAL PVT LTD",
  remit_account_number: "50200012345678",
  remit_ifsc: "HDFC0001234",
  remit_branch: "Nehru Place",
};

describe("quoteAmounts", () => {
  it("computes discount/taxable/tax with the app's rounding", () => {
    const a = quoteAmounts({ subtotal: 100000, discount_pct: 10, tax_rate: 18, amount: 132840 });
    expect(a.discount).toBe(10000);   // round(100000 * 10%)
    expect(a.taxable).toBe(90000);    // 100000 - 10000
    expect(a.tax).toBe(16200);        // round(90000 * 18%)
    expect(a.total).toBe(132840);     // authoritative quote.amount
  });
  it("falls back total to taxable+tax when amount is null", () => {
    const a = quoteAmounts({ subtotal: 1000, discount_pct: 0, tax_rate: 18, amount: null });
    expect(a.total).toBe(1180);
  });
});

describe("buildInvoicePdfProps", () => {
  const invoice = { id: "INV-1", amount: 38232, customer_name: "Acme", tenant_id: "t1" } as Invoice;
  const quote = { subtotal: 32400, discount_pct: 0, tax_rate: 18, amount: 38232, line_items: [] } as unknown as Quote;

  /* ── R-038: payment methods come from the tenant row, never from a constant ── */
  it("names NO payment method when the tenant has configured none", () => {
    const p = buildInvoicePdfProps({ invoice, quote, customer: null, tenant });
    expect(p.payMethods?.line).toBeNull();
    expect(p.payMethods?.bank).toBeNull();
  });

  it("prints the bank block and names UPI once the tenant fills them in", () => {
    const p = buildInvoicePdfProps({ invoice, quote, customer: null, tenant: tenantWithBank });
    expect(p.payMethods?.bank?.accountNumber).toBe("50200012345678");
    expect(p.payMethods?.bank?.ifsc).toBe("HDFC0001234");
    expect(p.payMethods?.line).toBe("UPI / NEFT / RTGS accepted.");
  });

  it("does not name Razorpay unless the caller says it is configured", () => {
    // Default false: the defect was an invoice promising a gateway that may not exist.
    expect(buildInvoicePdfProps({ invoice, quote, customer: null, tenant: tenantWithBank })
      .payMethods?.line).not.toMatch(/razorpay/i);
    expect(buildInvoicePdfProps({ invoice, quote, customer: null, tenant: tenantWithBank, razorpayConfigured: true })
      .payMethods?.line).toMatch(/Razorpay/);
  });

  it("falls back to the company name as the beneficiary when none is set separately", () => {
    const p = buildInvoicePdfProps({
      invoice, quote, customer: null,
      tenant: { ...tenantWithBank, remit_account_name: null },
    });
    expect(p.payMethods?.bank?.accountName).toBe("Anutech");
  });

  it("uses quote.amount as total and derives the breakdown", () => {
    const p = buildInvoicePdfProps({ invoice, quote, customer: null, tenant });
    expect(p.total).toBe(38232);
    expect(p.subtotal).toBe(32400);
    expect(p.tax).toBe(5832);
    expect(p.interState).toBe(false); // no customer state → intra-state default
  });

  it("marks inter-state when customer state differs from tenant", () => {
    const customer = { state_code: "07", gstin: null, contact_email: null, address: null, state: "Delhi" } as unknown as Customer;
    expect(buildInvoicePdfProps({ invoice, quote, customer, tenant }).interState).toBe(true);
  });

  it("carries the quote's foreign currency onto the invoice PDF (export USD invoice)", () => {
    const usdQuote = { ...quote, currency: "USD", exchange_rate: 83 } as unknown as Quote;
    const p = buildInvoicePdfProps({ invoice, quote: usdQuote, customer: null, tenant });
    expect(p.currency).toBe("USD");
    expect(p.exchangeRate).toBe(83);
  });

  it("has no foreign currency for a domestic (₹) quote", () => {
    const p = buildInvoicePdfProps({ invoice, quote, customer: null, tenant });
    expect(p.currency ?? null).toBeNull();
  });

  it("quote-less invoice derives real GST from the inclusive amount (MONEY-5)", () => {
    // No quote (e.g. project-milestone invoice) + no persisted breakdown →
    // reverse-derive at 18% so the PDF shows real GST, not ₹0.
    const p = buildInvoicePdfProps({ invoice, quote: null, customer: null, tenant });
    expect(p.total).toBe(38232);
    expect(p.subtotal).toBe(32400);   // taxable = round(38232 × 100/118)
    expect(p.taxable).toBe(32400);
    expect(p.tax).toBe(5832);         // 38232 − 32400
    expect(p.taxRate).toBe(18);
    expect(p.lineItems).toEqual([]);
  });

  it("quote-less invoice uses the breakdown persisted on the invoice (migration 0116)", () => {
    const inv = { id: "INV-2", amount: 118000, customer_name: "Acme", tenant_id: "t1",
      taxable_value: 100000, tax_amount: 18000, tax_rate: 18, inter_state: true } as unknown as Invoice;
    const p = buildInvoicePdfProps({ invoice: inv, quote: null, customer: null, tenant });
    expect(p.taxable).toBe(100000);
    expect(p.tax).toBe(18000);
    expect(p.total).toBe(118000);
    expect(p.interState).toBe(true);  // persisted head wins
  });
});

describe("buildQuotePdfProps", () => {
  const quote = {
    id: "Q-1", customer_name: "Acme", subtotal: 10000, discount_pct: 0, tax_rate: 18, amount: 11800,
    line_items: [], created_date: "2026-01-01", expires_date: "2026-01-15", notes: null, is_renewal: false,
  } as unknown as Quote;

  it("maps fields + computes validity days from the date span", () => {
    const p = buildQuotePdfProps({ quote, customer: null, tenant });
    expect(p.quoteId).toBe("Q-1");
    expect(p.total).toBe(11800);
    expect(p.validityDays).toBe(14);
    expect(p.tenantName).toBe("Anutech");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Logo: build-props ise FETCH nahi karta — wo sync aur pure hai, aur ek image laana wahan
   hona chahiye jahan deadline aur failure sambhali ja sake, na ki ek renderer ke andar jo
   inbound-mail ke webhook par chal raha hai.
   ───────────────────────────────────────────────────────────────────────────── */
describe("quote PDF props me logo", () => {
  const quote = { id: "Q-1", customer_name: "X", subtotal: 1000, discount_pct: 0,
    tax_rate: 18, amount: 1180, line_items: [] } as unknown as Quote;

  it("resolve kiya hua data URI aage pahunchta hai", () => {
    const p = buildQuotePdfProps({ quote, customer: null, tenant, logoDataUri: "data:image/png;base64,AA" });
    expect(p.tenantLogo).toBe("data:image/png;base64,AA");
  });

  it("na diya jaye to null — tenant.logo_url CHUP-CHAAP use nahi hota", () => {
    /* Ye asli jaanch hai. `tenant.logo_url` upar fixture me maujood hai. Agar build-props use
       seedha aage bhej deta, to renderer ko ek URL milta aur wo bina kisi deadline ke network
       call kar baithta — theek wahi cheez jise `isRenderableLogo` rokta hai. */
    const p = buildQuotePdfProps({ quote, customer: null, tenant });
    expect(p.tenantLogo).toBeNull();
    expect(p.tenantLogo).not.toBe(tenant.logo_url);
  });
});

/* R-175 (6 Oct 2026): the server PDF — the one the customer is emailed — printed only
   "Inter-state (IGST)" while the in-app dialog said "Haryana (06) · IGST". Rule 46(n) wants the
   state name and code. Tenant above is Maharashtra (27). */
describe("place of supply names the state (R-175)", () => {
  const quote = { subtotal: 16320, discount_pct: 0, tax_rate: 18, amount: 19258, line_items: [] } as unknown as Quote;
  const cust = (state_code: string | null, country = "India") =>
    ({ id: "c1", name: "Local Sub Test", state_code, country, gstin: null }) as unknown as Customer;

  it("invoice to another state: 'Haryana (06) · IGST', from the code frozen at issue", () => {
    const invoice = { id: "INV-9", amount: 19258, customer_name: "X", tenant_id: "t1", inter_state: true, pos_state_code: "06" } as unknown as Invoice;
    expect(buildInvoicePdfProps({ invoice, quote, customer: cust("06"), tenant }).placeOfSupply).toBe("Haryana (06) · IGST");
  });

  it("invoice in the seller's own state: 'Maharashtra (27) · CGST + SGST'", () => {
    const invoice = { id: "INV-10", amount: 19258, customer_name: "X", tenant_id: "t1", inter_state: false, pos_state_code: "27" } as unknown as Invoice;
    expect(buildInvoicePdfProps({ invoice, quote, customer: cust("27"), tenant }).placeOfSupply).toBe("Maharashtra (27) · CGST + SGST");
  });

  it("a legacy invoice with no frozen code keeps the old wording rather than guessing", () => {
    const invoice = { id: "INV-11", amount: 19258, customer_name: "X", tenant_id: "t1", inter_state: true, pos_state_code: null } as unknown as Invoice;
    expect(buildInvoicePdfProps({ invoice, quote, customer: cust("06"), tenant }).placeOfSupply).toBe("Inter-state (IGST)");
  });

  it("an export invoice says Export and the country", () => {
    const invoice = { id: "INV-12", amount: 1000, customer_name: "X", tenant_id: "t1", inter_state: true, pos_state_code: "96" } as unknown as Invoice;
    expect(buildInvoicePdfProps({ invoice, quote, customer: cust(null, "United States"), tenant }).placeOfSupply).toMatch(/^Export · United States/);
  });

  it("a quote names the buyer's state too", () => {
    expect(buildQuotePdfProps({ quote, customer: cust("06"), tenant }).placeOfSupply).toBe("Haryana (06) · IGST");
  });
});

describe("quote Bill-to carries the state and GSTIN (R-175)", () => {
  const quote = { id: "Q-1", customer_name: "Local Sub Test", subtotal: 16320, discount_pct: 0, tax_rate: 18, amount: 19258, line_items: [], prospect_state: "Punjab" } as unknown as Quote;
  it("from the customer when there is one", () => {
    const customer = { id: "c1", name: "X", state: "Haryana", state_code: "06", gstin: "06AAAAA0000A1Z5", country: "India" } as unknown as Customer;
    const p = buildQuotePdfProps({ quote, customer, tenant });
    expect(p.customerState).toBe("Haryana");
    expect(p.customerGstin).toBe("06AAAAA0000A1Z5");
  });
  it("else the prospect state the quote was priced for", () => {
    expect(buildQuotePdfProps({ quote, customer: null, tenant }).customerState).toBe("Punjab");
  });
});

/* R-367 (7 Oct 2026): quote PDF + preview never said the default free support comes with
   the quote. build-props carries the line from the shared builder (quote-support-line). */
describe("included free support line (R-367)", () => {
  const base = { id: "Q-1", customer_name: "X", subtotal: 1000, discount_pct: 0, tax_rate: 18, amount: 1180 };
  const licence = { id: "l1", name: "Google Workspace Business Starter", qty: 1, rate: 1000, cost: 900 };

  it("no support line on the quote → 'Support: Free — Included'", () => {
    const quote = { ...base, line_items: [licence] } as unknown as Quote;
    const p = buildQuotePdfProps({ quote, customer: null, tenant });
    expect(p.includedSupport?.text).toBe("Support: Free — Included");
    expect(p.includedSupport?.planName).toBe("Free");
  });

  it("paid support plan on the quote → no included line (its priced row stands)", () => {
    const quote = { ...base, line_items: [licence,
      { id: "s1", item_id: "SUP-STANDARD-YR-abc", name: "Standard Support (Yearly)", qty: 1, rate: 9996, cost: 0 }] } as unknown as Quote;
    expect(buildQuotePdfProps({ quote, customer: null, tenant }).includedSupport).toBeNull();
  });

  it("empty quote → nothing", () => {
    const quote = { ...base, line_items: [] } as unknown as Quote;
    expect(buildQuotePdfProps({ quote, customer: null, tenant }).includedSupport).toBeNull();
  });
});
