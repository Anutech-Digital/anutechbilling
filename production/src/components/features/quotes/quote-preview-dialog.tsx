/**
 * QuotePreviewDialog — customer-facing preview of the quote as it will appear
 * in the PDF / email. Opens from QuoteBuilder "Preview" button.
 *
 * Print-friendly layout matching what the customer sees.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { lineUnitLabel } from "@/lib/quotes/line-unit-label";
import { linePriceBreakdown, linePriceBreakdownText } from "@/lib/quotes/line-price-breakdown";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { isForeignCurrency, foreignEquivalent, formatForeign } from "@/lib/currency";
import { foreignQuoteFigures, cents } from "@/lib/quotes/foreign-totals";
import { splitIntraStateTax } from "@/lib/gst/tax-split";
import type { QuoteLineItem, LineCommitment, BillingCycle } from "@/lib/supabase/database.types";
import {
  cycleInvoicesPerYear, cycleUnitLabel, cycleScheduleLabel, cycleFromLegacyCommitment,
} from "@/lib/quotes/billing";
import { includedSupportLine } from "@/lib/pdf/quote-support-line";
import { perInvoiceDivisor, annualContractValue } from "@/lib/pdf/invoice-divisor";
import { quoteInstalmentPlan } from "@/lib/billing/instalments";
import { ONE_TIME_SCHEDULE, type LinePeriodContext } from "@/lib/quotes/service-period";
import { lineDetailNotes } from "@/lib/pdf/invoice-display";
import { customerQuoteNotes } from "@/lib/quotes/customer-notes";
import { UPI_SETTINGS_HREF } from "@/lib/pdf/quote-template";
import { billOfSupplyCustomerLine, billOfSupplyPlaceLabel, type BillOfSupplyStatus } from "@/lib/quotes/bill-of-supply";

/** R-1694: the scan-to-pay QR the customer's PDF carries (api/quotes/[id]/pay-qr → quotePayQr). */
interface PreviewPayQr { dataUrl: string; vpa: string; amount: number }

/**
 * Fetches the PDF's own QR for a SAVED quote. Null while loading, on any failure, and whenever
 * the PDF would print none (no UPI ID, non-₹, paid, invoiced) — the server decides, not this.
 */
function usePreviewPayQr(enabled: boolean, quoteId: string | null | undefined): PreviewPayQr | null {
  const [qr, setQr] = React.useState<PreviewPayQr | null>(null);
  React.useEffect(() => {
    setQr(null);
    if (!enabled || !quoteId) return;
    let live = true;
    fetch(`/api/quotes/${encodeURIComponent(quoteId)}/pay-qr`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { qr?: PreviewPayQr | null } | null) => { if (live) setQr(j?.qr ?? null); })
      .catch(() => { /* no QR in the preview — the PDF itself is unaffected */ });
    return () => { live = false; };
  }, [enabled, quoteId]);
  return qr;
}

