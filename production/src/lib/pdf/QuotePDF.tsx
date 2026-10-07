/**
 * QuotePDF — server/browser-renderable PDF version of the quote preview.
 *
 * Mirrors the layout of `quote-preview-dialog.tsx` but in @react-pdf/renderer
 * primitives (Document/Page/View/Text). Used by the "Download PDF" button on
 * the quote detail page and (soon) by the email-send flow that attaches the
 * generated PDF.
 *
 * Layout (A4 portrait):
 *   1. Brand header  — tenant monogram, name, GSTIN, contact / quotation #, dates
 *   2. Bill to       — customer name + contact + place-of-supply + HSN/SAC
 *   3. Line items    — table with qty / rate / amount
 *   4. Totals        — subtotal / discount / GST split / grand total
 *   5. Notes         — optional
 *   6. Terms footer  — payment terms + validity + signoff
 *
 * Money is formatted via `pdfRupee()` so Indian lakh/crore grouping is preserved.
 */
import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
} from "@react-pdf/renderer";
import { formatDate } from "@/lib/utils";
import { pdfRupee, pdfSafeMoney } from "./pdf-money";
import { fxEquivalentLine } from "@/lib/fx/rate-source";
import { pdfText } from "./pdf-text";
import { lineDomainNote } from "./invoice-display";
import { isForeignCurrency, formatForeign } from "@/lib/currency";
import { splitIntraStateTax } from "@/lib/gst/tax-split";
import type { QuoteLineItem, LineCommitment, BillingCycle } from "@/lib/supabase/database.types";
import {
  cycleInvoicesPerYear, cycleUnitLabel, cycleScheduleLabel, cycleFromLegacyCommitment,
} from "@/lib/quotes/billing";
import { lineIsPerInvoice, perInvoiceDivisor, annualContractValue } from "./invoice-divisor";
import { isRenderableLogo } from "./logo";
import { quoteDocumentLabel } from "./quote-document-kind";
import { includedSupportLine, type IncludedSupportLine } from "./quote-support-line";

import { PDF_FONT, PDF_FONT_BOLD, registerPdfFonts } from "./fonts";
import { udyamPdfLine } from "@/lib/compliance/udyam";

/* Styles ke BANNE se pehle. `StyleSheet.create` ab hi chal jata hai, aur `PDF_FONT`
   ek `let` hai — baad me register karne par style purani value pakde rehti. */
registerPdfFonts();
// ─── Billing helpers ───────────────────────────────────────────────────────
// Frequency is a quote-level `billing_cycle` (migration 0161); a line's
// `commitment` is only its PRICE TIER (monthly-flex vs annual).

function scheduleLabel(commitment: LineCommitment | undefined, cycle: BillingCycle): string {
  const tier = commitment === "monthly" ? "Monthly (flex)" : "Annual commit";
  return `${tier}, ${cycleScheduleLabel(cycle)}`;
}

// ─── Props ────────────────────────────────────────────────────────────────

export interface QuotePDFProps {
  // Tenant (supplier)
  tenantName:     string;
  tenantGstin?:   string | null;
  /** R-368. tenants.udyam_number — "MSME Udyam: UDYAM-…" under the GSTIN when set. */
  udyamNumber?:   string | null;
  tenantEmail?:   string | null;
  tenantPhone?:   string | null;
  tenantAddress?: string | null;
  /**
   * The company logo, ALREADY RESOLVED to a `data:image/...` URI by `logoDataUri()`.
   *
   * Not a URL. A URL here would make the renderer fetch it mid-render with no deadline, on a
   * path that runs inside the inbound-mail webhook — so resolution happens once at the call
   * site, where a failure can be caught and turned into "no logo". `isRenderableLogo`
   * enforces that: anything which is not a data URI draws the monogram instead.
   */
  tenantLogo?:    string | null;

