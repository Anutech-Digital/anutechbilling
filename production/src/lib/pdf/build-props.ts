/**
 * Server-side PDF prop builders — pure, so the /api/v1 document PDF routes
 * render the SAME invoice/quote the app shows. The amount math mirrors the
 * invoice detail page + quote detail page EXACTLY (don't diverge — a GST
 * invoice PDF is money-code):
 *
 *   discount = round(subtotal × discountPct/100)
 *   taxable  = subtotal − discount
 *   tax      = round(taxable × taxRate/100)
 *   total    = quote.amount (authoritative gross) — falls back to taxable+tax
 *
 * interState (GST head) uses the shared place-of-supply helper.
 */
import { isInterStateSupply, isExportSupply, placeOfSupplyLabel } from "../gst/place-of-supply";
import type { Invoice, Quote, Customer } from "@/lib/supabase/database.types";
import type { InvoicePDFProps } from "./InvoicePDF";
import type { QuotePDFProps } from "./QuotePDF";
import { quoteIsPaid } from "./quote-document-kind";
import { payMethods } from "./pay-methods";

/** Supplier fields needed on both PDFs (from the tenants row). */
export interface TenantPdfInfo {
  name:        string;
  gstin:       string | null;
  email:       string | null;
  phone:       string | null;
  address:     string | null;
  state:       string | null;
  state_code:  string | null;
  /**
   * REQUIRED, not optional, and that is the point: every caller has to add `logo_url` to its
   * tenant select and decide what to do about it.
   *
   * The column has been populated since July 2026 and no PDF read it until 31 Aug, because
   * the logo was never anywhere a caller could forget it. `quotes.billing_cycle` was silently
   * defaulted the same way and that one printed a twelfth of the price on a GST document.
   * A field nobody is forced to fill is a field nobody fills.
   *
   * This is the STORED URL. It is not renderable — run it through `logoDataUri()` and pass
   * the result as `logoDataUri` below.
   */
  logo_url:    string | null;
  /**
   * Remittance details for the invoice footer (R-038, migration 20260930170000).
   *
   * REQUIRED for the same reason `logo_url` is: the fixed sentence "UPI / NEFT /
   * Razorpay accepted" survived for months precisely because no caller was ever made
   * to think about what this tenant can actually be paid with. Add them to your
   * tenant select; pass nulls if the tenant has not filled them in and the footer
   * says nothing rather than something untrue.
   */
  /** tenants.upi_vpa — set means UPI is a real route, so the footer may name it. */
  upi_vpa:              string | null;
  remit_bank_name:      string | null;
  remit_account_name:   string | null;
  remit_account_number: string | null;
  remit_ifsc:           string | null;
  remit_branch:         string | null;
}

interface Amounts {
  subtotal: number; discountPct: number; discount: number;
  taxable: number; taxRate: number; tax: number; total: number;
}

/** Derive the breakdown from a quote (same rounding as the app's detail pages). */
export function quoteAmounts(quote: Pick<Quote, "subtotal" | "discount_pct" | "tax_rate" | "amount">): Amounts {
  const subtotal    = quote.subtotal ?? 0;
  const discountPct = quote.discount_pct ?? 0;
  const discount    = Math.round(subtotal * (discountPct / 100));
  const taxable     = subtotal - discount;
  const taxRate     = quote.tax_rate ?? 18;
  const tax         = Math.round(taxable * (taxRate / 100));
  const total       = quote.amount ?? (taxable + tax);
  return { subtotal, discountPct, discount, taxable, taxRate, tax, total };
}

/**
 * Breakdown from an invoice's OWN persisted columns (migration 0116) — used for
 * quote-less invoices (project-milestone invoices). Before 0116 these rendered
 * with ₹0 GST (the amount shown as fully taxable); now the real split shows.
 */
export function invoiceAmounts(inv: Pick<Invoice, "amount" | "taxable_value" | "tax_amount" | "tax_rate">): Amounts {
  const total   = inv.amount;
  const taxRate = inv.tax_rate ?? 18;
  const taxable = inv.taxable_value ?? Math.round(total * 100 / (100 + taxRate));
  const tax     = inv.tax_amount ?? (total - taxable);
  return { subtotal: taxable, discountPct: 0, discount: 0, taxable, taxRate, tax, total };
}

