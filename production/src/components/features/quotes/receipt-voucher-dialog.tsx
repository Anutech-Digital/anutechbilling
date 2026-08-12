/**
 * ReceiptVoucherDialog — GST-compliant advance receipt voucher.
 *
 * Issued when payment is received but tax invoice not yet generated.
 * Per CGST Section 13: time of supply for services = earlier of invoice OR payment,
 * so GST liability arises on advance receipt. This document records that.
 *
 * Customer uses this for their books / ITC claim. Final tax invoice supersedes it.
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
import type { Payment } from "@/lib/supabase/database.types";

interface Props {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
  payment:      Payment;
  customerName: string;
  customerGstin?:   string | null;
  customerEmail?:   string | null;
  customerAddress?: string | null;
  tenantName:    string;
  tenantGstin?:  string | null;
  tenantEmail?:  string | null;
  tenantPhone?:  string | null;
  tenantAddress?: string | null;
  /** Tenant's registered state — shown in "Place of supply" when intra-state.
   *  No fallback to hardcoded "Maharashtra" — show explicit placeholder if missing. */
  tenantState?:  string | null;
  /** Whether this is intra-state (CGST + SGST) or inter-state (IGST) */
  interState?: boolean;
  /** Reference back to the quote for context */
  quoteId?:    string;
  /** GST rate (default 18% for SaaS) */
  gstRate?:    number;
}