  // Quote
  quoteId:       string;
  customerName:  string;
  contactName?:  string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  /** R-175: the buyer's state and GSTIN under "Bill to", as on the tax invoice. */
  customerState?: string | null;
  customerGstin?: string | null;
  createdDate?:  string | Date | null;
  expiresDate?:  string | Date | null;
  validityDays:  number;
  lineItems:     QuoteLineItem[];
  subtotal:      number;
  discountPct:   number;
  discount:      number;
  taxable:       number;
  taxRate:       number;
  tax:           number;
  total:         number;
  interState:    boolean;
  /** R-175: "Haryana (06) · IGST" — the buyer's state by name and code (placeOfSupplyLabel). */
  placeOfSupply?: string | null;
  /** Export supply (recipient outside India) → zero-rated under LUT, no GST. */
  isExport?:     boolean;
  /** Billing currency + rate — foreign → the whole quote shows in that currency. */
  currency?:     string | null;
  exchangeRate?: number | null;
  /** R-045: where exchangeRate came from (fbil | er-api | frankfurter | manual) and its date. */
  fxSource?:     string | null;
  fxDate?:       string | null;
  /** Quote-level invoice frequency (migration 0161); falls back to legacy per-line commitment. */
  billingCycle?: BillingCycle;
  notes?:        string;
  termsConditions?: string | null;
  /**
   * R-367. The default free support line ("Support: Free — Included"), from
   * includedSupportLine() — the builder the preview dialog uses too. `undefined` →
   * derived here from `lineItems` (callers that build props by hand); `null` → none.
   */
  includedSupport?: IncludedSupportLine | null;
  /** When true, renders "Renewal Quotation" label + visible "RENEWAL" stamp.
   *  Set by lib/renewals/create-renewal-quote.ts on the source quote. */
  isRenewal?:    boolean;
  /**
   * R-034. The money is already in, so this sheet is the customer's record of a paid
   * order rather than an offer: the heading says so, and the two sentences that ask
   * for payment — "Valid until" and "Payment terms: Net 7 days from acceptance" —
   * are dropped instead of contradicting the payment they already made.
   *
   * Decided by `quoteIsPaid()` in the prop builder, never re-derived here (the same
   * reason `upiQrDataUrl` is the caller's call).
   */
  isPaid?:       boolean;
  /** Scan-to-pay QR as a PNG data-URL, from buildQuoteUpiQr(). Null → no block.
   *  The decision of WHETHER to offer a QR belongs to the caller, not here: it
   *  depends on currency and payment status, which this component doesn't see. */
  upiQrDataUrl?: string | null;
  /** Printed under the QR so a payer whose camera struggles can type it. */
  upiVpa?:       string | null;
}

// ─── Styles ───────────────────────────────────────────────────────────────

// @react-pdf/renderer doesn't support Tailwind. We define a tight set of
// reusable styles that map closely to the dialog's visual hierarchy.
const COLORS = {
  ink:    "#1A1A1A",
  ink2:   "#3A3A3A",
  ink3:   "#7A7A7A",
  paper:  "#FFFFFF",
  amber:  "#C2410C",
  hairline: "#E4E4E4",
};

