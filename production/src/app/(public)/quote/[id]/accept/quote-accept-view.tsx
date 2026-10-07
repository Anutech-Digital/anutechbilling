/**
 * QuoteAcceptView — client component for the public quote-accept page.
 * Handles billing-cycle aware display + accept/reject actions.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { BusyPanel } from "@/components/ui/busy-panel";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate, cn } from "@/lib/utils";
import { isForeignCurrency, formatForeign } from "@/lib/currency";
import { loadRazorpayCheckout } from "@/lib/razorpay/checkout-client";
import type { LineCommitment, BillingCycle } from "@/lib/supabase/database.types";
import {
  cycleInvoicesPerYear, cycleUnitLabel, cycleScheduleLabel, cycleFromLegacyCommitment,
} from "@/lib/quotes/billing";
import { quoteInstalments } from "@/lib/billing/instalments";
import { whatsAppLink } from "@/lib/marketing/review-request";

/** Customer-SAFE quote shape — no cost/margin. Built server-side in page.tsx. */
export type PublicQuote = {
  id: string;
  status: string;
  customer_name: string;
  subtotal: number;
  discount_pct: number;
  tax_rate: number;
  amount: number | null;
  expires_date: string | null;
  notes: string | null;
  billing_cycle?: BillingCycle;
  /** Billing currency + rate (migration 0153). Foreign → show the whole quote in
   *  that currency; the ₹ books value stays canonical server-side. */
  currency?: string | null;
  exchange_rate?: number | null;
};
export type PublicLine = {
  id: string;
  name: string;
  qty: number;
  rate: number;
  commitment?: LineCommitment;
  /* What the RESELLER decided the customer may change. Still only a hint to the UI —
     the server re-checks every one of these before it prices anything, because the
     public page has no session and everything it posts is attacker-controlled. */
  optional?: boolean;
  included_by_default?: boolean;
  seats_adjustable?: boolean;
  min_seats?: number;
  max_seats?: number;
};

function scheduleLabel(commitment: LineCommitment | undefined, cycle: BillingCycle): string {
  const tier = commitment === "monthly" ? "Monthly (flex)" : "Annual commit";
  return `${tier} · ${cycleScheduleLabel(cycle)}`;
}

interface Props {
  quote:         PublicQuote;
  lineItems:     PublicLine[];
  token:         string;
  /** Reseller has Razorpay wired + this is a ₹ quote → show "Pay online now". */
  payOnline?:    boolean;
  tenantName:    string;
  tenantGstin:   string | null;
  tenantEmail:   string | null;
  tenantPhone?:  string | null;
  tenantAddress?: string | null;
  /** UPI QR built server-side (`qrcode` never reaches the customer's bundle). */
  upiQr?: { dataUrl: string; vpa: string; amount: number } | null;
}

