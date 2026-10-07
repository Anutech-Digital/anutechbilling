/**
 * TaxInvoiceDialog — GST-compliant Tax Invoice (CGST Section 31).
 *
 * Difference from ReceiptVoucher:
 *   - Receipt voucher = "advance received" proof; ITC NOT claimable
 *   - Tax invoice     = "supply made" proof;     ITC IS claimable by customer
 *
 * Legal requirement (Section 31 + Rule 53): if advances were received earlier
 * against this supply (and Receipt Vouchers were issued), the final invoice MUST
 * reference those vouchers and show the net payable after adjustment. Otherwise
 * the customer's ITC chain breaks at audit.
 */
"use client";

import * as React from "react";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { logoDataUri } from "@/lib/pdf/logo";
import { useRouter } from "next/navigation";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate, toWhatsAppDigits, GST_STATE_BY_CODE } from "@/lib/utils";
import { isExportSupply, placeOfSupplyLabel } from "@/lib/gst/place-of-supply";
import { isForeignCurrency, foreignEquivalent, formatForeign } from "@/lib/currency";
import type { Invoice, Payment, QuoteLineItem } from "@/lib/supabase/database.types";
import { splitTaxHeads } from "@/lib/gst/tax-split";
import { SAAS_HSN } from "@/lib/gst/hsn";

/** Display-shape for advance rows in the dialog — works for both frozen + live data */
interface DisplayAdvance {
  id:          string;         // unique React key
  voucher_no:  string | null;
  amount:      number;
  received_at: string;
  method:      string;
}

interface Props {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
  invoice:      Invoice;

  /** Quote data — line items, discount, tax rate (so we can re-render the breakdown) */
  lineItems:    QuoteLineItem[];
  subtotal:     number;
  discountPct:  number;
  discount:     number;
  taxable:      number;
  taxRate:      number;
  tax:          number;
  total:        number;

  /**
   * Live payments against the parent quote — used ONLY when the invoice
   * doesn't yet have a frozen adjusted_advances snapshot (legacy data).
   * For new invoices generated after migration 0005, the dialog reads
   * directly from invoice.adjusted_advances to preserve the immutable
   * record (refunds become credit notes, not edits to original invoice).
   */
  receivedPayments?: Payment[];

  /** Place-of-supply: customer state vs tenant state (different → IGST) */
  interState?:  boolean;

  /** Customer info */
  customerGstin?:   string | null;
  customerEmail?:   string | null;
  /** Recipient WhatsApp/phone — enables the free wa.me "Share on WhatsApp" action. */
  customerPhone?:   string | null;
  customerAddress?: string | null;
  customerState?:   string | null;
  /** Recipient country — a foreign country marks an export (zero-rated under LUT). */
  customerCountry?: string | null;
  /** Billing currency + rate (books stay ₹). Foreign → show the foreign equivalent. */
  currency?:        string | null;
  exchangeRate?:    number | null;

  /** Tenant (supplier) info */
  tenantName:    string;
  tenantGstin?:  string | null;
  tenantEmail?:  string | null;
  tenantPhone?:  string | null;
  tenantAddress?: string | null;
  tenantState?:   string | null;
}