/** Price tier + billing frequency, combined for a line (frequency is quote-level). */
function scheduleLabel(commitment: LineCommitment | undefined, cycle: BillingCycle): string {
  const tier = commitment === "monthly" ? "Monthly (flex)" : "Annual commit";
  return `${tier} · ${cycleScheduleLabel(cycle)}`;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  // Tenant identity (supplier on the quote) — pass via useCurrentUser
  tenantName:    string;
  tenantGstin?:  string | null;
  tenantEmail?:  string | null;
  tenantPhone?:  string | null;
  tenantAddress?: string | null;

  // Quote data
  quoteId:       string;
  customerName:  string;
  contactName?:  string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  lineItems:     QuoteLineItem[];
  subtotal:      number;
  discountPct:   number;
  discount:      number;
  taxable:       number;
  taxRate:       number;
  tax:           number;
  total:         number;
  interState:    boolean;
  /** R-376 (f): "Haryana (06) · IGST" — the buyer's state by name and code
   *  (lib/quotes/quote-place-of-supply). Omitted → the old "Inter-state (IGST applies)". */
  placeOfSupply?: string | null;
  /** Export supply (recipient outside India) → zero-rated under LUT, no GST. */
  isExport?:     boolean;
  /** R-1532: the business issues a Bill of Supply and the quote carries no GST → one
   *  "No GST — Bill of Supply" line instead of CGST/SGST/IGST rows. */
  billOfSupply?: BillOfSupplyStatus | null;
  /** Billing currency + rate — foreign → the whole quote shows in that currency. */
  currency?:     string | null;
  exchangeRate?: number | null;
  /** Quote-level invoice frequency (migration 0161); falls back to legacy per-line commitment. */
  billingCycle?: BillingCycle;
  validityDays:  number;
  notes:         string;
  termsConditions?: string | null;
  isProspect?:   boolean;
  /** R-809: add-seats (pro-rata) or one-off quote — paid once, no billing schedule. */
  oneTime?:      boolean;
  /** R-811: "3-month extension" / "1-year extension" under the heading (extensionTitle()). */
  extensionTitle?: string | null;
  /** R-1694: the workspace's UPI ID (useCurrentUser().tenantUpiVpa). Omitted → no QR logic at all. */
  upiVpa?:       string | null;
  /** R-1694: the SAVED quote's id, for its PDF QR. Null → not saved yet (builder), no QR to fetch. */
  payQrQuoteId?: string | null;
  /** R-1764: what each subscription line's "Domain:" and "Subscription period:" lines read
   *  (quoteLinePeriodContext). Omitted → neither line. */
  periodContext?: LinePeriodContext | null;
}