export function buildInvoicePdfProps(args: {
  invoice:  Invoice;
  quote:    Quote | null;
  customer: Customer | null;
  tenant:   TenantPdfInfo;
  /** The logo as a `data:` URI, from `await logoDataUri(tenant.logo_url)`. See below. */
  logoDataUri?: string | null;
  /**
   * R-038. Whether THIS tenant can take a Razorpay payment — `tenant_secrets`
   * (razorpay_key_id + razorpay_key_secret) or the deployment's own keys.
   *
   * Resolved by the caller because it is a secrets read and this module is pure. It
   * defaults to FALSE, not true: the whole defect was an invoice naming a gateway the
   * seller may not have, so the safe default is to say nothing (AGENTS.md §2).
   */
  razorpayConfigured?: boolean;
}): InvoicePDFProps {
  const { invoice, quote, customer, tenant } = args;
  // Quote-backed invoice → derive from the quote; quote-less (project-milestone)
  // invoice → use the breakdown persisted on the invoice itself (migration 0116).
  const a: Amounts = quote ? quoteAmounts(quote) : invoiceAmounts(invoice);
  const total    = quote?.amount   ?? invoice.amount;
  const subtotal = quote?.subtotal ?? a.subtotal;
  // GST head: the value persisted at issue time wins; else derive from states,
  // falling back to each party's GSTIN when a state code is missing.
  //
  // The `invoice.inter_state ??` guard matters more than the fallback: an ISSUED
  // tax invoice's head is frozen at issue time and must never be recomputed. A
  // reprinted invoice has to say what the original said, whatever we later learn
  // about the customer's state. So this only decides the head for invoices that
  // never recorded one.
  const interState = invoice.inter_state ?? isInterStateSupply(
    customer?.state_code, tenant.state_code,
    { customerGstin: customer?.gstin, sellerGstin: tenant.gstin },
  );

  return {
    invoice,
    /* A quote-less invoice carries its OWN lines (migration 20260817110000).
       Subscription instalments cannot link to their quote — build-props prefers the
       quote for every amount above, so a ₹2,360 instalment linked to its ₹28,320
       quote would print ₹28,320 — and an invoice with no description, HSN or
       quantity does not satisfy CGST Rule 46. This also fills in the project
       milestone invoices that used to print "No line items recorded". */
    lineItems:   quote?.line_items ?? invoice.line_items ?? [],
    subtotal,
    discountPct: a.discountPct,
    discount:    a.discount,
    taxable:     a.taxable,
    taxRate:     a.taxRate,
    tax:         a.tax,
    total,
    interState,
    customerGstin:   customer?.gstin ?? null,
    customerEmail:   customer?.contact_email ?? null,
    // Compose the billing address line + city (city is its own column since
    // migration 0166; old customers with city inside `address` are unaffected).
    customerAddress: [customer?.address, customer?.city].filter(Boolean).join(", ") || null,
    customerState:   customer?.state ?? null,
    /* R-175 (6 Oct 2026): Rule 46(n) — the state NAME and CODE for the place of supply. The
       in-app dialog printed "Haryana (06) · IGST" (R-043) but this builder never passed it, so
       every server PDF — the one the customer is emailed — fell back to "Inter-state (IGST)".
       Same inputs as tax-invoice-dialog: the code frozen on the invoice at issue. */
    placeOfSupply: placeOfSupplyLabel({
      posCode:    invoice.pos_state_code,
      interState,
      isExport:   isExportSupply(customer?.country ?? null),
      country:    customer?.country ?? null,
    }),
    tenantName:    tenant.name,
    tenantGstin:   tenant.gstin,
    tenantEmail:   tenant.email,
    tenantPhone:   tenant.phone,
    tenantAddress: tenant.address,
    tenantState:   tenant.state,
    tenantLogo:    args.logoDataUri ?? null,
    // Export (recipient outside India) → zero-rated display + foreign currency.
    customerCountry: customer?.country ?? null,
    // Foreign-currency display (books stay ₹). Carried on the backing quote — an
    // export client's PDF then shows the USD (etc.) equivalent, not just ₹.
    currency:      quote?.currency ?? null,
    exchangeRate:  quote?.exchange_rate ?? null,
    termsConditions: quote?.terms_conditions ?? null,
    /* R-038. Derived once, here, so the footer sentence and the bank block cannot
       disagree — and so "Razorpay" appears only when Razorpay actually exists. */
    payMethods: payMethods({
      upiVpa: tenant.upi_vpa ?? null,
      bank: {
        bankName:      tenant.remit_bank_name,
        accountName:   tenant.remit_account_name ?? tenant.name,
        accountNumber: tenant.remit_account_number,
        ifsc:          tenant.remit_ifsc,
        branch:        tenant.remit_branch,
      },
      razorpayConfigured: args.razorpayConfigured === true,
    }),
  };
}