export function TaxInvoiceDialog({
  open,
  onOpenChange,
  invoice,
  lineItems,
  subtotal,
  discountPct,
  discount,
  taxable,
  taxRate,
  tax,
  total,
  receivedPayments,
  interState = false,
  customerGstin: liveCustomerGstin,
  customerEmail,
  customerPhone,
  customerAddress: liveCustomerAddress,
  customerState: liveCustomerState,
  customerCountry: liveCustomerCountry,
  currency,
  exchangeRate,
  tenantName,
  tenantGstin: liveTenantGstin,
  tenantEmail,
  tenantPhone,
  tenantAddress,
  tenantState: liveTenantState,
}: Props) {
  /* Logo yahan se aata hai, parent se nahi — ek prop thread karne ka matlab hota har
     parent me yaad rakhna, aur ek bhoolne par us document par logo chup-chaap gayab.
     Hook parent me pehle se chal raha hai, to ye query muft hai.
     (30 Sep 2026: yahan "chaar parent — invoices ×2, payments, quotes/[id]" likha tha.
     Ginne par ab EK hai: app/(app)/invoices/page.tsx. §25 niyam 1 — purani ginti thik ki,
     chhodi nahi; par wajah waise ki waise hai, aur doosra parent kabhi bhi wapas aa sakta
     hai.) */
  const { data: me } = useCurrentUser();
  const router = useRouter();
  const [downloadingPdf, setDownloadingPdf] = React.useState(false);

  // ── Immutable GST figures (CGST Sec 31 — an issued invoice cannot change) ──
  // Prefer the values FROZEN on the invoice row at generation (migration 0116)
  // over the live props derived from the *current* quote/customer. Otherwise a
  // later customer-state edit would retroactively flip an issued invoice's
  // CGST/SGST ↔ IGST heads (audit bug #24). Fall back to the live props only for
  // legacy invoices issued before 0116 (frozen columns null).
  const fInter   = invoice.inter_state   ?? interState;
  const fTaxable = invoice.taxable_value ?? taxable;
  const fTax     = invoice.tax_amount    ?? tax;
  const fRate    = invoice.tax_rate      ?? taxRate;
  const fTotal   = invoice.amount        ?? total;

  /* R-043 (1 Oct 2026): the PARTIES as they stood on the day of issue, frozen on the row
     by trg_invoice_snapshot_parties. The props are the customer/company as they are NOW;
     reading those let a later customer edit (new GSTIN, moved state) rewrite an invoice the
     buyer already holds. Once a row carries its snapshot, a NULL GSTIN there means "buyer
     unregistered at issue" — never fall back to today's GSTIN. Rows with no snapshot at all
     (none after the backfill) still use the live props. */
  const hasSnapshot = invoice.seller_state_code != null || invoice.pos_state_code != null || invoice.billing_address != null;
  const customerGstin   = hasSnapshot ? invoice.customer_gstin : liveCustomerGstin;
  const customerAddress = invoice.billing_address ?? liveCustomerAddress;
  const customerCountry = invoice.customer_country ?? liveCustomerCountry;
  const customerState   = invoice.pos_state_code && invoice.pos_state_code !== "96"
    ? (GST_STATE_BY_CODE[invoice.pos_state_code] ?? liveCustomerState)
    : liveCustomerState;
  const tenantGstin     = invoice.seller_gstin ?? liveTenantGstin;
  const tenantState     = invoice.seller_state_code
    ? (GST_STATE_BY_CODE[invoice.seller_state_code] ?? liveTenantState)
    : liveTenantState;

  /* R-046: one definition of the CGST/SGST split, shared with the GSTR-1 return.
     For a positive whole-rupee tax this is EXACTLY what `Math.round(tax / 2)` gave, so
     nothing on an ordinary invoice moves — said plainly rather than sold as a fix. What it
     removes is the divergence at the edges: a NEGATIVE tax (a credit note reverses an
     invoice) rounds the wrong way in JS — Math.round(-90.5) is -90, so the odd rupee flips
     heads and the note reverses CGST/SGST differently from the invoice it credits. Six
     copies of this arithmetic existed; this is the one the statutory documents use. */
  const { cgst, sgst, igst } = splitTaxHeads(fTax, fInter);

  // Export (international) supply → zero-rated under LUT; the invoice carries an
  // export declaration instead of a CGST/SGST/IGST split.
  const isExport = isExportSupply(customerCountry);
  /* Rule 46: state NAME and CODE, from the code frozen at issue. */
  const placeOfSupply = placeOfSupplyLabel({ posCode: invoice.pos_state_code, interState: fInter, isExport, country: customerCountry });
  const isForeign = isForeignCurrency(currency);
  const fxRate = exchangeRate ?? 1;
  // Export invoices display in the CLIENT's currency (USD…); books stay ₹, so the
  // INR equivalent is shown as a GST reference. `money()` renders in that currency.
  const money = (inr: number) => (isForeign ? formatForeign(foreignEquivalent(inr, fxRate), currency ?? "") : rupee(inr));

  // ── Advance adjustment ────────────────────────────────────────────────
  // Prefer FROZEN snapshot from invoice itself (legally correct — once issued,
  // an invoice is immutable; later refunds get a separate Credit Note).
  // Fall back to live payments only if the invoice predates migration 0005.
  const frozen = invoice.adjusted_advances ?? [];
  const displayAdvances: DisplayAdvance[] = frozen.length > 0
    ? frozen.map((a) => ({
        id:          a.payment_id,
        voucher_no:  a.voucher_no,
        amount:      a.amount,
        received_at: a.received_at,
        method:      a.method,
      }))
    : (receivedPayments ?? []).map((p) => ({
        id:          p.id,
        voucher_no:  p.receipt_voucher_no,
        amount:      p.amount,
        received_at: p.received_at,
        method:      p.method,
      }));

  const advancesAdjusted = displayAdvances.reduce((s, a) => s + a.amount, 0);
  // Prefer frozen net_payable from invoice — guaranteed to match what was issued
  const netPayable       = invoice.net_payable ?? Math.max(0, fTotal - advancesAdjusted);

  const [sharing, setSharing] = React.useState(false);

  /** Render + download the invoice PDF. Shared by the Download button and the
   *  WhatsApp share flow (so the file is ready for the owner to attach). */
  async function downloadPdf(): Promise<void> {
    const { downloadInvoicePDF } = await import("@/lib/pdf");
    const { payMethods } = await import("@/lib/pdf/pay-methods");
    /* R-038. Whether Razorpay exists lives in tenant_secrets, which is owner-only under
       RLS — so the browser asks the server for the yes/no rather than guessing. An
       unreadable answer resolves to FALSE, because the defect being fixed is an invoice
       naming a gateway the seller may not have (AGENTS.md §2: a failure must not become
       a plausible value). Understating costs the customer one line of information;
       overstating sends them to a payment route that does not open. */
    let razorpayConfigured = false;
    try {
      const r = await fetch("/api/tenant/pay-methods", { cache: "no-store" });
      if (r.ok) razorpayConfigured = Boolean((await r.json())?.razorpayConfigured);
    } catch { /* stays false */ }

    await downloadInvoicePDF({
      /* Same helper as the server builder, so the file this button produces and the one
         the customer is emailed cannot disagree about how they may pay. */
      payMethods: payMethods({
        upiVpa: me?.tenantUpiVpa ?? null,
        bank: {
          bankName:      me?.tenantRemitBankName      ?? null,
          accountName:   me?.tenantRemitAccountName   ?? me?.tenantName ?? null,
          accountNumber: me?.tenantRemitAccountNumber ?? null,
          ifsc:          me?.tenantRemitIfsc          ?? null,
          branch:        me?.tenantRemitBranch        ?? null,
        },
        razorpayConfigured,
      }),
      invoice, lineItems, subtotal, discountPct, discount,
      taxable: fTaxable, taxRate: fRate, tax: fTax, total: fTotal, interState: fInter,
      customerGstin, customerEmail, customerAddress, customerState, customerCountry,
      currency, exchangeRate,
      tenantName, tenantGstin, tenantEmail, tenantPhone,
      tenantAddress, tenantState, placeOfSupply,
      tenantLogo: await logoDataUri(me?.tenantLogoUrl),
    });
  }

  /** Free wa.me share — opens WhatsApp with a prefilled Hinglish message, and
   *  downloads the PDF so the owner can attach it in the chat. No Cloud API /
   *  keys needed, so it works on day one. */
  async function shareOnWhatsApp(): Promise<void> {
    const dueLine = invoice.due_date ? `\nDue date: ${formatDate(invoice.due_date)}` : "";
    const amountLabel = advancesAdjusted > 0 ? "Net payable" : "Amount";
    const message =
      `Namaste ${invoice.customer_name},\n\n` +
      `Aapka Tax Invoice ${invoice.id} taiyaar hai.\n` +
      `${amountLabel}: ${money(netPayable)}${dueLine}\n\n` +
      `PDF attach kar raha hoon. Koi sawaal ho to bataiyega.\n\n` +
      `Dhanyavaad,\n${tenantName}`;
    const digits = toWhatsAppDigits(customerPhone);
    if (!digits) {
      toast.error("No phone number for this customer", {
        description: "Add a phone on the customer profile to send on WhatsApp.",
      });
      return;
    }
    // Device-aware target (matches the leads screen): mobile → wa.me deep link;
    // desktop → web.whatsapp.com/send (wa.me shows a landing page on desktop).
    const q = encodeURIComponent(message);
    const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
    const link = isMobile
      ? `https://wa.me/${digits}?text=${q}`
      : `https://web.whatsapp.com/send?phone=${digits}&text=${q}`;
    // Open WhatsApp synchronously (inside the click gesture) so pop-up blockers
    // don't eat it, THEN download the PDF for the owner to attach.
    window.open(link, "_blank", "noopener,noreferrer");
    setSharing(true);
    try {
      await downloadPdf();
      toast.success("Invoice PDF downloaded", {
        description: "Attach this PDF in the WhatsApp chat.",
      });
    } catch (err) {
      console.error("Invoice PDF failed:", err);
      toast.error("PDF didn't download — WhatsApp opened; download the PDF separately.");
    } finally {
      setSharing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto p-0">
        <DialogTitle className="sr-only">Tax Invoice · {invoice.id}</DialogTitle>

        {/* Toolbar */}
        {/* R-187: on a phone the buttons used to sit on one line and push "Download PDF" off
            the right edge. The row and the button group now wrap, and the title stays on
            one line (the "GST-compliant" tag shows from sm up; the document itself says it). */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-5 py-3 border-b border-hairline bg-paper-2 sticky top-0 z-10 print:hidden">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <Icon name="receipt" size={16} className="text-ink-3" />
            <span className="text-sm font-semibold text-ink whitespace-nowrap">
              Tax Invoice<span className="hidden sm:inline"> · GST-compliant</span>
            </span>
            {advancesAdjusted > 0 && (
              <span className="text-3xs uppercase tracking-wider bg-emerald-soft text-emerald-ink px-2 py-0.5 rounded-full font-semibold">
                ₹{advancesAdjusted.toLocaleString("en-IN")} advance adjusted
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2" data-toolbar-actions>
            {invoice.quote_id && (
              /* "View quote", not "Edit Quote".
                 Two things were wrong with the old label, and the smaller one is that this
                 button does not edit anything — it opens the quote hub, which is a
                 read-only view.

                 The larger one is that offering to EDIT beside an issued tax invoice is
                 the wrong idea to put in someone's head. Under CGST §31 an invoice is the
                 document of record; once it exists its figures are not editable, and a
                 correction is a credit or debit note (§34, and this schema has both). An
                 operator who believes the quote behind a paid invoice can be edited will
                 eventually try it on a real one. Reading the origin document is useful and
                 safe, so that is what this offers. */
              <Button
                size="sm"
                variant="outline"
                icon="file"
                onClick={() => {
                  onOpenChange(false);
                  router.push(`/quotes/${invoice.quote_id}` as any);
                }}
              >
                View quote
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              icon="whatsapp"
              loading={sharing}
              onClick={shareOnWhatsApp}
              title="WhatsApp par bhejein — PDF download hoga, chat me attach kar dein"
            >
              Send on WhatsApp
            </Button>
            <Button
              size="sm"
              icon="download"
              loading={downloadingPdf}
              onClick={async () => {
                setDownloadingPdf(true);
                try {
                  /* 5 Oct 2026, "Download PDF does not respond": the in-browser react-pdf render
                     could hang without resolving or throwing — the button sat in loading forever,
                     and an error, when there was one, only reached the console. Measured: the
                     server renders the same InvoicePDF in ~4 s (it is the copy the customer is
                     emailed), so it goes first; the browser render is the fallback, with a 25 s
                     limit; if both fail, the person is told instead of left waiting. */
                  const r = await fetch(`/api/invoices/${encodeURIComponent(invoice.id)}/pdf-link`, { cache: "no-store" });
                  const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
                  if (!r.ok || !j.url) throw new Error(j.error || `HTTP ${r.status}`);
                  const a = document.createElement("a");
                  a.href = j.url;
                  a.download = `${invoice.id}.pdf`;
                  a.rel = "noopener";
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                } catch (err) {
                  console.error("Server PDF link failed — rendering in the browser:", err);
                  try {
                    await Promise.race([
                      downloadPdf(),
                      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("The PDF took too long")), 25_000)),
                    ]);
                  } catch (e2) {
                    toast.error("Could not make the PDF.", {
                      description: `${(e2 as Error).message}. Try again in a minute; if it keeps failing, report it from AI Help.`,
                    });
                  }
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

        {/* PDF body */}
        <div className="bg-paper p-10 print:p-0 font-sans text-ink">

          {/* Header */}
          <div className="text-center mb-4">
            <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold">
              Original for recipient · GST-compliant
            </p>
            <h1 className="font-serif text-3xl mt-1">Tax Invoice</h1>
            <p className="font-mono text-sm text-ink-2 mt-1">{invoice.id}</p>
            {invoice.gst_irn && (
              <p className="font-mono text-3xs text-ink-3 mt-0.5">IRN: {invoice.gst_irn}</p>
            )}
          </div>

          {/* Supplier + Recipient */}
          <div className="grid grid-cols-2 gap-6 mb-6 border-y-2 border-ink py-4">
            <div>
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-1.5">From (Supplier)</p>
              <p className="font-serif text-lg leading-tight">{tenantName}</p>
              {tenantGstin && (
                <p className="text-xs text-ink-2 mt-0.5 font-mono">GSTIN: {tenantGstin}</p>
              )}
              {tenantAddress && (
                <p className="text-xs text-ink-3 mt-0.5">{tenantAddress}</p>
              )}
              {tenantState && (
                <p className="text-xs text-ink-3 mt-0.5">State: {tenantState}</p>
              )}
              {tenantEmail && <p className="text-xs text-ink-3 font-mono">{tenantEmail}</p>}
              {tenantPhone && <p className="text-xs text-ink-3 font-mono">{tenantPhone}</p>}
            </div>
            <div className="text-right">
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-1.5">Bill To (Recipient)</p>
              <p className="font-serif text-lg leading-tight">{invoice.customer_name}</p>
              {customerGstin && (
                <p className="text-xs text-ink-2 mt-0.5 font-mono">GSTIN: {customerGstin}</p>
              )}
              {customerAddress && <p className="text-xs text-ink-3 mt-0.5">{customerAddress}</p>}
              {customerState && <p className="text-xs text-ink-3 mt-0.5">State: {customerState}</p>}
              {customerEmail && <p className="text-xs text-ink-3 font-mono">{customerEmail}</p>}
            </div>
          </div>

          {/* Invoice meta */}
          <div className="grid grid-cols-4 gap-4 mb-6 text-sm">
            <div>
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-0.5">Invoice No.</p>
              <p className="font-mono">{invoice.id}</p>
            </div>
            <div>
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-0.5">Invoice Date</p>
              <p>{formatDate(invoice.invoice_date)}</p>
            </div>
            <div>
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-0.5">Due Date</p>
              <p>{invoice.due_date ? formatDate(invoice.due_date) : "—"}</p>
            </div>
            <div>
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-0.5">Place of supply</p>
              <p>{placeOfSupply}</p>
            </div>
          </div>

          {/* Line items */}
          <div className="border-2 border-ink rounded-md overflow-hidden mb-4">
            <table className="w-full">
              <thead className="bg-paper-2 border-b border-ink">
                <tr>
                  <th className="text-left  p-2.5 text-3xs uppercase tracking-wider font-semibold w-8">#</th>
                  <th className="text-left  p-2.5 text-3xs uppercase tracking-wider font-semibold">Description</th>
                  <th className="text-left  p-2.5 text-3xs uppercase tracking-wider font-semibold w-20">HSN/SAC</th>
                  <th className="text-right p-2.5 text-3xs uppercase tracking-wider font-semibold w-16">Qty</th>
                  <th className="text-right p-2.5 text-3xs uppercase tracking-wider font-semibold w-24">Rate</th>
                  <th className="text-right p-2.5 text-3xs uppercase tracking-wider font-semibold w-28">Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.length === 0 ? (
                  <tr>
                    {/* R-010 §24. This used to read "No line items recorded on the parent
                        quote." on every project invoice, which named the wrong cause (a
                        project invoice HAS no parent quote) and gave the operator nothing
                        to do. A tax invoice without a description is defective under CGST
                        Rule 46(g) and the buyer's credit is what is at risk, so the line
                        says that and says the next step. */}
                    <td colSpan={6} className="p-3 text-center text-sm text-rose italic">
                      No description on this invoice — GST Rule 46 requires one.
                      Raise a credit note and issue it again with line items.
                    </td>
                  </tr>
                ) : (
                  lineItems.map((li, i) => (
                    <tr key={li.id} className="border-b border-hairline last:border-0">
                      <td className="p-2.5 text-xs text-ink-3">{i + 1}</td>
                      <td className="p-2.5 text-sm">
                        <p className="font-medium">{li.name}</p>
                        {li.description && (
                          <p className="text-2xs text-ink-3 mt-0.5">{li.description}</p>
                        )}
                      </td>
                      {/* R-010. Was the literal 998313 on every line of every invoice —
                          the third copy of a value lib/gst/hsn.ts exists to hold one copy
                          of. A project line carries its own SAC (998314, IT design and
                          development); a SaaS line carries none and falls back here. */}
                      <td className="p-2.5 font-mono text-2xs text-ink-2">{li.hsn ?? SAAS_HSN}</td>
                      <td className="p-2.5 text-right tabular-nums text-sm">{li.qty}</td>
                      <td className="p-2.5 text-right tabular-nums text-sm">{money(li.rate)}</td>
                      <td className="p-2.5 text-right tabular-nums text-sm font-medium">
                        {money(li.qty * li.rate)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Totals block — right-aligned */}
          <div className="flex justify-end mb-6">
            <table className="w-80 text-sm">
              <tbody>
                <tr>
                  <td className="py-1 text-ink-3">Subtotal</td>
                  <td className="py-1 text-right tabular-nums">{money(subtotal)}</td>
                </tr>
                {discountPct > 0 && (
                  <tr>
                    <td className="py-1 text-ink-3">Discount ({discountPct}%)</td>
                    <td className="py-1 text-right tabular-nums text-rose">− {money(discount)}</td>
                  </tr>
                )}
                <tr className="border-t border-hairline">
                  <td className="py-1 text-ink-3">Taxable value</td>
                  <td className="py-1 text-right tabular-nums">{money(fTaxable)}</td>
                </tr>
                {isExport ? (
                  <tr>
                    <td className="py-1 text-ink-3">Export — zero-rated (LUT), no GST</td>
                    <td className="py-1 text-right tabular-nums">{money(0)}</td>
                  </tr>
                ) : fInter ? (
                  <tr>
                    <td className="py-1 text-ink-3">IGST @ {fRate}%</td>
                    <td className="py-1 text-right tabular-nums">{money(igst)}</td>
                  </tr>
                ) : (
                  <>
                    <tr>
                      <td className="py-1 text-ink-3">CGST @ {fRate / 2}%</td>
                      <td className="py-1 text-right tabular-nums">{money(cgst)}</td>
                    </tr>
                    <tr>
                      <td className="py-1 text-ink-3">SGST @ {fRate / 2}%</td>
                      <td className="py-1 text-right tabular-nums">{money(sgst)}</td>
                    </tr>
                  </>
                )}
                <tr className="border-t-2 border-ink">
                  <td className="py-2 font-semibold uppercase tracking-wider text-2xs">
                    Invoice total
                  </td>
                  <td className="py-2 text-right">
                    <span className="font-serif text-xl tabular-nums">{money(fTotal)}</span>
                    {isForeign && (
                      <span className="block text-2xs text-ink-3 font-normal">
                        INR equivalent (for GST): {rupee(fTotal)} @ ₹{exchangeRate}/{currency}
                      </span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* ── Advance adjustment section (CGST Sec 31 + Rule 53) ── */}
          {advancesAdjusted > 0 && (
            <div className="rounded-md bg-emerald-soft/40 border border-emerald/30 p-4 mb-6">
              <p className="text-3xs uppercase tracking-widest text-emerald-ink font-semibold mb-2 flex items-center gap-1.5">
                <Icon name="check_circle" size={12} />
                Advances adjusted against this invoice
              </p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-emerald/20">
                    <th className="text-left  py-1.5 font-semibold text-ink-3 w-32">Voucher No.</th>
                    <th className="text-left  py-1.5 font-semibold text-ink-3">Received on</th>
                    <th className="text-left  py-1.5 font-semibold text-ink-3 w-32">Method</th>
                    <th className="text-right py-1.5 font-semibold text-ink-3 w-32">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {displayAdvances.map((a) => (
                    <tr key={a.id} className="border-b border-emerald/10 last:border-0">
                      <td className="py-1.5 font-mono text-2xs">
                        {a.voucher_no ?? <span className="italic text-ink-3">(unnumbered)</span>}
                      </td>
                      <td className="py-1.5 text-ink-2">{formatDate(a.received_at)}</td>
                      <td className="py-1.5 text-ink-2 capitalize">{a.method.replace("_", " ")}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(a.amount)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-emerald/30">
                    <td colSpan={3} className="py-2 font-semibold text-emerald-ink">Total adjusted</td>
                    <td className="py-2 text-right font-semibold tabular-nums text-emerald-ink">
                      − {money(advancesAdjusted)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* Net payable */}
          <div className="flex justify-end mb-6">
            <div className="w-80 border-2 border-ink rounded-md p-4 bg-paper-2">
              <div className="flex justify-between items-baseline">
                <span className="text-2xs uppercase tracking-widest font-semibold text-ink-3">
                  {advancesAdjusted > 0 ? "Net payable" : "Amount due"}
                </span>
                <span className="font-serif text-3xl tabular-nums">{money(netPayable)}</span>
              </div>
              {advancesAdjusted > 0 && netPayable === 0 && (
                <p className="text-2xs text-emerald-ink mt-1.5 flex items-center gap-1">
                  <Icon name="check_circle" size={11} />
                  Fully settled via advance payments — no further amount due.
                </p>
              )}
            </div>
          </div>

          {/* Amount in words */}
          <p className="text-xs text-ink-3 mb-6">
            <b>Invoice total (in words):</b> {amountInWords(fTotal)} only.
            {advancesAdjusted > 0 && (
              <>
                {" · "}
                <b>Net payable (in words):</b> {amountInWords(netPayable)} only.
              </>
            )}
          </p>

          {/* Compliance footer */}
          <div className="rounded-md bg-amber-soft border border-amber/30 p-3 text-2xs text-amber-ink mb-6">
            <p className="font-semibold mb-1">📋 GST treatment</p>
            <p>
              {isExport ? (
                <>
                  <b>Export of service</b> to a recipient outside India ({customerCountry ?? "—"}) —
                  <b> zero-rated supply</b> made under a <b>Letter of Undertaking (LUT)</b> without
                  payment of IGST (IGST Act §16 / CGST §31). <b>No GST is charged.</b>
                </>
              ) : (
                <>
                  This is a Tax Invoice issued under <b>CGST Section 31</b>. Recipient may claim
                  Input Tax Credit (ITC) of ₹{fTax.toLocaleString("en-IN")} subject to compliance
                  with CGST Section 16.
                </>
              )}
              {advancesAdjusted > 0 && (
                <>
                  {" "}
                  Advances of <b>{rupee(advancesAdjusted)}</b> received earlier (against
                  Receipt Voucher{displayAdvances.length === 1 ? "" : "s"}{" "}
                  {displayAdvances.map((a) => a.voucher_no).filter(Boolean).join(", ")})
                  have been adjusted against this invoice as required by{" "}
                  <b>Rule 53 of CGST Rules</b>.
                </>
              )}
            </p>
          </div>

          {/* Signature */}
          <div className="mt-10 pt-6 border-t border-hairline grid grid-cols-2 gap-6">
            <div>
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-8">
                Customer acknowledgment
              </p>
              <div className="h-px bg-ink w-32" />
            </div>
            <div className="text-right">
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-8">
                For {tenantName}
              </p>
              <div className="h-px bg-ink w-32 ml-auto" />
              <p className="text-2xs text-ink-3 mt-1">Authorized signatory</p>
            </div>
          </div>

          {/* Footer */}
          <p className="text-center text-3xs text-ink-3 mt-8">
            This is a system-generated tax invoice — valid without seal.
            {invoice.gst_irn && " IRN attested by NIC."}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────── Amount in words (Indian) ──────────────────────
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

  const parts: string[] = [];
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