export function QuotePreviewDialog({
  open,
  onOpenChange,
  tenantName,
  tenantGstin,
  tenantEmail,
  tenantPhone,
  tenantAddress,
  quoteId,
  customerName,
  contactName,
  contactEmail,
  contactPhone,
  lineItems,
  subtotal,
  discountPct,
  discount,
  taxable,
  taxRate,
  tax,
  total,
  interState,
  placeOfSupply,
  isExport = false,
  billOfSupply = null,
  currency,
  exchangeRate,
  billingCycle,
  validityDays,
  notes: rawNotes,
  termsConditions,
  isProspect = false,
  oneTime = false,
  extensionTitle = null,
  upiVpa,
  payQrQuoteId = null,
  periodContext = null,
}: Props) {
  /* R-813: this previews what the CUSTOMER sees — never the staff-only audit part. */
  const notes = customerQuoteNotes(rawNotes, lineItems);
  // First letter of tenant name → brand monogram (e.g. "Demo Co" → "E")
  const brandInitial = (tenantName?.trim()?.[0] ?? "?").toUpperCase();
  const expiresOn = new Date(Date.now() + validityDays * 86400000);

  // Billing frequency is a single quote-level value (migration 0161). Fall back
  // to the legacy per-line commitment for quotes written before the split.
  const firstCommitment: LineCommitment | undefined = lineItems[0]?.commitment;
  const effectiveCycle: BillingCycle = billingCycle ?? cycleFromLegacyCommitment(firstCommitment);
  const billingN     = cycleInvoicesPerYear(effectiveCycle);
  const billingUnit  = cycleUnitLabel(effectiveCycle);
  const perInvoice   = billingN > 1;
  /* R-369: the PDF's divisor — a flex quote's stored totals are already one MONTH. */
  const totalsDiv    = perInvoiceDivisor(billingN, firstCommitment);
  // Foreign customer → show the whole quote in their currency (USD…); books stay ₹,
  // so the INR equivalent is printed as a GST reference near the total.
  const isForeign    = isForeignCurrency(currency);
  const fxRate       = exchangeRate ?? 1;
  const money        = (n: number) =>
    isForeign ? formatForeign(foreignEquivalent(n, fxRate), currency ?? "") : rupee(n);
  const fmt          = (n: number) =>
    perInvoice ? `${money(Math.round(n / totalsDiv))}${billingUnit}` : money(n);
  /* R-1677: a foreign quote is totalled the one way the accept page, PDF, builder and invoice
     total it (lib/quotes/foreign-totals) — per-unit to the cent, lines summed. Converting each
     ₹ figure on its own printed $338.39 beside the customer's $338.40. */
  const ff           = isForeign
    ? foreignQuoteFigures({ lines: lineItems, fx: fxRate, discountPct, taxRate: isExport ? 0 : taxRate })
    : null;
  const fgn          = (v: number) => formatForeign(v, currency ?? "");
  const fmtF         = (inr: number, foreign: number | undefined) =>
    ff && foreign !== undefined
      ? (perInvoice ? `${fgn(cents(foreign / totalsDiv))}${billingUnit}` : fgn(foreign))
      : fmt(inr);

  // R-212: the same CGST/SGST split the email and the PDF print (lib/gst/tax-split).
  const intra        = splitIntraStateTax(tax);
  /* R-527: per-instalment figures by the instalment invoice's own rounding — the plan the
     editor, PDF, customer page and payment sheet read (lib/billing/instalments.ts). */
  const splitPlan    = !isForeign && perInvoice
    ? quoteInstalmentPlan({
        cycle: effectiveCycle, termTaxable: taxable, termGross: total,
        taxRate: isExport ? 0 : taxRate, lineCommitment: firstCommitment ?? null, termStart: "2000-01-01",
      })
    : null;
  const firstInst    = splitPlan?.lines[0] ?? null;
  const fmtInst      = (n: number) => `${money(n)}${billingUnit}`;
  const instHeads    = firstInst ? splitIntraStateTax(firstInst.tax) : null;
  // R-367: the same "Support: Free — Included" line the PDF prints (one builder).
  const includedSupport = includedSupportLine(lineItems);

  /* R-1694: the PDF's scan-to-pay QR. `upiVpa === undefined` means the caller did not wire it. */
  const qrWired      = upiVpa !== undefined;
  const hasUpi       = !!upiVpa?.trim();
  const payQr        = usePreviewPayQr(open && qrWired && hasUpi, payQrQuoteId);
  const upiHint      = qrWired && !hasUpi && !isForeign;
  const unsavedHint  = qrWired && hasUpi && !isForeign && !payQrQuoteId;

  const handlePrint = () => {
    window.print();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto p-0">
        <DialogTitle className="sr-only">Quote preview · {quoteId}</DialogTitle>

        {/* Toolbar (hidden when printing) */}
        {/* R-1654: wraps on a phone (as R-187 did for the invoice/receipt toolbars) — one line
            of toolbar was 459px and pushed the whole sheet, Amount column too, off a 375px screen. */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-5 py-3 border-b border-hairline bg-paper-2 sticky top-0 z-10 print:hidden">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <Icon name="file" size={16} className="text-ink-3" />
            <span className="text-sm font-semibold text-ink">Preview</span>
            <span className="text-xs text-ink-3">· This is how the customer will see it</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon="printer" onClick={handlePrint}>
              Print / Save as PDF
            </Button>
            <Button size="sm" variant="ghost" icon="x" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </div>

        {/* Staff-only notes — outside the customer's document, never printed (R-1694).
            R-1673: the prospect note used to sit under "Bill to" INSIDE the document. */}
        {(isProspect || upiHint || unsavedHint) && (
          <div className="space-y-1 border-b border-hairline bg-amber-soft px-5 py-2 text-xs text-amber-ink print:hidden" data-testid="preview-staff-notes">
            {isProspect && (
              <p data-testid="preview-staff-hint-prospect">
                Only you see this: this quote is for a lead — the customer record is created after the payment is recorded.
              </p>
            )}
            {upiHint && (
              <p data-testid="preview-staff-hint-upi">
                Add your UPI ID in Settings to show a Pay QR —{" "}
                <Link href={UPI_SETTINGS_HREF as Route} className="font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">
                  Open Settings
                </Link>
              </p>
            )}
            {unsavedHint && (
              <p data-testid="preview-staff-hint-unsaved">
                The scan-to-pay QR shows once the quote is saved (the PDF gets it then too).
              </p>
            )}
          </div>
        )}

        {/* ─────── PDF-style document ─────── */}
        {/* R-1654: p-4 on a phone (p-10 cut the Amount column off at 375px); sm: and print keep
            the A4 look unchanged. The emailed PDF is a separate react-pdf template. */}
        <div className="bg-paper p-4 sm:p-10 print:p-0 font-sans text-ink" data-testid="preview-document">
          {/* Brand header */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between border-b-2 border-ink pb-5 mb-6 [overflow-wrap:anywhere]">
            <div className="flex min-w-0 items-center gap-3">
              <div className="w-12 h-12 shrink-0 rounded-md bg-ink text-paper grid place-items-center font-serif text-2xl">
                {brandInitial}
              </div>
              <div className="min-w-0">
                <div className="font-serif text-2xl leading-tight">{tenantName}</div>
                {tenantGstin && (
                  <div className="text-xs text-ink-3 mt-0.5">
                    GSTIN: <span className="font-mono">{tenantGstin}</span>
                  </div>
                )}
                {tenantAddress && (
                  <div className="text-xs text-ink-3 mt-0.5">{tenantAddress}</div>
                )}
                {(tenantEmail || tenantPhone) && (
                  <div className="text-xs text-ink-3 font-mono">
                    {tenantEmail}{tenantEmail && tenantPhone ? " · " : ""}{tenantPhone}
                  </div>
                )}
              </div>
            </div>
            <div className="sm:text-right">
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold">
                Quotation
              </p>
              <p className="font-serif text-3xl mt-1">{quoteId}</p>
              {extensionTitle && (
                <p className="text-xs font-medium text-ink-2 mt-0.5" data-testid="extension-title">
                  {extensionTitle[0].toUpperCase() + extensionTitle.slice(1)}
                </p>
              )}
              <p className="text-xs text-ink-3 mt-1">
                Dated: {formatDate(new Date())}
              </p>
              <p className="text-xs text-ink-3">
                Valid until: <b>{formatDate(expiresOn)}</b>
              </p>
            </div>
          </div>

          {/* Bill to */}
          <div className="grid grid-cols-2 gap-3 sm:gap-6 mb-6 [overflow-wrap:anywhere]">
            <div className="min-w-0">
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-1.5">
                Bill to
              </p>
              <p className="font-serif text-lg leading-tight">{customerName}</p>
              {contactName && (
                <p className="text-sm text-ink-2 mt-1">Attn: {contactName}</p>
              )}
              {contactEmail && (
                <p className="text-sm text-ink-3 font-mono">{contactEmail}</p>
              )}
              {contactPhone && (
                <p className="text-sm text-ink-3 font-mono">{contactPhone}</p>
              )}
            </div>
            <div className="min-w-0 text-right">
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-1.5">
                Place of supply
              </p>
              <p className="text-sm">
                {isExport
                  ? "Export · zero-rated under LUT (no GST)"
                  : billOfSupply
                  ? billOfSupplyPlaceLabel(placeOfSupply)
                  : placeOfSupply || (interState ? "Inter-state (IGST applies)" : "Intra-state (CGST + SGST)")}
              </p>
              {lineItems.length > 0 && firstCommitment && (
                <>
                  <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mt-3 mb-1.5">
                    Billing schedule
                  </p>
                  <p className="text-sm">{oneTime ? ONE_TIME_SCHEDULE : scheduleLabel(firstCommitment, effectiveCycle)}</p>
                  {billingN > 1 && !oneTime && (
                    <p className="text-2xs text-ink-3">{billingN} invoices per year</p>
                  )}
                </>
              )}
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mt-3 mb-1.5">
                HSN / SAC
              </p>
              <p className="text-sm font-mono">998313</p>
            </div>
          </div>

          {/* Line items */}
          <div className="mb-6 overflow-x-auto">
          <table className="w-full">
            <thead className="border-y-2 border-ink">
              <tr>
                <th className="text-left py-2 whitespace-nowrap text-2xs uppercase tracking-normal sm:tracking-wider font-semibold text-ink">Description</th>
                <th className="text-right py-2 whitespace-nowrap text-2xs uppercase tracking-normal sm:tracking-wider font-semibold text-ink pl-2 sm:w-20">Qty</th>
                <th className="text-right py-2 whitespace-nowrap text-2xs uppercase tracking-normal sm:tracking-wider font-semibold text-ink pl-2 sm:w-32">Rate</th>
                <th className="text-right py-2 whitespace-nowrap text-2xs uppercase tracking-normal sm:tracking-wider font-semibold text-ink pl-2 sm:w-36">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-ink-3 italic text-sm">
                    No line items added yet. Add at least one item to preview a complete quote.
                  </td>
                </tr>
              ) : (
                lineItems.map((line, li) => {
                  // Frequency is quote-level now (0161) — every line shares it.
                  /* R-369: a flex line's rate is already one month; only annual lines divide. */
                  const lineN    = billingN;
                  const lineDiv  = perInvoiceDivisor(billingN, line.commitment);
                  const lineUnit = billingUnit;
                  const showPer  = lineN > 1;
                  const rate     = showPer ? Math.round(line.rate / lineDiv) : line.rate;
                  const amount   = line.qty * rate;
                  /* R-495: list price, discount (₹ and %) and final rate, in the same unit as
                     the Rate column — only when the line has a list price above its rate. */
                  const breakdown = linePriceBreakdown(line, (n) => (showPer ? Math.round(n / lineDiv) : n));
                  return (
                    <tr key={line.id} className="border-b border-hairline">
                      <td className="py-3 text-sm [overflow-wrap:anywhere]">
                        <p className="font-medium text-ink">{line.name}</p>
                        {/* R-1764: "Domain:" / "Subscription period:" — the PDF's words. */}
                        {lineDetailNotes(line, periodContext).map((t) => (
                          <p key={t} className="text-2xs text-ink-3 mt-0.5 tabular-nums" data-testid="line-period">{t}</p>
                        ))}
                        <p className="text-2xs text-ink-3 mt-0.5">
                          {lineUnitLabel(line, showPer || oneTime)} · HSN 998313
                          {line.commitment && !oneTime && (
                            <> · {scheduleLabel(line.commitment, effectiveCycle)}</>
                          )}
                        </p>
                        {breakdown && (
                          <p className="text-2xs text-ink-3 mt-0.5 tabular-nums" data-testid="line-price-breakdown">
                            {linePriceBreakdownText(breakdown, (n) => `${money(n)}${showPer ? lineUnit : ""}`)}
                          </p>
                        )}
                        {line.bulk && line.domains && line.domains.length > 0 && (
                          <p className="text-2xs text-ink-3 mt-0.5">
                            Covering {line.domains.length} domains: {line.domains.map((d) => `${d.domain} (${d.seats})`).join(", ")}
                          </p>
                        )}
                      </td>
                      <td className="py-3 pl-2 text-right text-sm tabular-nums">{line.qty}</td>
                      <td className="py-3 pl-2 text-right text-sm tabular-nums">
                        {ff && !showPer ? fgn(ff.lines[li].unit) : money(rate)}{showPer ? lineUnit : ""}
                      </td>
                      <td className="py-3 pl-2 text-right text-sm tabular-nums font-medium">
                        <div>{ff && !showPer ? fgn(ff.lines[li].gross) : money(amount)}{showPer ? lineUnit : ""}</div>
                        {showPer && (
                          <div className="text-3xs font-normal text-ink-3">
                            = {money(line.qty * line.rate * (lineN / lineDiv))}/yr
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          </div>

          {/* Totals */}
          {lineItems.length > 0 && (
            <div className="flex justify-end mb-6">
              <div className="w-full max-w-xs space-y-2 text-sm">
                <Row
                  label={perInvoice ? `Subtotal (per invoice)` : "Subtotal"}
                  value={fmtF(subtotal, ff?.subtotal)}
                />
                {discountPct > 0 && (
                  <Row
                    label={`Discount (${discountPct}%)`}
                    value={`−${fmtF(discount, ff?.discount)}`}
                    accent
                  />
                )}
                <Row label="Taxable amount" value={firstInst ? fmtInst(firstInst.taxable) : fmtF(taxable, ff?.taxable)} />
                {isExport ? (
                  <Row label="Export — zero-rated (LUT), no GST" value={money(0)} />
                ) : billOfSupply ? (
                  <p className="text-2xs text-ink-2 py-1">{billOfSupplyCustomerLine(billOfSupply)}</p>
                ) : interState ? (
                  <Row label={`IGST (${taxRate}%)`} value={firstInst ? fmtInst(firstInst.tax) : fmtF(tax, ff?.tax)} />
                ) : (
                  <>
                    <Row label={`CGST (${taxRate / 2}%)`} value={instHeads ? fmtInst(instHeads.cgst) : fmt(intra.cgst)} />
                    <Row label={`SGST (${taxRate / 2}%)`} value={instHeads ? fmtInst(instHeads.sgst) : fmt(intra.sgst)} />
                  </>
                )}
                <div className="border-t-2 border-ink pt-2 mt-2">
                  <div className="flex justify-between items-baseline">
                    <span className="text-2xs uppercase tracking-widest font-semibold">
                      {perInvoice ? `Per invoice (${billingN}/yr)` : "Grand total"}
                    </span>
                    <span className="font-serif text-2xl tabular-nums">
                      {firstInst
                        ? fmtInst(firstInst.gross)
                        : ff
                        ? fmtF(total, ff.total)
                        : perInvoice
                        ? `${money(Math.round(total / totalsDiv))}${billingUnit}`
                        : money(total)}
                    </span>
                  </div>
                  {perInvoice && (
                    <div className="flex justify-between items-baseline mt-1.5 text-ink-3">
                      <span className="text-2xs">Annual contract value</span>
                      <span className="text-sm tabular-nums">{splitPlan ? money(splitPlan.instalmentsGross) : money(annualContractValue(total, billingN, firstCommitment))}/yr</span>
                    </div>
                  )}
                  {isForeign && (
                    <div className="flex justify-between items-baseline mt-1.5 text-ink-3">
                      <span className="text-2xs">INR equivalent (for GST) @ ₹{exchangeRate}/{currency}</span>
                      <span className="text-sm tabular-nums">{rupee(total)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Default free support, included (R-367) */}
          {includedSupport && (
            <div className="mb-6 pt-4 border-t border-hairline" data-testid="included-support">
              <p className="text-sm text-ink-2">{includedSupport.text}</p>
              <p className="text-2xs text-ink-3">{includedSupport.detail}</p>
            </div>
          )}

          {/* Notes */}
          {notes && (
            <div className="mb-6 pt-4 border-t border-hairline">
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-1.5">
                Notes
              </p>
              <p className="text-sm text-ink-2 whitespace-pre-wrap leading-relaxed">
                {notes}
              </p>
            </div>
          )}

          {/* Terms & conditions */}
          {termsConditions?.trim() && (
            <div className={`mb-6 ${notes ? "" : "pt-4 border-t border-hairline"}`}>
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-1.5">
                Terms &amp; conditions
              </p>
              <p className="text-sm text-ink-2 whitespace-pre-wrap leading-relaxed">
                {termsConditions.trim()}
              </p>
            </div>
          )}

          {/* Terms footer */}
          <div className="pt-5 mt-6 border-t border-hairline text-2xs text-ink-3 leading-relaxed space-y-1">
            <p>
              <b>Payment terms:</b> Net 7 days from acceptance. UPI / NEFT / Razorpay accepted.
            </p>
            <p>
              <b>Quote validity:</b> {validityDays} days from issue date.
            </p>
            {payQr && (
              /* R-1694: the same block QuotePDF prints (upiRow) — same QR, same words. */
              <div className="flex items-start gap-3 py-2" data-testid="preview-upi-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={payQr.dataUrl}
                  alt={`UPI QR code to pay ${tenantName} ${rupee(payQr.amount)}`}
                  className="h-24 w-24 shrink-0 rounded border border-hairline bg-white"
                  data-testid="preview-upi-qr"
                />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-ink-2">Scan to pay this advance</p>
                  <p>Any UPI app — GPay, PhonePe, Paytm, BHIM.</p>
                  <p className="font-mono text-xs font-semibold text-ink-2 break-all">{payQr.vpa}</p>
                  <p>
                    Amount and quote number are pre-filled. You&apos;ll receive a receipt
                    voucher, and {billOfSupply ? "a Bill of Supply" : "a GST tax invoice"} when the order is provisioned.
                  </p>
                </div>
              </div>
            )}
            <p>
              Thank you for considering {tenantName}.{tenantEmail && (
                <> Reach out at <span className="font-mono">{tenantEmail}</span> for any clarifications.</>
              )}
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-ink-3">{label}</span>
      <span className={`tabular-nums ${accent ? "text-emerald" : "text-ink"}`}>{value}</span>
    </div>
  );
}