export function buildQuotePdfProps(args: {
  quote:    Quote;
  customer: Customer | null;
  tenant:   TenantPdfInfo;
  /**
   * The logo as a `data:` URI, from `await logoDataUri(tenant.logo_url)`.
   *
   * Resolved by the CALLER because this module is pure and synchronous, and because fetching
   * an image belongs where a deadline and a failure can be handled — not inside a renderer
   * running on the inbound-mail webhook. Omitted → the document draws its monogram.
   */
  logoDataUri?: string | null;
}): QuotePDFProps {
  const { quote, customer, tenant } = args;
  const a = quoteAmounts(quote);
  const validityDays =
    quote.created_date && quote.expires_date
      ? Math.max(0, Math.round((new Date(quote.expires_date).getTime() - new Date(quote.created_date).getTime()) / 86_400_000))
      : 14;

  return {
    tenantName:    tenant.name,
    tenantGstin:   tenant.gstin,
    tenantEmail:   tenant.email,
    tenantPhone:   tenant.phone,
    tenantAddress: tenant.address,
    tenantLogo:    args.logoDataUri ?? null,
    quoteId:       quote.id,
    customerName:  quote.customer_name,
    contactName:   customer?.contact_name ?? null,
    contactEmail:  customer?.contact_email ?? null,
    contactPhone:  customer?.contact_phone ?? null,
    createdDate:   quote.created_date,
    expiresDate:   quote.expires_date,
    validityDays,
    lineItems:     quote.line_items ?? [],
    subtotal:      a.subtotal,
    discountPct:   a.discountPct,
    discount:      a.discount,
    taxable:       a.taxable,
    taxRate:       a.taxRate,
    tax:           a.tax,
    total:         a.total,
    // A quote is not yet a tax document, so unlike an invoice there is nothing
    // frozen to respect — always compute the best answer available today.
    interState:    isInterStateSupply(
      customer?.state_code, tenant.state_code,
      { customerGstin: customer?.gstin, sellerGstin: tenant.gstin },
    ),
    isExport:      isExportSupply(customer?.country),
    /* R-175: name the buyer's state, as the invoice does — today's customer, else the
       prospect state the quote was priced for. */
    placeOfSupply: placeOfSupplyLabel({
      posCode: customer?.state_code ?? (quote as { prospect_state_code?: string | null }).prospect_state_code ?? null,
      interState: isInterStateSupply(
        customer?.state_code, tenant.state_code,
        { customerGstin: customer?.gstin, sellerGstin: tenant.gstin },
      ),
    }),
    currency:      quote.currency ?? null,
    exchangeRate:  quote.exchange_rate ?? null,
    billingCycle:  quote.billing_cycle,
    notes:         quote.notes ?? undefined,
    termsConditions: quote.terms_conditions ?? null,
    isRenewal:     quote.is_renewal,
    /* R-034: the money is in, so this sheet is a record of a paid order, not an offer.
       Decided once, here, so the heading and the footer cannot disagree. */
    isPaid:        quoteIsPaid(quote),
  };
}
