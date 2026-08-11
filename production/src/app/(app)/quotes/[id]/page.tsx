/**
 * /quotes/[id] — quote detail page with status + payment workflow + invoice action.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useQuote, useDeleteQuote, quoteDeleteBlockReason } from "@/lib/queries/quotes";
import { useGenerateInvoice } from "@/lib/queries/invoices";
import { isInterStateSupply } from "@/lib/gst/place-of-supply";
import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Button, IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ActivityTimeline, type TimelineEvent } from "@/components/shared/activity-timeline";
import { MarginPill, computeMargin } from "@/components/features/margin-pill";
import { RecordPaymentDialog } from "@/components/features/quotes/record-payment-dialog";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import { ReceiptVoucherDialog } from "@/components/features/quotes/receipt-voucher-dialog";
import { SendQuoteDialog } from "@/components/features/quotes/send-quote-dialog";
import SendWhatsAppDialog from "@/components/features/whatsapp/send-whatsapp-dialog";
import { usePaymentsByQuote, totalReceived as sumReceived } from "@/lib/queries/payments";
import { useCustomer } from "@/lib/queries/customers";
import { useLead } from "@/lib/queries/leads";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { rupee, formatDate, daysBetween, toWhatsAppDigits } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { Quote, QuoteLineItem, Payment } from "@/lib/supabase/database.types";

// ============================================================
// Status meta
// ============================================================
const STATUS_META: Record<Quote["status"], { kind: "muted" | "success" | "warning" | "danger" | "info"; label: string }> = {
  draft:    { kind: "muted",   label: "Draft" },
  sent:     { kind: "warning", label: "Sent" },
  viewed:   { kind: "info",    label: "Viewed" },
  accepted: { kind: "success", label: "Accepted" },
  rejected: { kind: "danger",  label: "Rejected" },
  expired:  { kind: "danger",  label: "Expired" },
};

const PAYMENT_META: Record<Quote["payment_status"], { kind: "muted" | "success" | "warning" | "info" | "danger"; label: string }> = {
  none:     { kind: "muted",   label: "Not awaiting" },
  awaiting: { kind: "warning", label: "Awaiting payment" },
  partial:  { kind: "info",    label: "Partially paid" },
  received: { kind: "info",    label: "Payment received" },
  invoiced: { kind: "success", label: "Invoiced" },
};

// ============================================================
// Page
// ============================================================
export default function QuoteDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { data: quote, isLoading, error } = useQuote(params.id);
  const { data: paymentHistory } = usePaymentsByQuote(params.id);
  const { data: customer } = useCustomer(quote?.customer_id ?? undefined);
  // Prospect quotes have no customer yet — fall back to the lead's phone so the
  // WhatsApp recipient still prefills (quotes usually go to that same contact).
  const { data: lead } = useLead(quote?.lead_id ?? undefined);
  const recipientPhone = React.useMemo(() => {
    const raw = customer?.contact_phone || lead?.contact_phone || "";
    const d = raw.replace(/\D/g, "");
    if (!d) return "";
    // WhatsApp needs a country code — assume India (+91) for a bare 10-digit number.
    return d.startsWith("91") ? `+${d}` : d.length === 10 ? `+91${d}` : `+${d}`;
  }, [customer?.contact_phone, lead?.contact_phone]);
  const { data: me } = useCurrentUser();
  const qc = useQueryClient();
  const deleteQuote = useDeleteQuote();
  const [paymentOpen, setPaymentOpen] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [downloadingPdf, setDownloadingPdf] = React.useState(false);
  const [sharingWa, setSharingWa] = React.useState(false);
  const [receiptPayment, setReceiptPayment] = React.useState<Payment | null>(null);
  const [sendOpen,    setSendOpen]    = React.useState(false);
  const [whatsOpen,   setWhatsOpen]   = React.useState(false);
  // "Can't delete" → show WHICH related records block it (invoice + payments).
  const [blockedOpen, setBlockedOpen] = React.useState(false);
  // In-app confirm dialog — native window.confirm() is suppressed in some
  // embeds/webviews and silently returns false, which made destructive actions
  // (Reopen, Delete) look dead. See tasks/page.tsx for the same fix.
  const [confirm, setConfirm] = React.useState<{
    title: string; body: string; confirmLabel: string; icon: string; danger?: boolean;
    onConfirm: () => void;
  } | null>(null);

  // Auto-open a send dialog when the builder redirected here with ?send=
  // (?send=whatsapp or ?send=email). Use a ref to only fire once per
  // navigation so closing the dialog doesn't immediately re-open it.
  const searchParams = useSearchParams();
  const sendIntent   = searchParams.get("send");
  const sendIntentHandled = React.useRef(false);
  React.useEffect(() => {
    if (sendIntentHandled.current) return;
    if (!quote)                     return;            // wait for data
    if (sendIntent === "whatsapp") {
      setWhatsOpen(true);
      sendIntentHandled.current = true;
      router.replace(`/quotes/${quote.id}` as never);   // clean the URL
    } else if (sendIntent === "email") {
      setSendOpen(true);
      sendIntentHandled.current = true;
      router.replace(`/quotes/${quote.id}` as never);
    }
  }, [sendIntent, quote, router]);

  const totalReceivedSoFar = sumReceived(paymentHistory ?? []);
  // Records that keep this quote un-deletable (must be voided/refunded first).
  const receivedPayments = (paymentHistory ?? []).filter((p) => p.status === "received");

  // Inter-state? Compare customer state code vs tenant (seller) state code.
  const interState = isInterStateSupply(customer?.state_code, me?.tenantStateCode);

  // Delete — blocked for quotes with a recorded payment (cascade would wipe the
  // ledger). On success, navigate back to the list since this record is gone.
  const deleteBlock = quote ? quoteDeleteBlockReason(quote) : null;
  const handleDelete = () => {
    if (!quote) return;
    if (deleteBlock) { toast.error(deleteBlock); return; }
    setConfirm({
      title: `Delete quote ${quote.id}?`,
      body: "This permanently deletes the quote. It cannot be undone.",
      confirmLabel: "Delete",
      icon: "trash",
      danger: true,
      onConfirm: () => deleteQuote.mutate(quote, { onSuccess: () => router.push("/quotes" as never) }),
    });
  };

  // ────────── Mutations ──────────
  const sendQuote = useMutation({
    mutationFn: async () => {
      const supabase = createClient();
      const { error } = await supabase.from("quotes").update({ status: "sent" }).eq("id", params.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quotes", params.id] });
      toast.success("Quote marked as sent");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  /**
   * Mark accepted (without payment) — calls accept_quote RPC which:
   *   - Sets quote.status = 'accepted'
   *   - Converts lead → customer (so the customer record exists immediately,
   *     even before payment lands)
   *   - Marks lead.stage = 'won'
   * Subscription is still created later via record_payment when money arrives.
   */
  const markAccepted = useMutation({
    mutationFn: async () => {
      const res  = await fetch(`/api/quotes/${params.id}/mark-accepted`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not mark as accepted");
      return json as { customerId: string; convertedNow: boolean };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quotes", params.id] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success(
        data.convertedNow
          ? "Quote accepted · customer record created · awaiting payment"
          : "Quote accepted · awaiting payment",
      );
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const markRejected = useMutation({
    mutationFn: async () => {
      const supabase = createClient();
      const { error } = await supabase.from("quotes").update({ status: "rejected" }).eq("id", params.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quotes", params.id] });
      toast("Quote marked as rejected");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  // Reopen — revert an accidentally-accepted quote back to 'sent'. The RPC
  // refuses if any money has moved (invoice/payment); the customer + lead stay.
  const reopenQuote = useMutation({
    mutationFn: async () => {
      const supabase = createClient();
      const { error } = await supabase.rpc("reopen_quote", { p_quote_id: params.id });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quotes", params.id] });
      toast.success("Quote reopened — moved back to Sent");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  // Use the central useGenerateInvoice hook — it calls next_document_number RPC
  // (sequential GST-compliant), compute_advance_adjustment RPC (frozen
  // snapshot per Rule 53), and links quote_id correctly. The previous local
  // implementation used Math.random() which broke all three properties.
  const generateInvoice = useGenerateInvoice();

  // ────────── Loading / Error ──────────
  if (isLoading) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
        <Skeleton className="h-12 w-1/2" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !quote) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <EmptyState
          icon="alert"
          title={error ? "Could not load quote" : "Quote not found"}
          body={error?.message ?? "This quote does not exist in your tenant."}
          action={
            <Button asChild variant="primary" icon="file">
              <Link href={"/quotes" as any}>Back to quotes</Link>
            </Button>
          }
        />
      </div>
    );
  }

  // ────────── Derived ──────────
  const status = STATUS_META[quote.status];
  const payment = PAYMENT_META[quote.payment_status];
  const items: QuoteLineItem[] = Array.isArray(quote.line_items) ? quote.line_items : [];
  const discount = Math.round(quote.subtotal * (quote.discount_pct / 100));
  const taxable = quote.subtotal - discount;
  const tax = Math.round(taxable * (quote.tax_rate / 100));
  const total = quote.amount ?? taxable + tax;
  const margin = computeMargin(quote.total_cost, taxable);

  const acceptUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/quote/${quote.id}/accept?t=${encodeURIComponent(quote.public_token)}`;

  /** Render + download the quote PDF. Shared by the Download button and the
   *  free WhatsApp share (so the file is ready for the owner to attach). */
  const downloadQuotePdfFile = async (): Promise<void> => {
    const { downloadQuotePDF } = await import("@/lib/pdf");
    await downloadQuotePDF({
      tenantName:    me?.tenantName    ?? "Workspace",
      tenantGstin:   me?.tenantGstin,
      tenantEmail:   me?.tenantEmail,
      tenantPhone:   me?.tenantPhone,
      tenantAddress: me?.tenantAddress,
      quoteId:       quote.id,
      customerName:  quote.customer_name,
      contactName:   null,
      contactEmail:  null,
      contactPhone:  null,
      createdDate:   quote.created_at,
      expiresDate:   quote.expires_date,
      validityDays:  quote.expires_date
        ? Math.max(1, daysBetween(new Date(quote.created_at), quote.expires_date))
        : 30,
      lineItems:     items,
      subtotal:      quote.subtotal,
      discountPct:   quote.discount_pct,
      discount,
      taxable,
      taxRate:       quote.tax_rate,
      tax,
      total,
      interState,
      notes:         quote.notes ?? "",
    });
  };

  /** Free wa.me share — opens WhatsApp with a prefilled Hinglish message (quote
   *  no · total · accept link) and downloads the PDF so the owner can attach it.
   *  No Cloud API / keys needed, so it works day one. */
  const shareQuoteOnWhatsApp = async (): Promise<void> => {
    const message =
      `Namaste ${quote.customer_name},\n\n` +
      `Aapka quotation ${quote.id} taiyaar hai.\n` +
      `Total: ${rupee(total)} (GST included)\n\n` +
      `Online review + accept yahan kar sakte hain:\n${acceptUrl}\n\n` +
      `PDF bhi attach kar raha hoon. Koi sawaal ho to bataiyega.\n\n` +
      `Dhanyavaad,\n${me?.tenantName ?? ""}`;
    const digits = toWhatsAppDigits(recipientPhone);
    if (!digits) {
      toast.error("No phone number for this customer/lead", {
        description: "Add a phone on the customer or lead to send on WhatsApp.",
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
    setSharingWa(true);
    try {
      await downloadQuotePdfFile();
      toast.success("Quote PDF downloaded", {
        description: "Attach this PDF in the WhatsApp chat.",
      });
    } catch (err) {
      console.error("Quote PDF failed:", err);
      toast.error("PDF didn't download — WhatsApp opened; download the PDF separately.");
    } finally {
      setSharingWa(false);
    }
  };
  const daysLeft = quote.expires_date ? daysBetween(new Date(), quote.expires_date) : null;

  // Activity timeline
  const events: TimelineEvent[] = [
    { icon: "file", kind: "indigo", title: "Quote created",
      body: `Draft created with ${items.length} line items`,
      time: formatDate(quote.created_date, "long") },
  ];
  if (quote.status !== "draft") {
    events.push({ icon: "send", kind: "indigo", title: "Sent to customer", body: `Quote shared with ${quote.customer_name}`, time: formatDate(quote.updated_at, "long") });
  }
  if (quote.status === "accepted") {
    events.push({ icon: "check_circle", kind: "emerald", title: "Customer accepted", body: "Quote accepted · payment workflow started", time: formatDate(quote.updated_at, "long") });
  }
  // Only record a "Payment received" event when money ACTUALLY landed. A quote
  // can be 'invoiced' with ₹0 received (invoice raised, awaiting payment) — the
  // old check keyed on payment_status === 'invoiced' and fell back to `total`,
  // fabricating a "Payment received · <full total>" with "undefined · ref: null".
  if (totalReceivedSoFar > 0) {
    const received = (paymentHistory ?? []).filter((p) => p.status === "received");
    const latest = received[received.length - 1];
    events.push({
      icon: "rupee", kind: "emerald",
      title: `Payment received · ${rupee(totalReceivedSoFar)}`,
      body: received.length > 1
        ? `${received.length} payments received`
        : latest?.method
          ? `${latest.method.toUpperCase()}${latest.reference ? ` · ref: ${latest.reference}` : ""}`
          : "Recorded",
      time: latest?.received_at ? formatDate(latest.received_at, "long") : "Recently",
    });
  }
  if (quote.payment_status === "invoiced" && quote.invoice_id) {
    events.push({
      icon: "receipt", kind: "emerald", title: `Invoice ${quote.invoice_id} generated`,
      body: "GST e-invoice ready",
      time: formatDate(quote.updated_at, "long"),
    });
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <IconButton icon="arrow_left" aria-label="Back" onClick={() => router.push("/quotes" as any)} />
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
              Revenue · {quote.is_extension ? "Extension Quote" : quote.is_renewal ? "Renewal Quote" : "Quote"}
            </p>
            <h1 className="font-serif text-3xl md:text-4xl leading-tight">
              {quote.id}
            </h1>
            <p className="text-sm text-ink-3 mt-1 flex items-center gap-2 flex-wrap">
              <span>
                For{" "}
                {quote.customer_id ? (
                  <Link
                    href={`/customers/${quote.customer_id}` as any}
                    className="font-semibold text-ink hover:text-amber-ink hover:underline"
                  >
                    {quote.customer_name}
                  </Link>
                ) : (
                  <b className="text-ink">{quote.customer_name}</b>
                )}
              </span>
              <span>·</span>
              <Badge kind={status.kind} dot>{status.label}</Badge>
              {quote.is_extension ? (
                <>
                  <span>·</span>
                  <Badge kind="warning">Extension · {Math.round((quote.extension_months ?? 12) / 12)} yr</Badge>
                </>
              ) : quote.is_renewal && (
                <>
                  <span>·</span>
                  <Badge kind="info">Renewal</Badge>
                </>
              )}
              {quote.payment_status !== "none" && (
                <>
                  <span>·</span>
                  <Badge kind={payment.kind} dot>{payment.label}</Badge>
                </>
              )}
            </p>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          <Button icon="file" onClick={() => setPreviewOpen(true)}>
            Preview
          </Button>
          <Button
            variant="primary"
            icon="whatsapp"
            loading={sharingWa}
            onClick={shareQuoteOnWhatsApp}
            title="WhatsApp par bhejein — PDF download hoga, chat me attach kar dein"
          >
            Send on WhatsApp
          </Button>
          <Button
            icon="download"
            loading={downloadingPdf}
            onClick={async () => {
              setDownloadingPdf(true);
              try {
                await downloadQuotePdfFile();
                toast.success(`${quote.id}.pdf downloaded`);
              } catch (err) {
                toast.error(`PDF generation failed: ${(err as Error).message}`);
              } finally {
                setDownloadingPdf(false);
              }
            }}
          >
            Download PDF
          </Button>
          {/* Secondary utilities collapse into an overflow menu so the header
              has one clear reading order — the money next-step lives in the
              status action bar below, not fighting these buttons. Delete is
              separated at the bottom to avoid a fat-finger next to Send. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button icon="more_h">More</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[13rem]">
              <DropdownMenuItem
                className="gap-2.5 py-2 cursor-pointer"
                onClick={() => {
                  navigator.clipboard?.writeText(acceptUrl);
                  toast.success("Customer link copied · share via email or WhatsApp");
                }}
              >
                <Icon name="link" size={15} /> Copy customer link
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2 cursor-pointer"
                onClick={() => setSendOpen(true)}
              >
                <Icon name="mail" size={15} /> {quote.status === "sent" ? "Resend via email" : "Send via email"}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2 cursor-pointer"
                onClick={() => setWhatsOpen(true)}
              >
                <Icon name="whatsapp" size={15} /> Send via WhatsApp automation (Cloud API)
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2 cursor-pointer"
                onClick={() => {
                  // Carry lead context forward if this quote was for a prospect
                  const params = new URLSearchParams();
                  params.set("duplicate", quote.id);
                  if (quote.lead_id)       params.set("leadId",  quote.lead_id);
                  if (quote.customer_name) params.set("company", quote.customer_name);
                  router.push(`/quotes/new?${params.toString()}` as any);
                }}
              >
                <Icon name="copy" size={15} /> Duplicate & edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {deleteBlock ? (
                <DropdownMenuItem
                  className="gap-2.5 py-2 cursor-pointer text-ink-2"
                  onClick={() => setBlockedOpen(true)}
                >
                  <Icon name="lock" size={15} /> Can&apos;t delete — why?
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  destructive
                  className="gap-2.5 py-2 cursor-pointer"
                  onClick={handleDelete}
                >
                  <Icon name="trash" size={15} /> Delete quote
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Status-aware action bar */}
      <Card>
        {quote.status === "draft" && (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm text-ink-3">This is a draft. Send it to the customer when ready.</div>
            <div className="flex gap-2">
              <Button asChild variant="default" icon="edit">
                <Link href={`/quotes/${quote.id}/edit` as any}>Edit</Link>
              </Button>
              <Button variant="primary" icon="send" loading={sendQuote.isPending} onClick={() => sendQuote.mutate()}>
                Mark as sent
              </Button>
            </div>
          </div>
        )}

        {/* Pre-acceptance row — only while the quote is genuinely still open.
            Once an invoice exists (payment_status 'invoiced' / invoice_id set),
            the invoice block below owns the payment action — showing "Mark
            accepted (no payment yet)" + "Record payment now" here too would be
            contradictory (deal already invoiced) and duplicate the balance
            button. */}
        {(quote.status === "sent" || quote.status === "viewed")
          && quote.payment_status !== "invoiced" && !quote.invoice_id && (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm text-ink-3">
              {daysLeft !== null && daysLeft > 0 && (
                <>Expires in <b>{daysLeft} days</b> · </>
              )}
              Customer accepted? Mark accepted to convert the lead into a customer.
              {" "}
              <span className="text-ink-2">Payment can land later — record it when received.</span>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button variant="ghost" loading={markRejected.isPending} onClick={() => markRejected.mutate()}>
                Mark rejected
              </Button>
              <Button variant="primary" icon="check_circle" loading={markAccepted.isPending} onClick={() => markAccepted.mutate()}>
                Mark accepted (no payment yet)
              </Button>
              <Button variant="primary" icon="rupee" onClick={() => setPaymentOpen(true)}>
                Record payment now
              </Button>
            </div>
          </div>
        )}

        {quote.status === "accepted" && quote.payment_status === "awaiting" && (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm">
              <span className="font-medium text-amber-ink">Awaiting payment of {rupee(total)}</span>{" "}
              <span className="text-ink-3">from {quote.customer_name}. Record payment when received — partial payments supported.</span>
            </div>
            <div className="flex gap-2 flex-wrap">
              {/* Reopen — undo an accidental accept (only while no money has moved). */}
              <Button
                variant="ghost"
                icon="arrow_left"
                loading={reopenQuote.isPending}
                onClick={() => setConfirm({
                  title: `Reopen quote ${quote.id}?`,
                  body: "It moves back to Sent so you can edit or re-send. The customer record stays — reverse this only if the accept was a mistake.",
                  confirmLabel: "Reopen quote",
                  icon: "arrow_left",
                  onConfirm: () => reopenQuote.mutate(),
                })}
              >
                Reopen
              </Button>
              <Button variant="primary" icon="rupee" onClick={() => setPaymentOpen(true)}>
                Record payment
              </Button>
            </div>
          </div>
        )}

        {quote.status === "accepted" && quote.payment_status === "partial" && (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm">
              <span className="font-medium text-indigo">
                Partially paid · {rupee(totalReceivedSoFar)} of {rupee(total)}
              </span>{" "}
              <span className="text-ink-3">
                ({rupee(total - totalReceivedSoFar)} remaining · {paymentHistory?.length ?? 0} payment{(paymentHistory?.length ?? 0) === 1 ? "" : "s"} so far)
              </span>
            </div>
            <Button variant="primary" icon="rupee" onClick={() => setPaymentOpen(true)}>
              Record next payment
            </Button>
          </div>
        )}

        {/* Generate Tax Invoice — legally allowed both for fully-received AND
            partial-paid quotes per CGST §13(2) (supply triggers invoicing,
            not full payment) + Rule 47 (30-day clock from first advance).
            The frozen advance-adjustment snapshot in the Invoice PDF shows
            customer exactly how much was already received via RV(s) and
            what's still due. */}
        {quote.status === "accepted"
          && (quote.payment_status === "received" || quote.payment_status === "partial") && (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm">
              {quote.payment_status === "received" ? (
                <>
                  <span className="font-medium text-emerald">
                    ✓ Payment of {rupee(quote.payment_amount ?? total)} received via {quote.payment_method?.toUpperCase()}
                  </span>{" "}
                  <span className="text-ink-3">on {quote.payment_received_at ? formatDate(quote.payment_received_at) : "—"}. You can now generate the GST invoice.</span>
                </>
              ) : (
                <>
                  <span className="font-medium text-amber-ink">
                    ⓘ Partial payment received · {rupee(quote.payment_amount ?? 0)} of {rupee(total)}
                  </span>{" "}
                  <span className="text-ink-3">
                    — service started? Issue the GST invoice now (legally allowed under CGST §13(2)).
                    Net payable on invoice will be <b className="text-ink">{rupee(Math.max(0, total - (quote.payment_amount ?? 0)))}</b>.
                  </span>
                </>
              )}
            </div>
            <Button
              variant="primary"
              icon="receipt"
              loading={generateInvoice.isPending}
              onClick={() => generateInvoice.mutate(params.id)}
            >
              Generate GST Invoice
            </Button>
          </div>
        )}

        {quote.payment_status === "invoiced" && quote.invoice_id && (() => {
          const balanceRemaining = Math.max(0, total - totalReceivedSoFar);
          const hasBalance = balanceRemaining > 0;
          // "Balance" only makes sense once SOME money has landed. With ₹0
          // received the whole amount is simply "due" and the action is
          // "Record payment" — not "Record balance payment".
          const nothingPaid = totalReceivedSoFar <= 0;
          return (
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm">
                {!hasBalance ? (
                  <span className="font-medium text-emerald">
                    ✓ Complete · Invoice fully paid
                  </span>
                ) : nothingPaid ? (
                  <>
                    <span className="font-medium text-amber-ink">
                      Invoice issued · {rupee(total)} due
                    </span>{" "}
                    <span className="text-ink-3">
                      Awaiting payment. Record it when received — no new receipt voucher needed (post-invoice).
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-medium text-amber-ink">
                      Invoice issued · {rupee(balanceRemaining)} balance due
                    </span>{" "}
                    <span className="text-ink-3">
                      Customer paid {rupee(totalReceivedSoFar)} of {rupee(total)}. Record the balance when received — no new receipt voucher needed (post-invoice).
                    </span>
                  </>
                )}
              </div>
              <div className="flex gap-2">
                {hasBalance && (
                  <Button variant="primary" icon="rupee" onClick={() => setPaymentOpen(true)}>
                    {nothingPaid ? "Record payment" : "Record balance payment"}
                  </Button>
                )}
                <Button asChild variant={hasBalance ? "ghost" : "primary"} icon="receipt">
                  <Link href={`/invoices` as any}>View invoice {quote.invoice_id}</Link>
                </Button>
              </div>
            </div>
          );
        })()}

        {(quote.status === "rejected" || quote.status === "expired") && (
          <div className="text-sm text-ink-3">
            This quote is {quote.status}. You can duplicate and re-send if needed.
          </div>
        )}
      </Card>

      {/* Line items */}
      <Card title="Line items" sub={`${items.length} item${items.length === 1 ? "" : "s"}`} flush>
        <table className="w-full">
          <thead className="bg-paper-2 border-b border-hairline">
            <tr>
              <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider w-12">#</th>
              <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Item</th>
              <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider w-24">Qty</th>
              <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider w-32">Rate</th>
              <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider w-32">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((line, i) => (
              <tr key={line.id} className="border-b border-hairline last:border-0">
                <td className="p-3 text-sm text-ink-3 tabular-nums">{i + 1}</td>
                <td className="p-3 text-sm font-medium">{line.name}</td>
                <td className="p-3 text-right tabular-nums text-sm">{line.qty}</td>
                <td className="p-3 text-right tabular-nums text-sm">{rupee(line.rate)}</td>
                <td className="p-3 text-right tabular-nums text-sm font-medium">{rupee(line.qty * line.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Totals + Margin */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Totals breakdown">
          <div className="space-y-2 text-sm">
            <Row label="Subtotal" value={rupee(quote.subtotal)} />
            {discount > 0 && <Row label={`Discount (${quote.discount_pct}%)`} value={`−${rupee(discount)}`} tone="emerald" />}
            <Row label="Taxable amount" value={rupee(taxable)} />
            <Row label={`GST (${quote.tax_rate}%)`} value={rupee(tax)} />
            <div className="border-t border-hairline pt-3 flex items-baseline justify-between">
              <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Total</span>
              <span className="font-serif text-2xl text-amber tabular-nums">{rupee(total)}</span>
            </div>
          </div>
        </Card>

        <Card title="Est. margin" sub="Post-discount · assumed cost">
          <div className="text-center py-3">
            <div className={cn(
              "font-serif text-5xl leading-none mb-2",
              margin.marginPct >= 18 ? "text-emerald" :
              margin.marginPct >= 14 ? "text-amber-ink" :
              "text-rose"
            )}>
              {rupee(margin.margin, { compact: true })}
            </div>
            <div className="text-sm text-ink-3 mb-3 tabular-nums">{margin.marginPct}% est. margin</div>
            <MarginPill margin={margin} period="one-time" estimated />
            <div className="text-[11px] text-ink-3 mt-3 tabular-nums">
              Cost: {rupee(margin.cost)} · Price: {rupee(margin.price)}
            </div>
          </div>
        </Card>
      </div>

      {/* Notes */}
      {quote.notes && (
        <Card title="Notes">
          <p className="text-sm text-ink-2 whitespace-pre-wrap">{quote.notes}</p>
        </Card>
      )}

      {/* Payment history (installments) */}
      {paymentHistory && paymentHistory.length > 0 && (
        <Card title="Payment history" sub={`${paymentHistory.length} payment${paymentHistory.length === 1 ? "" : "s"} · ${rupee(totalReceivedSoFar)} of ${rupee(total)} received`}>
          <table className="w-full">
            <thead className="bg-paper-2 border-b border-hairline">
              <tr>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Date</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Amount</th>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Method</th>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Reference</th>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Receipt</th>
              </tr>
            </thead>
            <tbody>
              {paymentHistory.map((p, idx) => (
                <tr key={p.id} className="border-b border-hairline last:border-0">
                  <td className="p-3 text-xs text-ink-2">
                    <div>{formatDate(p.received_at)}</div>
                    <div className="text-[10px] text-ink-3">#{idx + 1}</div>
                  </td>
                  <td className="p-3 text-right tabular-nums text-sm font-medium">
                    {rupee(p.amount)}
                  </td>
                  <td className="p-3 text-sm capitalize">{p.method.replace("_", " ")}</td>
                  <td className="p-3 font-mono text-xs text-ink-2 truncate max-w-[180px]">{p.reference ?? "—"}</td>
                  <td className="p-3">
                    {p.status === "received" ? (
                      <Badge kind="success" dot>received</Badge>
                    ) : (
                      <Badge kind="danger" dot>refunded</Badge>
                    )}
                    {p.receipt_voucher_no && (
                      <div className="text-[10px] text-ink-3 font-mono mt-0.5">{p.receipt_voucher_no}</div>
                    )}
                  </td>
                  <td className="p-3 text-right">
                    {p.status === "received" && me ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="file"
                        onClick={() => setReceiptPayment(p)}
                        title="GST-compliant receipt voucher"
                      >
                        View
                      </Button>
                    ) : (
                      <span className="text-[11px] text-ink-3">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {/* Total row */}
              <tr className="bg-paper-2">
                <td className="p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Total received</td>
                <td className="p-3 text-right font-serif text-lg tabular-nums text-emerald">{rupee(totalReceivedSoFar)}</td>
                <td colSpan={4} className="p-3 text-xs text-ink-3">
                  {totalReceivedSoFar >= total ? (
                    <span className="text-emerald">✓ Fully paid</span>
                  ) : (
                    <>Remaining <b className="text-amber-ink">{rupee(total - totalReceivedSoFar)}</b></>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}

      {/* Receipt Voucher dialog — opens for any "received" payment */}
      {me && receiptPayment && (
        <ReceiptVoucherDialog
          open={!!receiptPayment}
          onOpenChange={(open) => !open && setReceiptPayment(null)}
          payment={receiptPayment}
          customerName={customer?.name ?? quote.customer_name}
          customerGstin={customer?.gstin}
          customerEmail={customer?.contact_email}
          tenantName={me.tenantName}
          tenantGstin={me.tenantGstin}
          tenantEmail={me.tenantEmail}
          tenantPhone={me.tenantPhone}
          tenantAddress={me.tenantAddress}
          tenantState={me.tenantState}
          interState={interState}
          quoteId={quote.id}
        />
      )}

      {/* Activity timeline */}
      <Card title="Activity" sub="Workflow history">
        <ActivityTimeline events={events} />
      </Card>

      {/* Payment dialog */}
      <RecordPaymentDialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        quoteId={quote.id}
        customerName={quote.customer_name}
        expectedAmount={total}
        alreadyReceived={totalReceivedSoFar}
        isProspect={!!quote.lead_id && !quote.customer_id}
        invoiceId={quote.invoice_id}
        customerId={quote.customer_id}
        askDomain={!quote.is_one_off}
        defaultDomain={customer?.domain ?? lead?.domain ?? undefined}
      />

      {/* Customer-facing quote preview */}
      <QuotePreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        tenantName={me?.tenantName    ?? "Workspace"}
        tenantGstin={me?.tenantGstin}
        tenantEmail={me?.tenantEmail}
        tenantPhone={me?.tenantPhone}
        tenantAddress={me?.tenantAddress}
        quoteId={quote.id}
        customerName={quote.customer_name}
        contactName={null}
        contactEmail={null}
        contactPhone={null}
        lineItems={items}
        subtotal={quote.subtotal}
        discountPct={quote.discount_pct}
        discount={discount}
        taxable={taxable}
        taxRate={quote.tax_rate}
        tax={tax}
        total={total}
        interState={interState}
        validityDays={
          quote.expires_date
            ? Math.max(1, daysBetween(new Date(quote.created_at), quote.expires_date))
            : 30
        }
        notes={quote.notes ?? ""}
        isProspect={!!quote.lead_id}
      />

      {/* Send-via-email dialog — replaces legacy mailto: handler */}
      <SendQuoteDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        quoteId={quote.id}
        customerName={quote.customer_name}
        defaultRecipient={customer?.contact_email ?? null}
        alreadySent={quote.status === "sent" || quote.status === "viewed"}
      />

      {/* Send-via-WhatsApp dialog — pre-fills the customer's contact phone
          (or leaves blank for lead-mode quotes — user can type it in)
          and a templated opening line with the quote ID + accept link.
          attachQuoteId enables a PDF-attach checkbox in the dialog so the
          customer receives the actual quote PDF in WhatsApp, not just a
          link. */}
      {whatsOpen && (
        <SendWhatsAppDialog
          open={whatsOpen}
          onOpenChange={setWhatsOpen}
          defaultTo={recipientPhone}
          defaultText={
            `Hi ${quote.customer_name},\n\n` +
            `Your quote ${quote.id} for ${rupee(quote.amount)} is attached. ` +
            `You can also review and accept it online:\n` +
            `${typeof window !== "undefined" ? window.location.origin : ""}/quote/${quote.id}/accept?t=${encodeURIComponent(quote.public_token)}\n\n` +
            `— ${me?.tenantName ?? "Excel Technologies"}`
          }
          title={`Send quote ${quote.id} via WhatsApp`}
          attachQuoteId={quote.id}
          attachQuoteLabel={`Quote-${quote.id}.pdf`}
          // Preview the PDF in a new tab — uses the SAME renderer as
          // Download PDF + the server-side WhatsApp send path, so what
          // Pardeep reviews is exactly what the customer will receive.
          onPreviewAttachment={async () => {
            const { previewQuotePDF } = await import("@/lib/pdf");
            await previewQuotePDF({
              tenantName:    me?.tenantName    ?? "Workspace",
              tenantGstin:   me?.tenantGstin,
              tenantEmail:   me?.tenantEmail,
              tenantPhone:   me?.tenantPhone,
              tenantAddress: me?.tenantAddress,
              quoteId:       quote.id,
              customerName:  quote.customer_name,
              contactName:   customer?.contact_name ?? lead?.contact_name ?? null,
              contactEmail:  customer?.contact_email ?? lead?.contact_email ?? null,
              contactPhone:  recipientPhone || null,
              createdDate:   quote.created_at,
              expiresDate:   quote.expires_date,
              validityDays:  quote.expires_date
                ? Math.max(1, daysBetween(new Date(quote.created_at), quote.expires_date))
                : 30,
              lineItems:     items,
              subtotal:      quote.subtotal,
              discountPct:   quote.discount_pct,
              discount,
              taxable,
              taxRate:       quote.tax_rate,
              tax,
              total,
              interState,
              notes:         quote.notes ?? "",
              isRenewal:     quote.is_renewal,
            });
          }}
          related={{
            quoteId:    quote.id,
            customerId: quote.customer_id ?? undefined,
            leadId:     quote.lead_id ?? undefined,
          }}
        />
      )}

      {/* "Can't delete — why?" — shows the related records that block deletion
          (the invoice + recorded payments) so the owner knows what to void first. */}
      <Dialog open={blockedOpen} onOpenChange={setBlockedOpen}>
        <DialogContent className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon name="lock" size={18} className="text-amber" />
              Ye quote abhi delete nahi ho sakta
            </DialogTitle>
            <DialogDescription>
              Is quote pe paisa laga hua hai. Delete karne se payment ledger + audit trail mit jaayega.
              Pehle in related records ko hatana / void karna padega:
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {quote.invoice_id && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-hairline p-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Icon name="receipt" size={16} className="text-emerald shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink truncate">Invoice {quote.invoice_id}</div>
                    <div className="text-[11px] text-ink-3">Pehle ise credit-note / void karo</div>
                  </div>
                </div>
                <Button asChild variant="ghost" size="sm" icon="external" className="shrink-0">
                  <Link href={"/invoices" as any}>Open</Link>
                </Button>
              </div>
            )}

            {receivedPayments.length > 0 && (
              <div className="rounded-lg border border-hairline p-3">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Icon name="rupee" size={16} className="text-emerald shrink-0" />
                  <div className="text-sm font-medium text-ink">
                    {receivedPayments.length} payment{receivedPayments.length === 1 ? "" : "s"} · {rupee(totalReceivedSoFar)} received
                  </div>
                </div>
                <ul className="space-y-0.5 pl-6">
                  {receivedPayments.map((p, i) => (
                    <li key={p.id} className="text-[11px] text-ink-3 tabular-nums">
                      #{i + 1} · {rupee(p.amount)} · {p.method.replace("_", " ")} · {formatDate(p.received_at)}
                    </li>
                  ))}
                </ul>
                <div className="text-[11px] text-ink-3 mt-1.5 pl-6">Pehle inhe refund / void karo (Payment history se).</div>
              </div>
            )}

            {!quote.invoice_id && receivedPayments.length === 0 && (
              <p className="text-sm text-ink-3">{deleteBlock}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="primary" onClick={() => setBlockedOpen(false)}>Samajh gaya</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reusable confirm dialog (replaces native window.confirm, which is
          suppressed in some embeds and silently returns false). */}
      <Dialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <DialogContent className="max-w-[440px]">
          {confirm && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Icon name={confirm.icon} size={18} className={confirm.danger ? "text-rose" : "text-amber"} />
                  {confirm.title}
                </DialogTitle>
                <DialogDescription>{confirm.body}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant={confirm.danger ? "danger" : "primary"}
                  icon={confirm.icon}
                  loading={deleteQuote.isPending || reopenQuote.isPending}
                  onClick={() => { const fn = confirm.onConfirm; setConfirm(null); fn(); }}
                >
                  {confirm.confirmLabel}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================
// Row helper
// ============================================================
function Row({ label, value, tone }: { label: string; value: string; tone?: "emerald" | "rose" }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-ink-3">{label}</span>
      <span className={cn(
        "tabular-nums",
        tone === "emerald" && "text-emerald",
        tone === "rose" && "text-rose"
      )}>{value}</span>
    </div>
  );
}