export function QuoteAcceptView({
  quote, lineItems, token, payOnline = false, tenantName, tenantGstin, tenantEmail, tenantPhone, tenantAddress,
  upiQr = null,
}: Props) {
  const [accepting, setAccepting] = React.useState(false);
  const [accepted, setAccepted] = React.useState(quote.status === "accepted");
  const [paying, setPaying] = React.useState(false);
  const [paid, setPaid] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [poOpen, setPoOpen] = React.useState(false);
  const [poNumber, setPoNumber] = React.useState("");
  const [poNotes, setPoNotes] = React.useState("");

  // ── Money, computed CONSISTENTLY in the display currency ──
  // For a foreign quote we work per-unit in the client's currency (₹ ÷ rate,
  // rounded to 2dp) and derive the line amounts + totals from THAT — so qty × rate
  // always equals the amount and the lines sum to the total. Converting each ₹
  // figure independently would let a rounded unit rate disagree with the exact
  // total (e.g. 32 × $32.00 ≠ $1,023.88). The books stay the canonical ₹.
  const fxRate    = quote.exchange_rate && quote.exchange_rate > 0 ? quote.exchange_rate : 1;
  const isForeign = isForeignCurrency(quote.currency);
  const dRound = (v: number) => (isForeign ? Math.round(v * 100) / 100 : Math.round(v));
  const toDisp = (inr: number) => (isForeign ? dRound(inr / fxRate) : inr);
  const fmtC   = (v: number) => (isForeign ? formatForeign(v, quote.currency ?? "") : rupee(v));

  const firstCommitment = lineItems[0]?.commitment;
  /* FLEX (pehli line commitment=monthly): quote ke stored aankde pehle se PER-MONTH
     hain — wahi seema jo quote-body.ts aur record_payment maante hain. Inhe 12 par
     baantna 1 Sep 2026 ko naapi gayi 12x under-charge/under-display thi. */
  const isFlex = firstCommitment === "monthly";
  const effectiveCycle: BillingCycle = quote.billing_cycle ?? cycleFromLegacyCommitment(firstCommitment);
  const billingN    = cycleInvoicesPerYear(effectiveCycle);
  const billingUnit = cycleUnitLabel(effectiveCycle);
  const perInvoice  = billingN > 1;

  // Per-line figures (annual) in the display currency — rounded unit → amount.
  const dispLines = lineItems.map((line) => {
    const unit   = toDisp(line.rate);       // per seat / year
    const amount = dRound(line.qty * unit); // line total / year
    return { line, unit, amount };
  });
  // ₹ canonical — used as-is for a domestic quote (no rounding drift vs the saved
  // amount); foreign rebuilds in the display currency from the rounded lines.
  const discountInr = Math.round(quote.subtotal * (quote.discount_pct / 100));
  const taxableInr  = quote.subtotal - discountInr;
  const taxInr      = Math.round(taxableInr * (quote.tax_rate / 100));
  const totalInr    = quote.amount ?? (taxableInr + taxInr);
  const dSubtotal = isForeign ? dRound(dispLines.reduce((s, x) => s + x.amount, 0)) : quote.subtotal;
  const dDiscount = isForeign ? dRound(dSubtotal * (quote.discount_pct / 100)) : discountInr;
  const dTaxable  = isForeign ? dRound(dSubtotal - dDiscount) : taxableInr;
  const dTax      = isForeign ? dRound(dTaxable * (quote.tax_rate / 100)) : taxInr;
  const dTotal    = isForeign ? dRound(dTaxable + dTax) : totalInr;

  // Format an ANNUAL display-currency figure, slicing per-invoice when the cycle
  // bills more than once a year.
  const fmtInv = (annual: number) =>
    isFlex ? `${fmtC(annual)}/mo`
    : perInvoice ? `${fmtC(dRound(annual / billingN))}${billingUnit}` : fmtC(annual);

  /* ─── Customer-adjustable configuration ──────────────────────────────────
     Deliberately DOMESTIC-ONLY. Mixing customer re-pricing with FX conversion means
     two independent sources of rounding on the same number, and this file already
     carries a careful comment about not rebuilding a ₹ total from rounded foreign
     lines. A foreign quote stays fixed; the reseller changes it by hand.

     The browser holds only the SHAPE. Every price on screen once something moves
     comes back from /configure — nothing here multiplies a rate by a seat count. */
  const adjustable = !isForeign && lineItems.some((l) => l.optional || l.seats_adjustable);
  const [choices, setChoices] = React.useState<Record<string, { seats?: number; included?: boolean }>>({});
  const [liveConfig, setLiveConfig] = React.useState<{
    subtotal: number; total: number; changed: boolean; selfAcceptable: boolean;
    lines: Array<{ lineId: string; qty: number; included: boolean; rate: number; amount: number; bandLabel: string | null; rePriced: boolean }>;
  } | null>(null);
  const [pricing, setPricing] = React.useState(false);
  const [signerName, setSignerName] = React.useState(quote.customer_name ?? "");
  /* Set when Confirm is pressed with no name, so the press says why (29 Sep 2026: a
     hover title was the only explanation, and a phone has no hover). */
  const [nameNudge, setNameNudge] = React.useState(false);
  /* True while the server prepares an online payment, until Razorpay's own window opens
     (30 Sep 2026: show the customer that something is happening). */
  const [preparingPay, setPreparingPay] = React.useState(false);
  const [signerTitle, setSignerTitle] = React.useState("");
  const [signerEmail, setSignerEmail] = React.useState("");
  const [changeRequested, setChangeRequested] = React.useState(false);

  const choiceList = React.useMemo(
    () => Object.entries(choices).map(([lineId, v]) => ({ lineId, ...v })),
    [choices],
  );

  React.useEffect(() => {
    if (!adjustable || choiceList.length === 0) { setLiveConfig(null); return; }
    let cancelled = false;
    setPricing(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/public/quote/${quote.id}/configure?t=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ choices: choiceList }),
        });
        const json = await res.json();
        if (!cancelled && res.ok) setLiveConfig(json);
      } catch {
        /* Leaving the previous figures on screen is wrong — they may no longer match
           what the customer has selected. Clear, and the original total shows again. */
        if (!cancelled) setLiveConfig(null);
      } finally {
        if (!cancelled) setPricing(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [choiceList, adjustable, quote.id, token]);

  /** The number the customer is agreeing to — the server's, whenever there is one. */
  const payableTotal = liveConfig ? liveConfig.total : dTotal;

  /**
   * On a split-billed quote, what is collected TODAY.
   *
   * The same helper /api/public/quote/[id]/pay charges from, deliberately. The
   * totals box and the pay button used to derive this two different ways —
   * payableTotal / billingN here, and nothing at all on the button, which showed the
   * whole term. A customer reading "₹7,080/qtr" above a button saying
   * "Pay online now · ₹28,320" has been shown two prices for one decision.
   *
   * Null for yearly, and then every line below behaves exactly as it always has.
   */
  const dueToday = React.useMemo(() => quoteInstalments({
    cycle:       effectiveCycle,
    termTaxable: (quote.subtotal ?? 0) - Math.round((quote.subtotal ?? 0) * (quote.discount_pct ?? 0) / 100),
    termGross:   payableTotal,
    taxRate:     quote.tax_rate ?? 18,
    // Flex me stored aankde per-month hain — split kuch hai hi nahi (12× ka parivar).
    lineCommitment: firstCommitment ?? null,
  }), [effectiveCycle, quote.subtotal, quote.discount_pct, quote.tax_rate, payableTotal, firstCommitment]);

  const [notifying, setNotifying] = React.useState(false);
  /**
   * "I've sent the payment" — tells the reseller to go and look.
   *
   * It records NOTHING about the payment. A direct UPI transfer has no webhook, so
   * the only thing this page knows is that the customer says they paid. Turning that
   * into a payment record would put an unverified amount into the reseller's books.
   */
  const handleUpiPaid = async () => {
    setNotifying(true);
    try {
      const res = await fetch(`/api/public/quote/${quote.id}/upi-notify?t=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signerName: signerName.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not send the message");
      toast.success(`${tenantName} has been told to check for your payment.`, {
        description: "They will confirm it and send your GST invoice.",
        duration: 8000,
      });
    } catch (e) {
      toast.error((e as Error).message, {
        description: tenantPhone ? `You can also call them on ${tenantPhone}.` : undefined,
      });
    } finally {
      setNotifying(false);
    }
  };

  const handleAccept = async () => {
    setAccepting(true);
    try {
      const res = await fetch(`/api/public/quote/${quote.id}/accept?t=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          choices: choiceList,
          signerName: signerName.trim() || undefined,
          signerTitle: signerTitle.trim() || undefined,
          signerEmail: signerEmail.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not accept");
      setConfirmOpen(false);
      /* The server may answer "not accepted, we have told the reseller" when the
         customer's changes need sign-off. That is a success, not an error — they did
         nothing wrong and the answer is "we will come back to you". */
      if (json.changeRequested) {
        setChangeRequested(true);
        toast.success("Sent to the reseller", { description: json.message, duration: 8000 });
        return;
      }
      setAccepted(true);
      toast.success("Quote accepted · the reseller has been notified");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAccepting(false);
    }
  };

  const handlePoAccept = async () => {
    setAccepting(true);
    try {
      const res = await fetch(`/api/public/quote/${quote.id}/accept?t=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poNumber: poNumber.trim(), notes: poNotes.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not accept quote");
      setPoOpen(false);
      setAccepted(true);
      toast.success("Quote accepted with Purchase Order · reseller notified");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAccepting(false);
    }
  };

  const handleRequestChanges = () => {
    if (!tenantEmail) {
      /* No email on file — WhatsApp the reseller's phone, or call it, instead of a
         toast that leads nowhere (R-234). */
      const wa = whatsAppLink(
        tenantPhone,
        `Hi ${tenantName}, I'd like to discuss some changes on quote ${quote.id} (total ${fmtC(dTotal)}) before accepting.`,
      );
      if (wa) {
        window.open(wa, "_blank", "noopener,noreferrer");
        return;
      }
      if (tenantPhone) {
        window.location.href = `tel:${tenantPhone}`;
        return;
      }
      toast.info(`Reply to the message ${tenantName} sent you with this quote to request changes.`);
      return;
    }
    const subject = `Changes requested on quote ${quote.id}`;
    const body =
      `Hi ${tenantName},\n\nI'd like to discuss some changes on quote ${quote.id} (total ${fmtC(dTotal)}) before accepting.\n\n` +
      `My questions / changes:\n\n[Type your message here]\n\nThanks,\n${quote.customer_name}`;
    window.location.href = `mailto:${tenantEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  const handlePayOnline = async () => {
    setPaying(true);
    setPreparingPay(true);
    try {
      const res = await fetch(`/api/public/quote/${quote.id}/pay?t=${encodeURIComponent(token)}`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not start payment");

      // Simulation (no live keys) — the server already recorded the payment.
      if (json.simulated) {
        setPreparingPay(false);
        setPaid(true);
        return;
      }

      // Live — open Razorpay Checkout. The webhook settles via record_payment
      // on capture; we just show the "payment received" screen on success.
      const RazorpayCtor = await loadRazorpayCheckout();
      const rzp = new RazorpayCtor({
        key:         json.razorpayKeyId,
        amount:      json.amount,
        currency:    json.currency,
        name:        tenantName,
        description: `Quote ${quote.id}`,
        order_id:    json.orderId,
        prefill:     { name: quote.customer_name ?? undefined },
        theme:       { color: "#C2410C" },
        handler:     () => { setPaid(true); },
        modal:       { ondismiss: () => setPaying(false) },
      });
      rzp.on("payment.failed", (r) => {
        toast.error(r.error?.description ?? "Payment failed — please try again.");
        setPaying(false);
      });
      rzp.open();
      setPreparingPay(false); // Razorpay's window now shows its own progress
    } catch (e) {
      toast.error((e as Error).message);
      setPreparingPay(false);
      setPaying(false);
    }
  };

  /* ──────────── Change requested ────────────
     A distinct screen from "accepted", because the customer must not walk away
     believing the deal is done. Nothing was accepted and nothing will be charged. */
  if (changeRequested) {
    return (
      <div className="min-h-screen bg-paper-2/30 flex items-start justify-center py-10 px-4">
        <div className="max-w-2xl w-full bg-paper rounded-xl shadow-sm border border-hairline p-8 md:p-12 text-center">
          <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-amber/15 grid place-items-center">
            <Icon name="mail" size={32} className="text-amber-ink" />
          </div>
          <h1 className="font-serif text-3xl text-ink mb-2">Sent to {tenantName}</h1>
          <p className="text-sm text-ink-3">
            Your changes to quote <span className="font-mono text-ink">{quote.id}</span> have been sent.
            <b className="text-ink"> Nothing has been accepted and nothing will be charged</b> — {tenantName} will
            confirm the final figure with you first.
          </p>
          {tenantPhone && (
            <p className="mt-4 text-sm text-ink-2">
              Need it sooner? Call {tenantName} on <a className="font-medium text-ink underline" href={`tel:${tenantPhone}`}>{tenantPhone}</a>.
            </p>
          )}
        </div>
      </div>
    );
  }

  // ──────────── Thank-you screen (accepted OR paid) ────────────
  if (accepted || paid) {
    return (
      <div className="min-h-screen bg-paper-2/30 flex items-start justify-center py-10 px-4">
        <div className="max-w-2xl w-full bg-paper rounded-xl shadow-sm border border-hairline p-8 md:p-12 text-center">
          <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-emerald/15 grid place-items-center">
            <Icon name="check_circle" size={32} className="text-emerald" />
          </div>
          <h1 className="font-serif text-3xl text-ink mb-2">{paid ? "Payment received" : "Quote accepted"}</h1>
          <p className="text-sm text-ink-3">
            {paid ? (
              <>Thank you! Your payment to <b className="text-ink">{tenantName}</b> is being confirmed.
              Your GST invoice will be issued and emailed to you shortly.</>
            ) : (
              <><b className="text-ink">{tenantName}</b> has been notified and will reach out with
              payment instructions. Your GST invoice is issued once payment is received.</>
            )}
          </p>
          <div className="bg-paper-2 rounded-lg p-4 mt-6 text-sm text-left">
            <div className="flex justify-between mb-1.5">
              <span className="text-ink-3">Quote ID</span>
              <span className="font-mono font-semibold">{quote.id}</span>
            </div>
            <div className="flex justify-between mb-1.5">
              <span className="text-ink-3">Total</span>
              <span className="font-serif text-lg">{fmtC(dTotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-3">Billing</span>
              <span>{scheduleLabel(firstCommitment, effectiveCycle)}</span>
            </div>
          </div>
          <Button
            variant="ghost"
            icon="printer"
            className="mt-6"
            onClick={() => window.print()}
          >
            Print this confirmation
          </Button>
        </div>
      </div>
    );
  }

  // ──────────── No-longer-available screen (expired / rejected) ────────────
  // These states can't be accepted (the API rejects them), so don't show the
  // customer a working "Accept" button that only errors when clicked.
  if (quote.status === "expired" || quote.status === "rejected") {
    return (
      <div className="min-h-screen bg-paper-2/30 flex items-start justify-center py-10 px-4">
        <div className="max-w-2xl w-full bg-paper rounded-xl shadow-sm border border-hairline p-8 md:p-12 text-center">
          <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-rose/15 grid place-items-center">
            <Icon name="alert" size={32} className="text-rose" />
          </div>
          <h1 className="font-serif text-3xl text-ink mb-2">
            {quote.status === "expired" ? "This quote has expired" : "This quote is no longer available"}
          </h1>
          <p className="text-sm text-ink-3">
            Quote <span className="font-mono">{quote.id}</span> can no longer be accepted online.
            Please contact <b className="text-ink">{tenantName}</b> for an updated quote.
          </p>
          {tenantEmail && (
            <Button asChild variant="primary" className="mt-6">
              <a href={`mailto:${tenantEmail}?subject=${encodeURIComponent(`New quote request (ref ${quote.id})`)}`}>
                Request a fresh quote
              </a>
            </Button>
          )}
        </div>
      </div>
    );
  }

  // ──────────── Quote review screen ────────────
  return (
    <div className="min-h-screen bg-paper-2/30 py-6 px-4">
      <div className="max-w-3xl mx-auto bg-paper rounded-xl shadow-sm border border-hairline overflow-hidden">
        {/* Top action bar — sticky, hidden in print */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-hairline bg-paper-2 print:hidden sticky top-0 z-10">
          <div className="flex items-center gap-2">
            <Icon name="file" size={16} className="text-ink-3" />
            <span className="text-sm font-semibold text-ink">Your quote · review and accept</span>
          </div>
          <Button size="sm" icon="file" variant="ghost" onClick={() => window.print()}>
            Print / Save PDF
          </Button>
        </div>

        {/* ── PDF-style document ── */}
        <div className="p-8 md:p-12 print:p-0 font-sans text-ink">
          {/* Brand header */}
          <div className="flex items-start justify-between border-b-2 border-ink pb-5 mb-6 flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-md bg-ink text-paper grid place-items-center font-serif text-2xl">
                {tenantName.charAt(0)}
              </div>
              <div>
                <div className="font-serif text-2xl leading-tight">{tenantName}</div>
                {tenantGstin && (
                  <div className="text-xs text-ink-3 mt-0.5">
                    GSTIN: <span className="font-mono">{tenantGstin}</span>
                  </div>
                )}
                {tenantAddress && (
                  <div className="text-xs text-ink-3 mt-0.5 max-w-[280px]">{tenantAddress}</div>
                )}
                {(tenantEmail || tenantPhone) && (
                  <div className="text-xs text-ink-3 font-mono mt-0.5">
                    {tenantEmail}
                    {tenantEmail && tenantPhone && " · "}
                    {tenantPhone}
                  </div>
                )}
              </div>
            </div>
            <div className="text-right">
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold">Quotation</p>
              <p className="font-serif text-3xl mt-1">{quote.id}</p>
              {quote.expires_date && (
                <p className="text-xs text-ink-3 mt-1">
                  Valid until: <b>{formatDate(quote.expires_date)}</b>
                </p>
              )}
            </div>
          </div>

          {/* Bill to + billing */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6">
            <div>
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-1.5">Prepared for</p>
              <p className="font-serif text-lg leading-tight">{quote.customer_name}</p>
            </div>
            <div className="sm:text-right">
              {lineItems.length > 0 && firstCommitment && (
                <>
                  <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-1.5">Billing schedule</p>
                  <p className="text-sm">{scheduleLabel(firstCommitment, effectiveCycle)}</p>
                  {isFlex && (
                <p className="text-2xs text-ink-3">Pay-as-you-go — har mahine apni invoice, jab tak chalu rakhein</p>
              )}
              {billingN > 1 && !isFlex && (
                    <p className="text-2xs text-ink-3">{billingN} invoices per year</p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Line items.

              Har row ke aankde EK jagah compute hote hain (rowData) aur do render
              unhe istemal karte hain — phone ki card-list aur desktop ki table
              (§20, audit B5: YE page WhatsApp-link se phone par khulta hai, aur
              iski table wahan bina card-fallback ke thi). Do render, ek ganit —
              warna dono ek din alag jawab dete. */}
          {(() => {
            const rowData = dispLines.map(({ line, unit, amount }) => {
              /* Once anything is adjusted, EVERY figure on this row comes from the
                 server's answer. Nothing here multiplies a rate by a seat count —
                 a number the browser computed is a number the customer chose. */
              const live      = liveConfig?.lines.find((l) => l.lineId === line.id);
              const qty       = live?.qty ?? line.qty;
              const rowUnit   = live ? live.rate : unit;
              const rowAmount = live ? live.amount : amount;
              const included  = live ? live.included : (!line.optional || (line.included_by_default ?? false));
              const bounds    = line.seats_adjustable
                ? {
                    min: Math.max(1, line.min_seats ?? Math.max(1, Math.floor(line.qty / 2))),
                    max: line.max_seats ?? Math.max(line.qty * 3, line.qty + 50),
                  }
                : null;
              return { line, live, qty, rowUnit, rowAmount, included, bounds };
            });

            const includeBox = (r: (typeof rowData)[number]) =>
              adjustable && r.line.optional ? (
                <input
                  type="checkbox"
                  checked={r.included}
                  aria-label={`Include ${r.line.name}`}
                  onChange={(e) => setChoices((c) => ({ ...c, [r.line.id]: { ...c[r.line.id], included: e.target.checked } }))}
                  className="mt-1 h-4 w-4 shrink-0 accent-amber"
                />
              ) : null;

            const seatsBox = (r: (typeof rowData)[number]) =>
              adjustable && r.bounds && r.included ? (
                <input
                  type="number"
                  min={r.bounds.min}
                  max={r.bounds.max}
                  value={r.qty}
                  aria-label={`Seats for ${r.line.name}`}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) setChoices((c) => ({ ...c, [r.line.id]: { ...c[r.line.id], seats: n } }));
                  }}
                  className="w-16 rounded border border-hairline bg-paper px-1.5 py-1 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-amber"
                />
              ) : null;

            return (
              <>
              {/* ── Phone: card per line ── */}
              <ul className="sm:hidden mb-6 divide-y divide-hairline border-y-2 border-ink">
                {rowData.map((r) => (
                  <li key={r.line.id} className={cn("py-3", !r.included && "opacity-45")}>
                    <div className="flex items-start gap-2">
                      {includeBox(r)}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          {r.line.name}
                          {r.line.optional && <span className="ml-1.5 text-3xs uppercase tracking-wider text-ink-3">optional</span>}
                        </p>
                        {r.line.commitment && (
                          <p className="text-2xs text-ink-3 mt-0.5">{scheduleLabel(r.line.commitment, effectiveCycle)}</p>
                        )}
                        {r.live?.rePriced && r.live.bandLabel && (
                          <p className="mt-0.5 text-2xs font-medium text-emerald">
                            {r.qty} seats reaches the {r.live.bandLabel} price
                          </p>
                        )}
                        <div className="mt-2 flex items-center justify-between gap-3">
                          <span className="flex items-center gap-1.5 text-sm tabular-nums text-ink-2">
                            {seatsBox(r) ?? <span>{r.qty}</span>}
                            <span className="text-2xs text-ink-3">× {r.included ? fmtInv(r.rowUnit) : "—"}</span>
                          </span>
                          <span className="text-sm tabular-nums font-medium">{r.included ? fmtInv(r.rowAmount) : "—"}</span>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              {/* ── Desktop: table ── */}
              <table className="w-full mb-6 hidden sm:table">
            <thead className="border-y-2 border-ink">
              <tr>
                <th className="text-left py-2 text-2xs uppercase tracking-wider font-semibold">Item</th>
                <th className="text-right py-2 text-2xs uppercase tracking-wider font-semibold w-16">Qty</th>
                <th className="text-right py-2 text-2xs uppercase tracking-wider font-semibold w-28">Rate</th>
                <th className="text-right py-2 text-2xs uppercase tracking-wider font-semibold w-32">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rowData.map((r) => {
                const { line, live, qty, rowUnit, rowAmount, included, bounds } = r;

                return (
                  <tr key={line.id} className={cn("border-b border-hairline", !included && "opacity-45")}>
                    <td className="py-3 text-sm">
                      <div className="flex items-start gap-2">
                        {adjustable && line.optional && (
                          <input
                            type="checkbox"
                            checked={included}
                            aria-label={`Include ${line.name}`}
                            onChange={(e) => setChoices((c) => ({ ...c, [line.id]: { ...c[line.id], included: e.target.checked } }))}
                            className="mt-1 h-4 w-4 shrink-0 accent-amber"
                          />
                        )}
                        <div className="min-w-0">
                          <p className="font-medium">
                            {line.name}
                            {line.optional && <span className="ml-1.5 text-3xs uppercase tracking-wider text-ink-3">optional</span>}
                          </p>
                          {line.commitment && (
                            <p className="text-2xs text-ink-3 mt-0.5">
                              {scheduleLabel(line.commitment, effectiveCycle)}
                            </p>
                          )}
                          {live?.rePriced && live.bandLabel && (
                            <p className="mt-0.5 text-2xs font-medium text-emerald">
                              {qty} seats reaches the {live.bandLabel} price
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 text-right text-sm tabular-nums">
                      {adjustable && bounds && included ? (
                        <input
                          type="number"
                          min={bounds.min}
                          max={bounds.max}
                          value={qty}
                          aria-label={`Seats for ${line.name}`}
                          onChange={(e) => {
                            const n = parseInt(e.target.value, 10);
                            if (Number.isFinite(n)) setChoices((c) => ({ ...c, [line.id]: { ...c[line.id], seats: n } }));
                          }}
                          className="w-16 rounded border border-hairline bg-paper px-1.5 py-1 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-amber"
                        />
                      ) : qty}
                    </td>
                    <td className="py-3 text-right text-sm tabular-nums">{included ? fmtInv(rowUnit) : "—"}</td>
                    <td className="py-3 text-right text-sm tabular-nums font-medium">{included ? fmtInv(rowAmount) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
              </table>
              </>
            );
          })()}

          {adjustable && (
            <p className="-mt-4 mb-6 text-2xs leading-snug text-ink-3">
              You can change the seat count and pick the optional items above — the price updates
              from {tenantName}&apos;s own price list, not from this page.
              {pricing && <span className="ml-1 text-amber-ink">Updating…</span>}
            </p>
          )}

          {liveConfig?.changed && !liveConfig.selfAcceptable && (
            <div className="mb-6 rounded-lg border border-amber/60 bg-amber-soft p-3.5">
              <p className="text-sm font-semibold text-amber-ink">
                {tenantName} needs to confirm this combination.
              </p>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-2">
                Your changes fall outside the pricing they can approve automatically. Confirming below
                sends it to them — they will come back to you with the final figure rather than
                charging you this amount.
              </p>
            </div>
          )}

          {/* Totals */}
          <div className="flex justify-end mb-6">
            <div className="w-full max-w-xs space-y-2 text-sm">
              {/* When the customer has changed something, every figure here is the
                  server's — including the tax, derived as (total − subtotal) rather
                  than recomputed locally, so the rounding matches the one number that
                  will actually be charged. */}
              <Row label="Subtotal" value={fmtInv(liveConfig ? liveConfig.subtotal : dSubtotal)} />
              {quote.discount_pct > 0 && !liveConfig && (
                <Row label={`Discount (${quote.discount_pct}%)`} value={`−${fmtInv(dDiscount)}`} accent />
              )}
              <Row label="Taxable" value={fmtInv(liveConfig ? liveConfig.subtotal : dTaxable)} />
              <Row label={`GST (${quote.tax_rate}%)`} value={fmtInv(liveConfig ? liveConfig.total - liveConfig.subtotal : dTax)} />
              <div className="border-t-2 border-ink pt-2 mt-2">
                <div className="flex justify-between items-baseline">
                  <span className="text-2xs uppercase tracking-widest font-semibold">
                    {/* Annual upfront (single yearly invoice) → emphasize "payable now"
                        so customer knows full amount needs to clear in one go. */}
                    {isFlex ? "Payable each month" : perInvoice ? `Per invoice (${billingN}/yr)` : (billingN === 1 ? "Total payable now" : "Total")}
                  </span>
                  <span className="font-serif text-2xl tabular-nums">
                    {/* dueToday when we have it — the schedule engine carries its
                        remainder into the LAST instalment, so a term that does not
                        divide gives a first instalment a rupee below the average.
                        This is the figure the pay button charges. */}
                    {isFlex
                      ? `${fmtC(payableTotal)}/month`
                      : perInvoice
                      ? `${fmtC(dueToday ? dueToday.firstGross : dRound(payableTotal / billingN))}${billingUnit}`
                      : fmtC(payableTotal)}
                  </span>
                </div>
                {isFlex && (
                  <div className="mt-1.5 text-2xs text-ink-3">
                    Pay-as-you-go — koi saal ka bandhan nahi; seats ya plan kisi bhi mahine badal/band kar sakte hain.
                  </div>
                )}
                {perInvoice && !isFlex && (
                  <div className="flex justify-between items-baseline mt-1.5 text-ink-3">
                    <span className="text-2xs">Annual contract value</span>
                    <span className="text-sm tabular-nums">{fmtC(payableTotal)}/yr</span>
                  </div>
                )}
                {!perInvoice && billingN === 1 && (
                  <div className="mt-1.5 text-2xs text-emerald font-medium">
                    ✓ One-time payment · covers full 12 months of service
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Notes */}
          {quote.notes && (
            <div className="mb-6 pt-4 border-t border-hairline">
              <p className="text-3xs uppercase tracking-widest text-ink-3 font-semibold mb-1.5">Notes</p>
              <p className="text-sm whitespace-pre-wrap leading-relaxed text-ink-2">{quote.notes}</p>
            </div>
          )}

          {/* Action zone — hidden in print */}
          <div className="pt-6 mt-6 border-t border-hairline print:hidden space-y-3">
            {/* Pay-online is switched OFF the moment the customer changes the shape.
                The payment order is built server-side from the SAVED quote, so paying
                now would charge the original total for a configuration nobody has
                agreed to — the customer would pay the wrong amount and both sides
                would think it was settled. Accept first, then pay. */}
            {payOnline && !liveConfig?.changed && (
              <Button
                variant="primary"
                size="lg"
                icon="rupee"
                loading={paying}
                onClick={handlePayOnline}
                className="w-full justify-center"
              >
                {/* The whole term used to be charged here regardless of cycle. */}
                {dueToday
                  ? `Pay ${dueToday.cycle === "monthly" ? "this month" : "this instalment"} · ${fmtC(dueToday.firstGross)}`
                  : isFlex
                  ? `Pay this month · ${fmtC(dTotal)}`
                  : `Pay online now · ${fmtC(dTotal)}`}
              </Button>
            )}
            {payOnline && !liveConfig?.changed && (
              <BusyPanel
                active={preparingPay}
                title="Preparing your secure payment"
                steps={["Checking the quote and its total", "Creating your payment order", "Opening the Razorpay payment window"]}
              />
            )}
            {/* Said next to the button, because "why is this less than the total?"
                is the question a customer asks with their card already out. */}
            {payOnline && !liveConfig?.changed && isFlex && (
              <p className="text-[12px] leading-snug text-ink-3">
                Flex plan: each month has its own invoice and is paid from it — today
                you pay only this month&apos;s {fmtC(dTotal)}.
              </p>
            )}
            {payOnline && !liveConfig?.changed && dueToday && (
              <p className="text-[12px] leading-snug text-ink-3">
                This is instalment 1 of {dueToday.count}. The rest are invoiced one
                period at a time on their own dates — you pay each from the invoice you
                receive, never the whole {fmtC(dueToday.termGross)} at once.
              </p>
            )}
            {payOnline && liveConfig?.changed && (
              <p className="rounded-md border border-hairline bg-paper-2/60 px-3 py-2 text-[12px] leading-snug text-ink-2">
                Paying online is available once {tenantName} confirms your changes — the payment
                link still carries the original figure.
              </p>
            )}
            {/* ─── UPI straight to the reseller's bank ──────────────────────
                For an Indian SME this is the path that actually gets used, and it
                needs no gateway — the money lands in the reseller's account directly.

                Which is exactly why the button below says "I've sent the payment" and
                NOT "mark as paid". There is no webhook on a direct UPI transfer, so
                nothing here can confirm the money arrived. Marking a quote paid on the
                customer's word would put an unverified payment into the books; telling
                the reseller to go and check is the honest version.

                Hidden once the customer reconfigures, for the same reason pay-online
                is: the QR carries the ORIGINAL amount. */}
            {upiQr && !liveConfig?.changed && (
              <div className="rounded-lg border border-hairline bg-paper-2/40 p-4">
                <p className="text-sm font-semibold text-ink">Pay by UPI</p>
                <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
                  Scan with GPay, PhonePe, Paytm or any UPI app — the amount is already filled in.
                </p>
                <div className="mt-3 flex items-center gap-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={upiQr.dataUrl}
                    alt={`UPI QR code to pay ${tenantName} ${fmtC(upiQr.amount)}`}
                    className="h-32 w-32 shrink-0 rounded border border-hairline bg-white"
                  />
                  <div className="min-w-0 text-[12px] leading-snug">
                    <p className="text-ink-3">UPI ID</p>
                    <p className="font-mono font-medium text-ink break-all">{upiQr.vpa}</p>
                    <p className="mt-2 text-ink-3">
                      {dueToday ? `Amount · instalment 1 of ${dueToday.count}` : "Amount"}
                    </p>
                    <p className="font-medium text-ink tabular-nums">{fmtC(upiQr.amount)}</p>
                  </div>
                </div>
                <Button
                  variant="default"
                  size="sm"
                  className="mt-3 w-full justify-center"
                  loading={notifying}
                  onClick={handleUpiPaid}
                >
                  I&apos;ve sent the payment
                </Button>
                <p className="mt-1.5 text-2xs leading-snug text-ink-3">
                  This tells {tenantName} to check their account. It does not confirm the payment —
                  they will verify it and send your GST invoice.
                </p>
              </div>
            )}

            <Button
              variant={payOnline && !liveConfig?.changed ? "default" : "primary"}
              size="lg"
              icon="check_circle"
              loading={accepting}
              disabled={paying}
              onClick={() => setConfirmOpen(true)}
              className="w-full justify-center"
            >
              {payOnline && !liveConfig?.changed
                ? "Accept & pay later"
                : liveConfig?.changed && !liveConfig.selfAcceptable
                  ? `Send changes to ${tenantName}`
                  : `Accept this quote · ${fmtC(payableTotal)}`}
            </Button>
            <Button
              variant="default"
              size="lg"
              icon="file"
              disabled={paying || accepting}
              onClick={() => setPoOpen(true)}
              className="w-full justify-center border border-hairline bg-paper hover:bg-paper-2 transition-colors"
            >
              Submit Purchase Order (PO) / Request PI
            </Button>
            <Button
              variant="ghost"
              icon="mail"
              onClick={handleRequestChanges}
              className="w-full justify-center"
            >
              Request changes / revision
            </Button>
            <p className="text-2xs text-ink-3 text-center leading-relaxed pt-2">
              {payOnline
                ? <>Pay securely via Razorpay (UPI / card / net-banking) — your GST invoice is issued automatically once payment is confirmed. Or accept with PO and {tenantName} will share payment instructions.</>
                : <>By accepting, you agree to the pricing and billing terms shown above. {tenantName} will share payment instructions and issue your GST invoice once payment is received. No payment is taken on this page.</>}
            </p>
          </div>
        </div>
      </div>

      {/* Accept with Purchase Order (PO) Dialog — R-023: on ui/dialog (Radix) so focus stays
          inside, Esc closes and focus returns to the button; not closable mid-submit. */}
      <Dialog open={poOpen} onOpenChange={(o) => { if (!o && !accepting) setPoOpen(false); }}>
        <DialogContent hideClose resizable={false} aria-describedby="po-dialog-desc" className="gap-0 md:!w-[min(28rem,calc(100vw-2rem))]">
            <div className="flex items-center gap-3 mb-3">
              <div className="h-10 w-10 rounded-full bg-indigo/10 text-indigo grid place-items-center shrink-0">
                <Icon name="file" size={20} />
              </div>
              <div>
                <DialogTitle className="font-serif text-xl text-ink leading-tight">
                  Submit Purchase Order (PO)
                </DialogTitle>
                <p id="po-dialog-desc" className="text-xs text-ink-3">Accept quote with PO details or request Proforma Invoice</p>
              </div>
            </div>
            <div className="space-y-3 mt-4">
              <div>
                <label htmlFor="poNum" className="block text-xs font-semibold text-ink-2 mb-1">
                  Purchase Order Number (Optional)
                </label>
                <input
                  id="poNum"
                  type="text"
                  placeholder="e.g. PO-2026-8941"
                  value={poNumber}
                  onChange={(e) => setPoNumber(e.target.value)}
                  className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm font-mono text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-ink"
                />
              </div>
              <div>
                <label htmlFor="poNotes" className="block text-xs font-semibold text-ink-2 mb-1">
                  Notes / Billing Instructions
                </label>
                <textarea
                  id="poNotes"
                  rows={3}
                  placeholder="e.g. Please issue Proforma Invoice to Accounts Dept."
                  value={poNotes}
                  onChange={(e) => setPoNotes(e.target.value)}
                  className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-ink"
                />
              </div>
            </div>
            <BusyPanel
              active={accepting}
              title="Submitting your purchase order"
              steps={["Recording your PO and your acceptance", `Letting ${tenantName} know`]}
            />
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-6">
              <Button
                variant="ghost"
                onClick={() => setPoOpen(false)}
                disabled={accepting}
                className="sm:w-auto justify-center"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                icon="check_circle"
                loading={accepting}
                onClick={handlePoAccept}
                className="sm:w-auto justify-center"
              >
                Submit &amp; Accept
              </Button>
            </div>
        </DialogContent>
      </Dialog>

      {/* Accept confirmation — styled dialog, not a browser confirm() */}
      {/* R-023: ui/dialog — focus trap, Esc, focus return; not closable mid-submit. */}
      <Dialog open={confirmOpen} onOpenChange={(o) => { if (!o && !accepting) setConfirmOpen(false); }}>
        <DialogContent hideClose resizable={false} aria-describedby={undefined} className="gap-0 md:!w-[min(28rem,calc(100vw-2rem))]">
            <div className="flex items-center gap-3 mb-3">
              <div className="h-10 w-10 rounded-full bg-emerald/10 text-emerald grid place-items-center shrink-0">
                <Icon name="check_circle" size={20} />
              </div>
              <DialogTitle className="font-serif text-xl text-ink leading-tight">
                Accept this quote?
              </DialogTitle>
            </div>
            <p className="text-sm text-ink-2 leading-relaxed">
              You&apos;re accepting quote <span className="font-mono text-ink">{quote.id}</span> for{" "}
              <span className="font-semibold text-ink">{fmtC(payableTotal)}</span>.
            </p>
            <p className="text-[13px] text-ink-3 leading-relaxed mt-2">
              {liveConfig?.changed && !liveConfig.selfAcceptable
                ? `${tenantName} will confirm the new figure with you before anything is charged.`
                : `${tenantName} will be notified and will share payment instructions. No payment is taken now.`}
            </p>

            {/* Click-to-sign. Named honestly: this records WHO confirmed, from where and
                when. It is not a digital signature under the IT Act — that needs a DSC
                from a licensed CA — and saying otherwise would put a legal claim on a
                text box. The name is required because an anonymous confirmation is the
                one thing this block exists to prevent. */}
            <div className="mt-4 space-y-3 border-t border-hairline pt-4">
              <div>
                <label htmlFor="signer-name" className="block text-xs font-semibold text-ink-2 mb-1">
                  Your full name <span className="text-rose">*</span>
                </label>
                <input
                  id="signer-name"
                  type="text"
                  value={signerName}
                  onChange={(e) => setSignerName(e.target.value)}
                  placeholder="Name of the person confirming"
                  className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-ink"
                />
                {nameNudge && !signerName.trim() && (
                  <p role="alert" className="mt-1 text-xs text-rose-ink">
                    Type your full name to confirm — it records who accepted this quote.
                  </p>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="signer-title" className="block text-xs font-semibold text-ink-2 mb-1">
                    Designation
                  </label>
                  <input
                    id="signer-title"
                    type="text"
                    value={signerTitle}
                    onChange={(e) => setSignerTitle(e.target.value)}
                    placeholder="e.g. Director"
                    className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-ink"
                  />
                </div>
                <div>
                  <label htmlFor="signer-email" className="block text-xs font-semibold text-ink-2 mb-1">
                    Email
                  </label>
                  <input
                    id="signer-email"
                    type="email"
                    value={signerEmail}
                    onChange={(e) => setSignerEmail(e.target.value)}
                    placeholder="you@company.in"
                    className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-ink"
                  />
                </div>
              </div>
              <p className="text-2xs leading-snug text-ink-3">
                Confirming records your name, the date and time, and the network address this was
                sent from, together with the figures shown above. This is a record of your
                confirmation — it is not a digital signature certificate.
              </p>
            </div>

            <BusyPanel
              active={accepting}
              title="Accepting your quote"
              steps={["Recording who confirmed, and the figures shown", "Accepting the quote", `Letting ${tenantName} know`]}
            />
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-6">
              <Button
                variant="ghost"
                onClick={() => setConfirmOpen(false)}
                disabled={accepting}
                className="sm:w-auto justify-center"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                icon="check_circle"
                loading={accepting}
                onClick={() => {
                  if (!signerName.trim()) {
                    setNameNudge(true);
                    document.getElementById("signer-name")?.focus();
                    return;
                  }
                  void handleAccept();
                }}
                className="sm:w-auto justify-center"
              >
                {liveConfig?.changed && !liveConfig.selfAcceptable ? "Send to reseller" : "Confirm & accept"}
              </Button>
            </div>
        </DialogContent>
      </Dialog>
    </div>
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