export function ReceiptVoucherDialog({
  open,
  onOpenChange,
  payment,
  customerName,
  customerGstin,
  customerEmail,
  customerAddress,
  tenantName,
  tenantGstin,
  tenantEmail,
  tenantPhone,
  tenantAddress,
  tenantState,
  interState = false,
  quoteId,
  gstRate = 18,
}: Props) {
  const [downloadingPdf, setDownloadingPdf] = React.useState(false);

  // GST calculation — reverse-out from gross amount (Indian standard)
  // amount received = taxable + GST → taxable = amount × 100 / (100 + rate)
  const taxable = Math.round((payment.amount * 100) / (100 + gstRate));
  const totalTax = payment.amount - taxable;
  const cgst = Math.round(totalTax / 2);
  const sgst = totalTax - cgst;
  const igst = totalTax;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto p-0">
        <DialogTitle className="sr-only">Receipt voucher · {payment.receipt_voucher_no}</DialogTitle>

        {/* Toolbar — hidden when printing */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-hairline bg-paper-2 sticky top-0 z-10 print:hidden">
          <div className="flex items-center gap-2">
            <Icon name="file" size={16} className="text-ink-3" />
            <span className="text-sm font-semibold text-ink">Receipt Voucher · GST-compliant</span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              icon="whatsapp"
              onClick={() => {
                const q = encodeURIComponent(`Namaste ${customerName},\n\nAapka Advance Receipt Voucher ${payment.receipt_voucher_no || ""} (₹${payment.amount.toLocaleString("en-IN")}) received ho gaya hai.\n\nDhanyavaad,\n${tenantName}`);
                window.open(`https://web.whatsapp.com/send?text=${q}`, "_blank");
              }}
            >
              WhatsApp
            </Button>
            <Button
              size="sm"
              icon="download"
              loading={downloadingPdf}
              onClick={async () => {
                setDownloadingPdf(true);
                try {
                  const { downloadReceiptVoucherPDF } = await import("@/lib/pdf");
                  await downloadReceiptVoucherPDF({
                    payment,
                    customerName, customerGstin, customerEmail, customerAddress,
                    tenantName, tenantGstin, tenantEmail, tenantPhone,
                    tenantAddress, tenantState,
                    interState, gstRate, quoteId,
                  });
                } catch (err) {
                  console.error("Receipt voucher PDF failed:", err);
                } finally {
                  setDownloadingPdf(false);
                }
              }}
            >
              Download PDF
            </Button>
            <Button size="sm" variant="ghost" icon="x" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </div>

        {/* PDF-style document */}
        <div className="bg-paper p-10 print:p-0 font-sans text-ink">

          {/* Header */}
          <div className="text-center mb-4">
            <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold">
              GST-compliant advance receipt
            </p>
            <h1 className="font-serif text-3xl mt-1">Receipt Voucher</h1>
            <p className="font-mono text-sm text-ink-2 mt-1">{payment.receipt_voucher_no ?? "(not numbered)"}</p>
          </div>

          {/* Tenant + Customer rows */}
          <div className="grid grid-cols-2 gap-6 mb-6 border-y-2 border-ink py-4">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold mb-1.5">From (Supplier)</p>
              <p className="font-serif text-lg leading-tight">{tenantName}</p>
              {tenantGstin && (
                <p className="text-xs text-ink-2 mt-0.5 font-mono">GSTIN: {tenantGstin}</p>
              )}
              {tenantAddress && (
                <p className="text-xs text-ink-3 mt-0.5">{tenantAddress}</p>
              )}
              {tenantEmail && (
                <p className="text-xs text-ink-3 font-mono">{tenantEmail}</p>
              )}
              {tenantPhone && (
                <p className="text-xs text-ink-3 font-mono">{tenantPhone}</p>
              )}
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold mb-1.5">To (Recipient)</p>
              <p className="font-serif text-lg leading-tight">{customerName}</p>
              {customerGstin && (
                <p className="text-xs text-ink-2 mt-0.5 font-mono">GSTIN: {customerGstin}</p>
              )}
              {customerAddress && (
                <p className="text-xs text-ink-3 mt-0.5">{customerAddress}</p>
              )}
              {customerEmail && (
                <p className="text-xs text-ink-3 font-mono">{customerEmail}</p>
              )}
            </div>
          </div>

          {/* Voucher meta */}
          <div className="grid grid-cols-3 gap-4 mb-6 text-sm">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold mb-0.5">Voucher No.</p>
              <p className="font-mono">{payment.receipt_voucher_no ?? "—"}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold mb-0.5">Date received</p>
              <p>{formatDate(payment.received_at)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold mb-0.5">Payment method</p>
              <p className="capitalize">{payment.method.replace("_", " ")}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold mb-0.5">Transaction ref.</p>
              <p className="font-mono text-xs">{payment.reference ?? "—"}</p>
            </div>
            {quoteId && (
              <div>
                <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold mb-0.5">Against quote</p>
                <p className="font-mono text-xs">{quoteId}</p>
              </div>
            )}
            <div>
              <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold mb-0.5">Place of supply</p>
              <p>
                {interState
                  ? "Inter-state (IGST)"
                  : tenantState
                    ? `Intra-state, ${tenantState} (CGST + SGST)`
                    : "Intra-state (CGST + SGST)"}
              </p>
            </div>
          </div>

          {/* Description + breakdown */}
          <div className="border-2 border-ink rounded-md overflow-hidden mb-6">
            <table className="w-full">
              <thead className="bg-paper-2 border-b border-ink">
                <tr>
                  <th className="text-left p-3 text-[11px] uppercase tracking-wider font-semibold">Description</th>
                  <th className="text-right p-3 text-[11px] uppercase tracking-wider font-semibold w-36">Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-hairline">
                  <td className="p-3 text-sm">
                    <p className="font-medium">Advance received against {quoteId ? `quote ${quoteId}` : "service"}</p>
                    <p className="text-[11px] text-ink-3 mt-0.5">HSN/SAC: 998313 · Reseller services</p>
                  </td>
                  <td className="p-3 text-right tabular-nums text-sm font-medium">{rupee(taxable)}</td>
                </tr>
                {interState ? (
                  <tr className="border-b border-hairline">
                    <td className="p-3 text-sm text-ink-2">IGST @ {gstRate}%</td>
                    <td className="p-3 text-right tabular-nums text-sm">{rupee(igst)}</td>
                  </tr>
                ) : (
                  <>
                    <tr className="border-b border-hairline">
                      <td className="p-3 text-sm text-ink-2">CGST @ {gstRate / 2}%</td>
                      <td className="p-3 text-right tabular-nums text-sm">{rupee(cgst)}</td>
                    </tr>
                    <tr className="border-b border-hairline">
                      <td className="p-3 text-sm text-ink-2">SGST @ {gstRate / 2}%</td>
                      <td className="p-3 text-right tabular-nums text-sm">{rupee(sgst)}</td>
                    </tr>
                  </>
                )}
                <tr className="bg-paper-2">
                  <td className="p-3 text-sm font-semibold uppercase tracking-wider text-[11px]">
                    Total amount received
                  </td>
                  <td className="p-3 text-right">
                    <span className="font-serif text-2xl tabular-nums">{rupee(payment.amount)}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Amount in words */}
          <p className="text-xs text-ink-3 mb-6">
            <b>Amount received (in words):</b> {amountInWords(payment.amount)} only.
          </p>

          {/* GST compliance notice */}
          <div className="rounded-md bg-amber-soft border border-amber/30 p-3 text-[11px] text-amber-ink mb-6">
            <p className="font-semibold mb-1">📋 GST treatment of this advance</p>
            <p>
              Per CGST Section 13(2), time of supply for services is the earlier of invoice issue
              or payment receipt — so GST is recognized on this advance. A formal{" "}
              <b>Tax Invoice</b> will be issued separately upon completion of service / full payment,
              and this receipt voucher will be adjusted against that invoice.
            </p>
          </div>

          {/* Notes */}
          {payment.notes && (
            <div className="mb-4">
              <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold mb-1">Notes</p>
              <p className="text-sm text-ink-2">{payment.notes}</p>
            </div>
          )}

          {/* Signature block */}
          <div className="mt-10 pt-6 border-t border-hairline grid grid-cols-2 gap-6">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold mb-8">Customer signature</p>
              <div className="h-px bg-ink w-32" />
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold mb-8">For {tenantName}</p>
              <div className="h-px bg-ink w-32 ml-auto" />
              <p className="text-[11px] text-ink-3 mt-1">Authorized signatory</p>
            </div>
          </div>

          {/* Footer */}
          <p className="text-center text-[10px] text-ink-3 mt-8">
            This is a system-generated receipt voucher — valid without seal.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ──────────── Amount in words (Indian format with lakh / crore) ────────────
function amountInWords(n: number): string {
  if (n === 0) return "Rupees Zero";
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
                "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  const two = (n: number): string => {
    if (n < 20) return ones[n];
    return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
  };
  const three = (n: number): string => {
    if (n < 100) return two(n);
    return ones[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + two(n % 100) : "");
  };

  let parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  if (crore > 0) {
    parts.push(three(crore) + " Crore");
    n %= 10000000;
  }
  const lakh = Math.floor(n / 100000);
  if (lakh > 0) {
    parts.push(three(lakh) + " Lakh");
    n %= 100000;
  }
  const thousand = Math.floor(n / 1000);
  if (thousand > 0) {
    parts.push(three(thousand) + " Thousand");
    n %= 1000;
  }
  if (n > 0) parts.push(three(n));

  return "Rupees " + parts.join(" ");
}