const s = StyleSheet.create({
  page: {
    paddingHorizontal: 40,
    paddingVertical:   36,
    fontFamily:        PDF_FONT,
    fontSize:          10,
    color:             COLORS.ink,
    backgroundColor:   COLORS.paper,
  },

  // Header
  header: {
    flexDirection:    "row",
    justifyContent:   "space-between",
    alignItems:       "flex-start",
    borderBottomWidth: 2,
    borderBottomColor: COLORS.ink,
    paddingBottom:    14,
    marginBottom:     18,
  },
  brandBlock: {
    flexDirection: "row",
    alignItems:    "flex-start",
  },
  brandMonogram: {
    width:            36,
    height:           36,
    backgroundColor:  COLORS.ink,
    color:            COLORS.paper,
    fontFamily:       PDF_FONT_BOLD,
    fontSize:         18,
    textAlign:        "center",
    paddingTop:       7,
    marginRight:      10,
  },
  brandLogo: {
    /* Height is fixed and width is not: a logo is any shape, and `objectFit: contain`
       with only one dimension set lets a wide wordmark stay wide instead of being squeezed
       into the monogram's 36pt square. maxWidth stops a very wide one from pushing the
       company name off the header. */
    height:      36,
    maxWidth:    150,
    objectFit:   "contain",
    marginRight: 10,
  },
  brandName: {
    fontFamily: PDF_FONT_BOLD,
    fontSize:   16,
    color:      COLORS.ink,
  },
  brandMeta: {
    fontSize: 9,
    color:    COLORS.ink3,
    marginTop: 2,
  },
  quoteMetaBlock: {
    alignItems: "flex-end",
  },
  quoteLabel: {
    fontSize:      8,
    letterSpacing: 1.5,
    color:         COLORS.ink3,
    fontFamily:    PDF_FONT_BOLD,
    textTransform: "uppercase",
  },
  quoteId: {
    fontFamily: PDF_FONT_BOLD,
    fontSize:   22,
    color:      COLORS.ink,
    marginTop:  2,
  },
  quoteDate: {
    fontSize:  9,
    color:     COLORS.ink3,
    marginTop: 2,
  },
  renewalStamp: {
    marginTop:       8,
    paddingVertical: 3,
    paddingHorizontal: 8,
    backgroundColor: "#FDF6E0",
    color:           "#7C5A00",
    fontSize:        9,
    fontFamily:      PDF_FONT_BOLD,
    letterSpacing:   2,
    textAlign:       "center",
    alignSelf:       "flex-start",
    borderWidth:     0.5,
    borderColor:     "#C9A95C",
    borderStyle:     "solid",
  },

  // 2-column block
  twoCol: {
    flexDirection:  "row",
    justifyContent: "space-between",
    marginBottom:   18,
  },
  colLeft:  { flex: 1, paddingRight: 12 },
  colRight: { flex: 1, alignItems: "flex-end" },

  sectionLabel: {
    fontSize:      8,
    letterSpacing: 1.5,
    color:         COLORS.ink3,
    fontFamily:    PDF_FONT_BOLD,
    textTransform: "uppercase",
    marginBottom:  3,
  },
  customerName: {
    fontFamily: PDF_FONT_BOLD,
    fontSize:   13,
    color:      COLORS.ink,
  },
  customerLine: {
    fontSize: 10,
    color:    COLORS.ink2,
    marginTop: 2,
  },
  customerMono: {
    fontFamily: "Courier",
    fontSize:   9,
    color:      COLORS.ink3,
    marginTop:  1,
  },
  metaValue: {
    fontSize: 10,
    color:    COLORS.ink,
    marginTop: 1,
  },
  metaValueMono: {
    fontFamily: "Courier",
    fontSize:   10,
  },
  metaGroup: { marginTop: 8 },

  // Line items table
  table: { marginBottom: 14 },
  trHeader: {
    flexDirection:    "row",
    borderTopWidth:   2,
    borderBottomWidth: 2,
    borderColor:      COLORS.ink,
    paddingVertical:  6,
  },
  tr: {
    flexDirection:    "row",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.hairline,
    paddingVertical:  8,
  },
  thDesc:    { flex: 4, fontFamily: PDF_FONT_BOLD, fontSize: 9, textTransform: "uppercase", letterSpacing: 1 },
  thQty:     { width: 40, fontFamily: PDF_FONT_BOLD, fontSize: 9, textTransform: "uppercase", letterSpacing: 1, textAlign: "right" },
  thRate:    { width: 70, fontFamily: PDF_FONT_BOLD, fontSize: 9, textTransform: "uppercase", letterSpacing: 1, textAlign: "right" },
  thAmount:  { width: 90, fontFamily: PDF_FONT_BOLD, fontSize: 9, textTransform: "uppercase", letterSpacing: 1, textAlign: "right" },
  tdDesc:    { flex: 4 },
  tdQty:     { width: 40, fontSize: 10, textAlign: "right" },
  tdRate:    { width: 70, fontSize: 10, textAlign: "right" },
  tdAmount:  { width: 90, textAlign: "right" },

  lineName: { fontFamily: PDF_FONT_BOLD, fontSize: 10, color: COLORS.ink },
  lineMeta: { fontSize: 9, color: COLORS.ink3, marginTop: 2 },
  lineAmount: { fontFamily: PDF_FONT_BOLD, fontSize: 10 },
  lineAmountSub: { fontSize: 8, color: COLORS.ink3, marginTop: 1 },

  emptyRow: {
    paddingVertical: 20,
    textAlign:       "center",
    color:           COLORS.ink3,
    fontSize:        10,
    fontStyle:       "italic",
  },

  // Totals
  totalsWrap: {
    flexDirection:  "row",
    justifyContent: "flex-end",
    marginBottom:   16,
  },
  totalsBox: { width: 250 },
  totalRow: {
    flexDirection:   "row",
    justifyContent:  "space-between",
    paddingVertical: 3,
    fontSize:        10,
  },
  totalLabel: { color: COLORS.ink3 },
  totalValue: { color: COLORS.ink },
  totalValueAccent: { color: "#059669" /* emerald */ },

  grandTotalDivider: {
    borderTopWidth: 2,
    borderTopColor: COLORS.ink,
    marginTop:      6,
    paddingTop:     6,
  },
  grandLabel: {
    fontSize:      9,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    fontFamily:    PDF_FONT_BOLD,
  },
  grandValue: {
    fontFamily: PDF_FONT_BOLD,
    fontSize:   18,
  },
  perInvoiceRow: {
    flexDirection:  "row",
    justifyContent: "space-between",
    marginTop:      4,
    fontSize:       9,
    color:          COLORS.ink3,
  },

  // Notes
  notesBox: {
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
    paddingTop:     10,
    marginBottom:   14,
  },
  notesText: {
    fontSize:   10,
    color:      COLORS.ink2,
    lineHeight: 1.4,
  },

  // Footer
  footer: {
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
    paddingTop:     10,
    marginTop:      16,
  },
  upiRow: {
    flexDirection:  "row",
    alignItems:     "center",
    marginTop:      10,
    paddingTop:     8,
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
  },
  upiQr:    { width: 78, height: 78, marginRight: 10 },
  upiText:  { flex: 1 },
  upiTitle: { fontSize: 10, fontFamily: PDF_FONT_BOLD, color: COLORS.ink2, marginBottom: 2 },
  upiSub:   { fontSize: 8, color: COLORS.ink3, lineHeight: 1.4 },
  upiVpa:   { fontSize: 9, fontFamily: PDF_FONT_BOLD, color: COLORS.ink2, marginTop: 2, marginBottom: 2 },
  footerLine: {
    fontSize:   9,
    color:      COLORS.ink3,
    marginBottom: 3,
    lineHeight: 1.4,
  },
  footerBold: {
    fontFamily: PDF_FONT_BOLD,
    color:      COLORS.ink2,
  },
});

