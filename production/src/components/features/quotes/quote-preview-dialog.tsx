/**
 * QuotePreviewDialog — customer-facing preview of the quote as it will appear
 * in the PDF / email. Opens from QuoteBuilder "Preview" button.
 *
 * Print-friendly layout matching what the customer sees.
 */
"use client";

import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { isForeignCurrency, foreignEquivalent, formatForeign } from "@/lib/currency";
import { splitIntraStateTax } from "@/lib/gst/tax-split";
import type { QuoteLineItem, LineCommitment, BillingCycle } from "@/lib/supabase/database.types";
import {
  cycleInvoicesPerYear, cycleUnitLabel, cycleScheduleLabel, cycleFromLegacyCommitment,
} from "@/lib/quotes/billing";
import { includedSupportLine } from "@/lib/pdf/quote-support-line";

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
  /** Export supply (recipient outside India) → zero-rated under LUT, no GST. */
  isExport?:     boolean;
  /** Billing currency + rate — foreign → the whole quote shows in that currency. */
  currency?:     string | null;
  exchangeRate?: number | null;
  /** Quote-level invoice frequency (migration 0161); falls back to legacy per-line commitment. */
  billingCycle?: BillingCycle;
  validityDays:  number;
  notes:         string;
  termsConditions?: string | null;
  isProspect?:   boolean;
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
  isExport = false,
  currency,
  exchangeRate,
  billingCycle,
  validityDays,
  notes,
  termsConditions,
  isProspect = false,
}: Props) {
  // First letter of tenant name → brand monogram (e.g. "Excel Technologies" → "E")
  const brandInitial = (tenantName?.trim()?.[0] ?? "?").toUpperCase();
  const expiresOn = new Date(Date.now() + validityDays * 86400000);

  // Billing frequency is a single quote-level value (migration 0161). Fall back
  // to the legacy per-line commitment for quotes written before the split.
  const firstCommitment: LineCommitment | undefined = lineItems[0]?.commitment;
  const effectiveCycle: BillingCycle = billingCycle ?? cycleFromLegacyCommitment(firstCommitment);
  const billingN     = cycleInvoicesPerYear(effectiveCycle);
  const billingUnit  = cycleUnitLabel(effectiveCycle);
  const perInvoice   = billingN > 1;
  // Foreign customer → show the whole quote in their currency (USD…); books stay ₹,
  // so the INR equivalent is printed as a GST reference near the total.
  const isForeign    = isForeignCurrency(currency);
  const fxRate       = exchangeRate ?? 1;
  const money        = (n: number) =>
    isForeign ? formatForeign(foreignEquivalent(n, fxRate), currency ?? "") : rupee(n);
  const fmt          = (n: number) =>
    perInvoice ? `${money(Math.round(n / billingN))}${billingUnit}` : money(n);

  // R-212: the same CGST/SGST split the email and the PDF print (lib/gst/tax-split).
  const intra        = splitIntraStateTax(tax);
  // R-367: the same "Support: Free — Included" line the PDF prints (one builder).
  const includedSupport = includedSupportLine(lineItems);

  const handlePrint = () => {
    window.print();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto p-0">
        <DialogTitle className="sr-only">Quote preview · {quoteId}</DialogTitle>

        {/* Toolbar (hidden when printing) */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-hairline bg-paper-2 sticky top-0 z-10 print:hidden">
          <div className="flex items-center gap-2">
            <Icon name="file" size={16} className="text-ink-3" />
            <span className="text-sm font-semibold text-ink">Preview</span>
            <span className="text-xs text-ink-3">· This is how the customer will see it</span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" icon="printer" onClick={handlePrint}>
              Print / Save as PDF
            </Button>
            <Button size="sm" variant="ghost" icon="x" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </div>

        {/* ─────── PDF-style document ─────── */}
        <div className="bg-paper p-10 print:p-0 font-sans text-ink">
          {/* Brand header */}
          <div className="flex items-start justify-between border-b-2 border-ink pb-5 mb-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-md bg-ink text-paper grid place-items-center font-serif text-2xl">
                {brandInitial}
              </div>
              <div>
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
            <div className="text-right">
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold">
                Quotation
              </p>
              <p className="font-serif text-3xl mt-1">{quoteId}</p>
              <p className="text-xs text-ink-3 mt-1">
                Dated: {formatDate(new Date())}
              </p>
              <p className="text-xs text-ink-3">
                Valid until: <b>{formatDate(expiresOn)}</b>
              </p>
            </div>
          </div>

          {/* Bill to */}
          <div className="grid grid-cols-2 gap-6 mb-6">
            <div>
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
              {isProspect && (
                <p className="text-2xs text-amber-ink mt-2 italic print:hidden">
                  Internal: this is a prospect — customer record pending payment
                </p>
              )}
            </div>
            <div className="text-right">
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-1.5">
                Place of supply
              </p>
              <p className="text-sm">
                {isExport
                  ? "Export · zero-rated under LUT (no GST)"
                  : interState ? "Inter-state (IGST applies)" : "Intra-state (CGST + SGST)"}
              </p>
              {lineItems.length > 0 && firstCommitment && (
                <>
                  <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mt-3 mb-1.5">
                    Billing schedule
                  </p>
                  <p className="text-sm">{scheduleLabel(firstCommitment, effectiveCycle)}</p>
                  {billingN > 1 && (
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
          <table className="w-full mb-6">
            <thead className="border-y-2 border-ink">
              <tr>
                <th className="text-left py-2 text-2xs uppercase tracking-wider font-semibold text-ink">Description</th>
                <th className="text-right py-2 text-2xs uppercase tracking-wider font-semibold text-ink w-20">Qty</th>
                <th className="text-right py-2 text-2xs uppercase tracking-wider font-semibold text-ink w-32">Rate</th>
                <th className="text-right py-2 text-2xs uppercase tracking-wider font-semibold text-ink w-36">Amount</th>
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
                lineItems.map((line) => {
                  // Frequency is quote-level now (0161) — every line shares it.
                  const lineN    = billingN;
                  const lineUnit = billingUnit;
                  const showPer  = lineN > 1;
                  const rate     = showPer ? Math.round(line.rate / lineN) : line.rate;
                  const amount   = line.qty * rate;
                  return (
                    <tr key={line.id} className="border-b border-hairline">
                      <td className="py-3 text-sm">
                        <p className="font-medium text-ink">{line.name}</p>
                        <p className="text-2xs text-ink-3 mt-0.5">
                          Per seat{showPer ? "" : " per year"} · HSN 998313
                          {line.commitment && (
                            <> · {scheduleLabel(line.commitment, effectiveCycle)}</>
                          )}
                        </p>
                        {line.bulk && line.domains && line.domains.length > 0 && (
                          <p className="text-2xs text-ink-3 mt-0.5">
                            Covering {line.domains.length} domains: {line.domains.map((d) => `${d.domain} (${d.seats})`).join(", ")}
                          </p>
                        )}
                      </td>
                      <td className="py-3 text-right text-sm tabular-nums">{line.qty}</td>
                      <td className="py-3 text-right text-sm tabular-nums">
                        {money(rate)}{showPer ? lineUnit : ""}
                      </td>
                      <td className="py-3 text-right text-sm tabular-nums font-medium">
                        <div>{money(amount)}{showPer ? lineUnit : ""}</div>
                        {showPer && (
                          <div className="text-3xs font-normal text-ink-3">
                            = {money(line.qty * line.rate)}/yr
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>

          {/* Totals */}
          {lineItems.length > 0 && (
            <div className="flex justify-end mb-6">
              <div className="w-full max-w-xs space-y-2 text-sm">
                <Row
                  label={perInvoice ? `Subtotal (per invoice)` : "Subtotal"}
                  value={fmt(subtotal)}
                />
                {discountPct > 0 && (
                  <Row
                    label={`Discount (${discountPct}%)`}
                    value={`−${fmt(discount)}`}
                    accent
                  />
                )}
                <Row label="Taxable amount" value={fmt(taxable)} />
                {isExport ? (
                  <Row label="Export — zero-rated (LUT), no GST" value={money(0)} />
                ) : interState ? (
                  <Row label={`IGST (${taxRate}%)`} value={fmt(tax)} />
                ) : (
                  <>
                    <Row label={`CGST (${taxRate / 2}%)`} value={fmt(intra.cgst)} />
                    <Row label={`SGST (${taxRate / 2}%)`} value={fmt(intra.sgst)} />
                  </>
                )}
                <div className="border-t-2 border-ink pt-2 mt-2">
                  <div className="flex justify-between items-baseline">
                    <span className="text-2xs uppercase tracking-widest font-semibold">
                      {perInvoice ? `Per invoice (${billingN}/yr)` : "Grand total"}
                    </span>
                    <span className="font-serif text-2xl tabular-nums">
                      {perInvoice
                        ? `${money(Math.round(total / billingN))}${billingUnit}`
                        : money(total)}
                    </span>
                  </div>
                  {perInvoice && (
                    <div className="flex justify-between items-baseline mt-1.5 text-ink-3">
                      <span className="text-2xs">Annual contract value</span>
                      <span className="text-sm tabular-nums">{money(total)}/yr</span>
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