// ─── Document ─────────────────────────────────────────────────────────────

export function QuotePDF(props: QuotePDFProps) {
  const {
    tenantName, tenantGstin, tenantEmail, tenantPhone, tenantAddress, tenantLogo, udyamNumber = null,
    quoteId, customerName, contactName, contactEmail, contactPhone, customerState, customerGstin,
    createdDate, expiresDate, validityDays,
    lineItems, subtotal, discountPct, discount, taxable, taxRate, tax, total,
    interState, placeOfSupply, isExport = false, currency, exchangeRate, fxSource = null, fxDate = null, billingCycle, notes, termsConditions, isRenewal,
    isPaid = false,
    upiQrDataUrl, upiVpa,
  } = props;
  const includedSupport = props.includedSupport !== undefined
    ? props.includedSupport
    : includedSupportLine(lineItems);

  const brandInitial = (tenantName?.trim()?.[0] ?? "?").toUpperCase();
  /* The monogram was never a placeholder waiting to be replaced — it is the fallback, and it
     stays the fallback. A logo that failed to fetch, or that turned out to be an SVG, must
     leave a document that still looks deliberate. */
  const hasLogo = isRenderableLogo(tenantLogo);
  const created = createdDate ? new Date(createdDate) : new Date();
  const expires = expiresDate
    ? new Date(expiresDate)
    : new Date(Date.now() + validityDays * 86400000);

  // Detect shared billing cycle to render "per invoice" totals if all lines agree
  // Billing frequency is a single quote-level value (0161); legacy fallback.
  const firstCommitment = lineItems[0]?.commitment;
  const effectiveCycle: BillingCycle = billingCycle ?? cycleFromLegacyCommitment(firstCommitment);
  const billingN    = cycleInvoicesPerYear(effectiveCycle);
  const billingUnit = cycleUnitLabel(effectiveCycle);
  const perInvoice  = billingN > 1;
  // Foreign customer → render the quote in their currency (USD…); books stay ₹, so
  // the INR equivalent is printed as a GST reference.
  const isForeign   = isForeignCurrency(currency);
  const fxRate      = exchangeRate ?? 1;

  // Consistent display-currency math: for a foreign quote, work per-unit in the
  // client's currency (₹ ÷ rate, rounded 2dp) so qty × rate == amount and the
  // lines sum to the total (a plain per-figure ₹ ÷ rate makes a rounded unit rate
  // disagree with the exact total, e.g. 32 × $32.00 ≠ $1,023.88). Books stay ₹.
  const dRound = (v: number) => (isForeign ? Math.round(v * 100) / 100 : Math.round(v));
  const toDisp = (inr: number) => (isForeign ? dRound(inr / fxRate) : inr);
  const fmtC   = (v: number) => (isForeign ? formatForeign(v, currency ?? "") : pdfRupee(v));
  /* ── TWO DIFFERENT THINGS BOTH LOOK LIKE "MONTHLY" ────────────────────────
     Everything below used to divide every stored figure by `billingN`, on the assumption
     that a stored figure is always an ANNUAL contract value. That is right for the common
     case — an annual commitment billed in twelve instalments — and wrong for the other one:

       annual_yearly + billing monthly   ->  subtotal is a YEAR.   Divide by 12.
       monthly (flex) + billing monthly  ->  subtotal is a MONTH.  Divide by nothing.

     `lib/quotes/commitment-rate.ts` documents that boundary and three SQL regression tests
     pin it — a monthly line's rate is per seat per MONTH, and `record_payment` divides by
     1.0 rather than 12.0 for exactly that reason. The renderer was the one place that had
     not been told.

     Measured on Q-ADPL-2026-27-0053, sent: 36 seats at Rs 325/seat/month, subtotal
     Rs 11,700/month — printed as "Rs 27/mo · Rs 975/mo · Rs 13,392/yr". A twelfth of the
     real price, on a GST document. The row was correct; only this line was not.

     `billingCycle` alone cannot tell the two apart, because both say "monthly". The LINE's
     own commitment can, and it is the same field the pricing planner set. */
  const invoiceDivisor = perInvoiceDivisor(billingN, firstCommitment);
  /* The same fact read the other way, and it decides more than arithmetic: a flex line is
     priced per month BECAUSE the customer has promised nothing. So every "per year" figure
     on this document — the invoice count, the line's annual sub-total, the contract value —
     describes a year nobody agreed to. See the block at the "Billing schedule" group. */
  const noYearlyCommitment = lineIsPerInvoice(firstCommitment);
  const fmtInv = (stored: number) =>
    perInvoice ? `${fmtC(dRound(stored / invoiceDivisor))}${billingUnit}` : fmtC(stored);

  // Totals: for a FOREIGN quote, rebuild from the display-currency lines so the
  // printed lines + totals agree (qty × rate == amount, Σ lines == total). For a
  // domestic ₹ quote, keep the canonical stored figures untouched (no rounding
  // drift vs the saved amount). Discounting is quote-level; per-line is legacy/0.
  const dLineAnnual = lineItems.map((l) => dRound(l.qty * toDisp(l.rate)));
  const dSubtotal = isForeign ? dRound(dLineAnnual.reduce((s, v) => s + v, 0)) : subtotal;
  const dDiscount = isForeign ? dRound(dSubtotal * (discountPct / 100))        : discount;
  const dTaxable  = isForeign ? dRound(dSubtotal - dDiscount)                  : taxable;
  const dTax      = isForeign ? dRound(dTaxable * (taxRate / 100))             : tax;
  const dTotal    = isForeign ? dRound(dTaxable + dTax)                        : total;
  /* R-212: CGST/SGST from lib/gst/tax-split — the split the preview and the email print.
     A foreign quote's tax is in cents, so it is split as a whole number of cents: the helper
     keeps a whole-unit tax in whole-unit heads (right for ₹, where every quote tax is whole
     rupees), which would print $7.00 as $4.00 + $3.00. Integer cents also avoid the float
     trap of the old `dRound(dTax / 2)` ($9.95 / 2 → $4.97, the odd cent going to SGST). */
  const intra = isForeign
    ? (({ cgst, sgst }) => ({ cgst: cgst / 100, sgst: sgst / 100 }))(splitIntraStateTax(Math.round(dTax * 100)))
    : splitIntraStateTax(dTax);

  return (
    <Document
      title={`${isPaid ? "Paid order" : "Quote"} ${quoteId}`}
      author={tenantName}
      subject={`${quoteDocumentLabel({ paid: isPaid, isRenewal })} ${quoteId} for ${customerName}`}
    >
      <Page size="A4" style={s.page}>

        {/* ── Header ──────────────────────────────────────────────── */}
        <View style={s.header}>
          <View style={s.brandBlock}>
            {hasLogo
              ? <Image src={tenantLogo} style={s.brandLogo} />
              : <Text style={s.brandMonogram}>{brandInitial}</Text>}
            <View>
              <Text style={s.brandName}>{pdfText(tenantName)}</Text>
              {tenantGstin && (
                <Text style={s.brandMeta}>GSTIN: {tenantGstin}</Text>
              )}
              {udyamPdfLine(udyamNumber) && (
                <Text style={s.brandMeta}>{udyamPdfLine(udyamNumber)}</Text>
              )}
              {tenantAddress && (
                <Text style={s.brandMeta}>{pdfText(tenantAddress)}</Text>
              )}
              {(tenantEmail || tenantPhone) && (
                <Text style={s.brandMeta}>
                  {[tenantEmail, tenantPhone].filter(Boolean).join("  ·  ")}
                </Text>
              )}
            </View>
          </View>
          <View style={s.quoteMetaBlock}>
            <Text style={s.quoteLabel}>{quoteDocumentLabel({ paid: isPaid, isRenewal })}</Text>
            <Text style={s.quoteId}>{quoteId}</Text>
            <Text style={s.quoteDate}>Dated: {formatDate(created)}</Text>
            {/* R-034: an expiry on a document the customer has already paid reads as
                "you still have to act". Only an open offer has a validity window. */}
            {!isPaid && (
              <Text style={s.quoteDate}>Valid until: {formatDate(expires)}</Text>
            )}
            {isRenewal && (
              <Text style={s.renewalStamp}>RENEWAL</Text>
            )}
          </View>
        </View>

        {/* ── Bill to + Meta ──────────────────────────────────────── */}
        <View style={s.twoCol}>
          <View style={s.colLeft}>
            <Text style={s.sectionLabel}>Bill to</Text>
            <Text style={s.customerName}>{pdfText(customerName)}</Text>
            {contactName && (
              <Text style={s.customerLine}>Attn: {contactName}</Text>
            )}
            {contactEmail && (
              <Text style={s.customerMono}>{contactEmail}</Text>
            )}
            {contactPhone && (
              <Text style={s.customerMono}>{contactPhone}</Text>
            )}
            {customerGstin && (
              <Text style={s.customerMono}>GSTIN: {customerGstin}</Text>
            )}
            {customerState && (
              <Text style={s.customerLine}>State: {pdfText(customerState)}</Text>
            )}
          </View>
          <View style={s.colRight}>
            <Text style={s.sectionLabel}>Place of supply</Text>
            <Text style={s.metaValue}>
              {isExport
                ? "Export · zero-rated under LUT (no GST)"
                : placeOfSupply || (interState ? "Inter-state (IGST applies)" : "Intra-state (CGST + SGST)")}
            </Text>
            {lineItems.length > 0 && firstCommitment && (
              <View style={s.metaGroup}>
                <Text style={s.sectionLabel}>Billing schedule</Text>
                <Text style={s.metaValue}>{scheduleLabel(firstCommitment, effectiveCycle)}</Text>
                {/* ── A FLEX PLAN HAS NO YEAR TO COUNT ────────────────────────
                    "12 invoices per year" states a commitment the customer has not made.
                    Pardeep's point, 31 Aug 2026: monthly flex IS the flexible tier — take
                    one month or two — so projecting a year onto it is not a rounding
                    question, it is a claim about a contract that does not exist.

                    And the truth here is a reason to buy, not a caveat: no commitment is
                    exactly what the flex tier is sold on. */}
                {billingN > 1 && (
                  <Text style={[s.metaValue, { fontSize: 9, color: COLORS.ink3 }]}>
                    {noYearlyCommitment ? "No commitment — cancel any time" : `${billingN} invoices per year`}
                  </Text>
                )}
              </View>
            )}
            <View style={s.metaGroup}>
              <Text style={s.sectionLabel}>HSN / SAC</Text>
              <Text style={[s.metaValue, s.metaValueMono]}>998313</Text>
            </View>
          </View>
        </View>

        {/* ── Line items ──────────────────────────────────────────── */}
        <View style={s.table}>
          <View style={s.trHeader}>
            <Text style={s.thDesc}>Description</Text>
            <Text style={s.thQty}>Qty</Text>
            <Text style={s.thRate}>Rate</Text>
            <Text style={s.thAmount}>Amount</Text>
          </View>

          {lineItems.length === 0 ? (
            <Text style={s.emptyRow}>No line items.</Text>
          ) : (
            lineItems.map((line) => {
              // Per-unit in the DISPLAY currency so qty × rate == amount exactly.
              const lineDiscountPct = line.discount_pct ?? 0;   // quote-level discounting; per-line is legacy/0
              const unit        = toDisp(line.rate);            // per seat / year
              const grossAnnual = dRound(line.qty * unit);
              const netAnnual   = dRound(grossAnnual * (1 - lineDiscountPct / 100));
              return (
                <View key={line.id} style={s.tr} wrap={false}>
                  <View style={s.tdDesc}>
                    <Text style={s.lineName}>{pdfText(line.name)}</Text>
                    {/* Which website the line is for (3 Oct 2026; invoice-display.ts). */}
                    {lineDomainNote(line) && <Text style={s.lineMeta}>{pdfText(lineDomainNote(line) ?? "")}</Text>}
                    {/* R-156: a multi-year domain line's rate is the whole term, not a year. */}
                    {(line.years ?? 1) > 1 ? (
                      <Text style={s.lineMeta}>Registration for {line.years} years, paid now · HSN 998313</Text>
                    ) : (
                    <Text style={s.lineMeta}>
                      Per seat{perInvoice ? "" : " per year"} · HSN 998313
                      {line.commitment && ` · ${scheduleLabel(line.commitment, effectiveCycle)}`}
                    </Text>
                    )}
                    {lineDiscountPct > 0 && (
                      <Text style={s.lineMeta}>
                        Discount: {lineDiscountPct}%
                        {line.discount_reason ? ` (${line.discount_reason})` : ""}
                      </Text>
                    )}
                    {line.bulk && line.domains && line.domains.length > 0 && (
                      <Text style={s.lineMeta}>
                        Covering {line.domains.length} domains: {line.domains.map((d) => `${d.domain} (${d.seats})`).join(", ")}
                      </Text>
                    )}
                  </View>
                  <Text style={s.tdQty}>{line.qty}</Text>
                  <Text style={s.tdRate}>{fmtInv(unit)}</Text>
                  <View style={s.tdAmount}>
                    <Text style={s.lineAmount}>{fmtInv(netAnnual)}</Text>
                    {perInvoice && (
                      /* On flex the stored figure IS one month, so "= X/yr" would print a
                         month's number under a year's label. Drop the projection; keep the
                         "was" — a discount is true whatever the term. */
                      <Text style={s.lineAmountSub}>
                        {noYearlyCommitment ? "" : `= ${fmtC(netAnnual)}/yr`}
                        {lineDiscountPct > 0 ? ` (was ${fmtC(grossAnnual)})` : ""}
                      </Text>
                    )}
                  </View>
                </View>
              );
            })
          )}
        </View>

        {/* ── Totals ──────────────────────────────────────────────── */}
        {lineItems.length > 0 && (
          <View style={s.totalsWrap}>
            <View style={s.totalsBox}>
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>
                  {perInvoice ? "Subtotal (per invoice)" : "Subtotal"}
                </Text>
                <Text style={s.totalValue}>{fmtInv(dSubtotal)}</Text>
              </View>
              {discountPct > 0 && (
                <View style={s.totalRow}>
                  <Text style={s.totalLabel}>Discount ({discountPct}%)</Text>
                  <Text style={s.totalValueAccent}>-{fmtInv(dDiscount)}</Text>
                </View>
              )}
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>Taxable amount</Text>
                <Text style={s.totalValue}>{fmtInv(dTaxable)}</Text>
              </View>
              {isExport ? (
                <View style={s.totalRow}>
                  <Text style={s.totalLabel}>Export — zero-rated (LUT), no GST</Text>
                  <Text style={s.totalValue}>{fmtC(0)}</Text>
                </View>
              ) : interState ? (
                <View style={s.totalRow}>
                  <Text style={s.totalLabel}>IGST ({taxRate}%)</Text>
                  <Text style={s.totalValue}>{fmtInv(dTax)}</Text>
                </View>
              ) : (
                <>
                  <View style={s.totalRow}>
                    <Text style={s.totalLabel}>CGST ({taxRate / 2}%)</Text>
                    <Text style={s.totalValue}>{fmtInv(intra.cgst)}</Text>
                  </View>
                  <View style={s.totalRow}>
                    <Text style={s.totalLabel}>SGST ({taxRate / 2}%)</Text>
                    <Text style={s.totalValue}>{fmtInv(intra.sgst)}</Text>
                  </View>
                </>
              )}
              <View style={s.grandTotalDivider}>
                <View style={s.totalRow}>
                  <Text style={s.grandLabel}>
                    {perInvoice
                      ? noYearlyCommitment ? "Per invoice" : `Per invoice (${billingN}/yr)`
                      : "Grand total"}
                  </Text>
                  <Text style={s.grandValue}>
                    {perInvoice
                      ? `${fmtC(dRound(dTotal / invoiceDivisor))}${billingUnit}`
                      : fmtC(dTotal)}
                  </Text>
                </View>
                {perInvoice && (
                  noYearlyCommitment ? (
                    /* ── A YEAR'S VALUE THE CUSTOMER NEVER PROMISED ──────────────────
                       This row printed "Annual contract value". On a flex line that is not
                       an arithmetic question at all — it is a contract that does not exist.
                       Fixing it to multiply by twelve (which I did first) only stated the
                       imaginary year more accurately.

                       Pardeep, 31 Aug 2026: "monthly commitment me annual billing ki to koi
                       jarurat hi nahi hai kyoki wo to flexible hota hai — chahe aap ek mahina
                       lo ya do mahina". The flex tier costs MORE per seat (Rs 325 vs Rs 270)
                       precisely because there is no lock-in; printing a year beside that
                       price takes back the thing the customer is paying extra for.

                       So the row states the term instead of projecting one — and on a
                       quotation that sentence sells rather than warns. */
                    <View style={s.perInvoiceRow}>
                      <Text>Commitment</Text>
                      <Text>None — cancel or change seats any month</Text>
                    </View>
                  ) : (
                    <View style={s.perInvoiceRow}>
                      <Text>Annual contract value</Text>
                      {/* The mirror of the divisor above: on an annual commitment billed
                          monthly, `dTotal` IS the year. `annualContractValue` keeps the two
                          in step, and its tests keep the flex branch honest even though this
                          document no longer renders it. */}
                      <Text>{fmtC(annualContractValue(dTotal, billingN, firstCommitment))}/yr</Text>
                    </View>
                  )
                )}
                {isForeign && (
                  <View style={s.perInvoiceRow}>
                    {/* R-045: which rate (FBIL/RBI reference, indicative or the supplier's) and its date. */}
                    <Text>{pdfSafeMoney(fxEquivalentLine({ currency: currency ?? "", rate: fxRate, source: fxSource, date: fxDate }))}</Text>
                    <Text>{pdfRupee(total)}</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        )}

        {/* ── R-367: default free support, included ───────────────── */}
        {includedSupport && (
          <View style={s.notesBox}>
            <Text style={s.notesText}>{pdfText(includedSupport.text)}</Text>
            <Text style={[s.notesText, { marginTop: 2, color: COLORS.ink3 }]}>{pdfText(includedSupport.detail)}</Text>
          </View>
        )}

        {/* ── Notes ───────────────────────────────────────────────── */}
        {notes && notes.trim().length > 0 && (
          <View style={s.notesBox}>
            <Text style={s.sectionLabel}>Notes</Text>
            <Text style={[s.notesText, { marginTop: 4 }]}>{pdfText(notes)}</Text>
          </View>
        )}

        {/* ── Terms & conditions ──────────────────────────────────── */}
        {termsConditions && termsConditions.trim().length > 0 && (
          <View style={s.notesBox}>
            <Text style={s.sectionLabel}>Terms &amp; conditions</Text>
            <Text style={[s.notesText, { marginTop: 4 }]}>{termsConditions.trim()}</Text>
          </View>
        )}

        {/* ── Terms footer ────────────────────────────────────────── */}
        <View style={s.footer}>
          {/* R-034. Both of these ask for money. On a paid order they contradict the
              payment the customer already made — "Net 7 days from acceptance" was
              printed on an order paid minutes earlier. Replaced by the one sentence
              that is true: nothing is due. */}
          {/* Three sibling conditionals rather than a fragment: @react-pdf walks its own
              children, and a Fragment in the middle of a View makes React ask for keys
              on primitives that have no business carrying them. */}
          {isPaid && (
            <Text style={s.footerLine}>
              <Text style={s.footerBold}>Payment: </Text>
              Received in full — nothing further is due on this order.
            </Text>
          )}
          {!isPaid && (
            <Text style={s.footerLine}>
              <Text style={s.footerBold}>Payment terms: </Text>
              Net 7 days from acceptance. UPI / NEFT / Razorpay accepted.
            </Text>
          )}
          {!isPaid && (
            <Text style={s.footerLine}>
              <Text style={s.footerBold}>Quote validity: </Text>
              {validityDays} days from issue date.
            </Text>
          )}

          {/* Scan-to-pay. Drawn only when the caller supplied a QR — which it
              does only for an INR quote that is still awaiting payment. The
              wording says ADVANCE deliberately: money paid against a quote
              arrives before the tax invoice exists, so it is an advance and the
              seller answers it with a Receipt Voucher under CGST §31(3)(d).
              Calling it a payment here would set up the wrong expectation about
              which document the customer gets back. */}
          {upiQrDataUrl ? (
            <View style={s.upiRow}>
              <Image src={upiQrDataUrl} style={s.upiQr} />
              <View style={s.upiText}>
                <Text style={s.upiTitle}>Scan to pay this advance</Text>
                <Text style={s.upiSub}>
                  Any UPI app — GPay, PhonePe, Paytm, BHIM.
                </Text>
                {upiVpa ? <Text style={s.upiVpa}>{upiVpa}</Text> : null}
                <Text style={s.upiSub}>
                  Amount and quote number are pre-filled. You&apos;ll receive a receipt
                  voucher, and a GST tax invoice when the order is provisioned.
                </Text>
              </View>
            </View>
          ) : null}
          <Text style={[s.footerLine, { marginTop: 4 }]}>
            Thank you for considering {tenantName}.
            {tenantEmail && ` Reach out at ${tenantEmail} for any clarifications.`}
          </Text>
        </View>
      </Page>
    </Document>
  );
}
