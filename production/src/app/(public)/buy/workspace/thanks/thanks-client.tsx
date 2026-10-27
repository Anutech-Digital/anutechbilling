"use client";

/**
 * Thank-you page client. Receives a server-fetched `order` (already
 * filtered to safe fields) and renders the confirmation experience.
 * Designed to be the visitor's anchor URL after payment — bookmarkable,
 * forwardable to their finance team.
 */

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { COMPANY, SLA, WHATSAPP_READY } from "@/site/lib/config";
import { BrandMark } from "../_parts/site-header";
import { SiteFooter } from "../_parts/info-sections";
import { buyContact, type BuyBrand } from "../_parts/brand";
import { MetaPixel, trackMeta, metaConsent, fbpCookie } from "@/site/lib/meta-pixel";
import { contentIdForPlan, purchaseEventId } from "@/lib/meta/pixel-ids";
import { mailtoLink, phoneDisplay, whatsappLink } from "./support-links";
import { ConfirmPaymentView } from "./confirm-payment-view";
import { forgetWorkspacePayment } from "./payment-handoff";
import { dropWorkspaceLinesFromStoredCart } from "@/site/components/cart/workspace-line";
import { settlePageScroll } from "@/lib/ui/scroll-lock";
import { rupee } from "@/lib/utils";
import type { OrderPaymentState } from "@/lib/checkout/order-payment-state";

export interface ThanksOrder {
  quoteId:        string;
  /** R-1979: the quote's plan label ("google-workspace-starter"), for Meta's content_ids. */
  planLabel?:     string | null;
  /** R-1977: a new domain bought with this order (registered in the buyer's name after payment). */
  newDomain?:     string | null;
  /** R-1971: the GST invoice number for this order, once issued. */
  invoiceNumber?: string | null;
  /** R-1985: a monthly order's new domain is on its own GST invoice (same payment). */
  domainInvoiceNumber?: string | null;
  /** The company (quotes.customer_name) — shown on the COMPANY line, never as the greeting. */
  customerName:   string;
  /** R-2009: the buyer's first name from checkout's "Your name" (the lead's contact_name); null → greet with no name. */
  buyerFirstName?: string | null;
  tierName:       string;
  seats:          number;
  amount:         number;
  /** R-1965: the quote's pre-GST amount, to split the paid total into amount + GST; null on old rows. */
  subtotal?:      number | null;
  paymentStatus:  string;
  /** R-1624: from lib/checkout/order-payment-state — never read payment_status here. */
  paymentState:   OrderPaymentState;
  /** Rupees received against the quote; null when it could not be read. */
  amountReceived: number | null;
  paymentDate:    string | null;
}

/* Contact: site config, through ./support-links (one place, also used by the confirming view). */
const SUPPORT_EMAIL = COMPANY.supportEmail;

/** Multi-color "Google Workspace" inline logo — same as buy page. */
function GWInline() {
  const G = { blue: "#4285F4", red: "#EA4335", yellow: "#FBBC04", green: "#34A853", grey: "#5F6368" };
  return (
    <span className="font-serif inline-block">
      <span style={{ color: G.blue   }}>G</span>
      <span style={{ color: G.red    }}>o</span>
      <span style={{ color: G.yellow }}>o</span>
      <span style={{ color: G.blue   }}>g</span>
      <span style={{ color: G.green  }}>l</span>
      <span style={{ color: G.red    }}>e</span>
      <span style={{ color: G.grey   }}> Workspace</span>
    </span>
  );
}

export function ThanksClient({
  order,
  isSimulation,
  orderRef,
  brand = null,
  metaPixelId = null,
  orderToken,
}: {
  /** R-1979: the order's secret token from the address — the server Purchase request proves the order with it. */
  orderToken?: string;
  /** R-1979: the website tenant's Meta Pixel id (no id → no script, no event). */
  metaPixelId?: string | null;
  order: ThanksOrder | null;
  isSimulation: boolean;
  /** R-1975: the website tenant (name, logo, GSTIN, address, phone) — the buy page reads the same row. */
  brand?: BuyBrand | null;
  /** R-1625: the order number from the address. With no order to show yet, the page looks for
   *  the Razorpay payment the buy page kept for THIS order and asks our server to confirm it. */
  orderRef?: string;
}) {
  if (!order && orderRef && !isSimulation) {
    return <ConfirmPaymentView quoteId={orderRef} notFound={<OrderNotFound />} />;
  }
  if (!order) return <OrderNotFound />;
  return <><MetaPixel pixelId={metaPixelId} /><OrderView order={order} isSimulation={isSimulation} brand={brand} orderToken={orderToken} /></>;
}

/** Fallback view — quote not found, not paid, or guessed wrong ID (and no payment of ours to confirm). */
function OrderNotFound() {
  return (
      <div className="min-h-screen bg-paper grid place-items-center px-4 py-12">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-paper-2 grid place-items-center">
            <Icon name="info" size={28} className="text-ink-3" />
          </div>
          <h1 className="font-serif text-2xl mb-2">Order not found</h1>
          <p className="text-sm text-ink-3 mb-6 leading-relaxed">
            We couldn&apos;t find an order matching that ID. If you just paid and
            landed here, check your email for the order confirmation — or
            {WHATSAPP_READY ? <> WhatsApp us on {phoneDisplay()}</> : <> write to {SUPPORT_EMAIL}</>}
            {" "}and we&apos;ll sort it.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 justify-center">
            {WHATSAPP_READY ? (
              <a
                href={whatsappLink("Hi, I just paid for Google Workspace but the confirmation page can't find my order.")}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 px-5 h-11 rounded-lg font-medium text-paper"
                style={{ background: "#25D366" }}
              >
                <Icon name="whatsapp" size={18} />
                WhatsApp us
              </a>
            ) : (
              <a
                href={mailtoLink("I paid but the confirmation page can't find my order")}
                className="inline-flex items-center justify-center gap-2 px-5 h-11 rounded-lg font-medium text-paper bg-ink"
              >
                <Icon name="mail" size={18} />
                Email us
              </a>
            )}
            <Button asChild variant="default">
              <Link href="/buy/workspace">Back to buy page</Link>
            </Button>
          </div>
        </Card>
      </div>
    );
}

function OrderView({ order, isSimulation, brand, orderToken }: { order: ThanksOrder; isSimulation: boolean; brand: BuyBrand | null; orderToken?: string }) {
  /* R-1975: the call link uses the tenant phone first, then the site number (the buy page rule). */
  const tel = buyContact(brand).tel;
  /* R-1625: arriving from Razorpay — undo any scroll lock it left (§24), and drop the kept
     payment once this order shows as paid. */
  React.useEffect(() => {
    settlePageScroll();
    const t = window.setTimeout(settlePageScroll, 1000);
    /* R-1966: the Workspace line in the website cart is now paid — take it out of the cart. */
    if (order.paymentState === "paid") { forgetWorkspacePayment(); dropWorkspaceLinesFromStoredCart(); }
    /* R-1979: Meta Purchase — same event id as the server's Conversions API event, so Meta counts
       it once; value before GST. A no-op without the pixel (no id or no "Accept all"). */
    if (order.paymentState === "paid") {
      trackMeta("Purchase", {
        value: order.subtotal ?? Math.round(order.amount / 1.18),
        currency: "INR",
        content_ids: contentIdForPlan(order.planLabel ?? null),
        content_type: "product",
        num_items: order.seats,
      }, purchaseEventId(order.quoteId));
      /* R-1979: and the server's Conversions API Purchase (same event id) — only with consent; a
         simulated order already sent it from the checkout route. Fire-and-forget. */
      if (!isSimulation && orderToken && metaConsent()) {
        void fetch("/api/public/checkout/workspace/meta-purchase", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quoteId: order.quoteId, t: orderToken, consent: true, fbp: fbpCookie(), pageUrl: window.location.origin + window.location.pathname }),
        }).catch(() => { /* Meta is never in the way of the page */ });
      }
    }
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per payment state (R-1979 events included)
  }, [order.paymentState]);

  /* R-1624: 'invoiced' (the GST invoice issued right after payment) is paid in full when the
     money says so — the state comes from orderPaymentState, one mapping for every reader. */
  const isFullyPaid    = order.paymentState === "paid";
  const statusLabel    = isFullyPaid ? "Paid in full" : order.paymentState === "part-paid" ? "Partially paid" : "Awaiting payment";
  /* R-2009: the buyer's own first name — never the company's first word ("Welcome aboard, Gupta."). */
  const firstName      = order.buyerFirstName?.trim() || null;
  const amountFmt      = `₹${order.amount.toLocaleString("en-IN")}`;
  /* R-1965: same wording as the buy page — the pre-GST amount + GST (18%) under the paid total. */
  const gstSplit       = order.subtotal != null && order.subtotal > 0 && order.subtotal < order.amount
    ? `${rupee(order.subtotal)} + ${rupee(order.amount - order.subtotal)} GST (18%)`
    : null;
  const waSupportMsg   = `Hi, I just placed order ${order.quoteId} (${order.tierName}, ${order.seats} users). Wanted to confirm next steps for domain verification.`;

  return (
    <div className="min-h-screen bg-paper">
      {/* ── Simulation banner ── */}
      {isSimulation && (
        <div
          className="border-b border-amber/30 text-center text-xs sm:text-sm"
          style={{
            background: "linear-gradient(90deg, #FEF3C7 0%, #FDE68A 50%, #FEF3C7 100%)",
            color:      "#7C2D12",
          }}
        >
          <div className="max-w-[1080px] mx-auto px-4 py-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5">
            <span className="font-semibold inline-flex items-center gap-1.5">
              <span aria-hidden>🧪</span> TEST MODE
            </span>
            <span>
              This is a simulated order · no real money changed hands · the data is real for app-side testing.
            </span>
          </div>
        </div>
      )}

      {/* ── Header — R-1975: the website tenant's name and logo (the buy page's BrandMark) ── */}
      <header className="border-b border-hairline bg-paper">
        <div className="max-w-[1080px] mx-auto px-6 py-4 flex items-center justify-between">
          <BrandMark brand={brand} />
        </div>
      </header>

      {/* ── Hero: celebration ── */}
      <section
        className="relative overflow-hidden"
        style={{
          background:
            "radial-gradient(circle at 50% 0%, rgba(16,185,129,0.10) 0%, transparent 60%)," +
            "linear-gradient(180deg, rgba(250,248,242,1) 0%, rgba(250,248,242,0.96) 100%)",
        }}
      >
        <div className="max-w-[1080px] mx-auto px-6 py-10 md:py-14 text-center">
          {/* Big checkmark */}
          <div className="w-20 h-20 mx-auto mb-5 rounded-full grid place-items-center"
               style={{ background: "linear-gradient(135deg, #10B981 0%, #059669 100%)", boxShadow: "0 12px 30px rgba(16,185,129,0.30)" }}>
            <Icon name="check" size={42} className="text-paper" />
          </div>

          <div className="text-2xs uppercase tracking-[0.18em] text-emerald font-semibold mb-3">
            {isFullyPaid ? "Payment received" : "Order placed"}
          </div>
          <h1 className="font-serif text-3xl md:text-5xl leading-[1.05] tracking-tight mb-3">
            {firstName ? `Welcome aboard, ${firstName}.` : "Welcome aboard."}
          </h1>
          <p className="text-base md:text-lg text-ink-3 leading-relaxed max-w-2xl mx-auto">
            Your <GWInline /> order is confirmed. Our team will call or WhatsApp you{" "}
            {SLA.firstReply} ({SLA.hours}) to verify your domain and start
            the setup.
          </p>
        </div>
      </section>

      {/* ── Order summary card ── */}
      <section className="bg-paper-2/30 border-y border-hairline py-10 md:py-12">
        <div className="max-w-[800px] mx-auto px-6">
          <Card className="p-6 md:p-8">
            <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
              <div>
                <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
                  Order summary
                </div>
                <div className="font-serif text-xl text-ink leading-tight">
                  Order <span className="font-mono">{order.quoteId}</span>
                </div>
              </div>
              <div className="text-right">
                <div className="font-serif text-3xl text-ink leading-none">
                  {amountFmt}
                </div>
                <div className="text-2xs text-ink-3 mt-1">{gstSplit ?? "incl 18% GST"}</div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-6 text-sm border-t border-hairline pt-5">
              <div className="flex justify-between sm:block">
                <span className="text-ink-3 sm:text-2xs sm:uppercase sm:tracking-wider sm:font-semibold sm:block sm:mb-0.5">Company</span>
                <span className="text-ink font-medium">{order.customerName}</span>
              </div>
              {order.invoiceNumber && (
                <div className="flex justify-between sm:block">
                  <span className="text-ink-3 sm:text-2xs sm:uppercase sm:tracking-wider sm:font-semibold sm:block sm:mb-0.5">GST invoice</span>
                  <span className="text-ink font-medium font-mono" data-testid="thanks-invoice">{order.invoiceNumber}</span>
                </div>
              )}
              {order.domainInvoiceNumber && (
                <div className="flex justify-between sm:block">
                  <span className="text-ink-3 sm:text-2xs sm:uppercase sm:tracking-wider sm:font-semibold sm:block sm:mb-0.5">Domain GST invoice</span>
                  <span className="text-ink font-medium font-mono" data-testid="thanks-domain-invoice">{order.domainInvoiceNumber}</span>
                </div>
              )}
              <div className="flex justify-between sm:block">
                <span className="text-ink-3 sm:text-2xs sm:uppercase sm:tracking-wider sm:font-semibold sm:block sm:mb-0.5">Plan</span>
                <span className="text-ink font-medium">{order.tierName}</span>
              </div>
              <div className="flex justify-between sm:block">
                <span className="text-ink-3 sm:text-2xs sm:uppercase sm:tracking-wider sm:font-semibold sm:block sm:mb-0.5">Seats</span>
                <span className="text-ink font-medium">{order.seats} {order.seats === 1 ? "user" : "users"}</span>
              </div>
              {order.newDomain && (
                <div className="flex justify-between gap-3 sm:block" data-testid="thanks-domain">
                  <span className="text-ink-3 sm:text-2xs sm:uppercase sm:tracking-wider sm:font-semibold sm:block sm:mb-0.5">Domain</span>
                  <span className="text-ink font-medium text-right sm:text-left"><span className="font-mono">{order.newDomain}</span> — registering, we will confirm by email</span>
                </div>
              )}
              <div className="flex justify-between sm:block">
                <span className="text-ink-3 sm:text-2xs sm:uppercase sm:tracking-wider sm:font-semibold sm:block sm:mb-0.5">Status</span>
                <span className={`font-medium inline-flex items-center gap-1.5 ${isFullyPaid ? "text-emerald" : "text-amber-ink"}`}>
                  <span className="w-1.5 h-1.5 rounded-full"
                        style={{ background: isFullyPaid ? "#10B981" : "#C2410C" }} />
                  {statusLabel}
                </span>
              </div>
            </div>

            <div className="mt-5 pt-5 border-t border-hairline text-xs text-ink-3 leading-relaxed">
              Your GST tax invoice (HSN 998313, 18% GST) comes with the payment confirmation email — if a detail is missing for it, we send it within one working day.
              Save this page or bookmark the link — you can return to it anytime.
            </div>
          </Card>
        </div>
      </section>

      {/* ── What happens next — vertical timeline ── */}
      <section className="max-w-[800px] mx-auto px-6 py-12 md:py-16">
        <div className="text-center mb-10">
          <div className="text-2xs uppercase tracking-[0.12em] text-ink-3 font-semibold mb-2">
            What happens next
          </div>
          <h2 className="font-serif text-2xl md:text-3xl tracking-tight">
            From this page to live email in {SLA.short.workspaceLive} after DNS is verified.
          </h2>
        </div>

        <ol className="relative space-y-7">
          {/* Vertical guide line */}
          <div className="absolute left-[14px] top-2 bottom-2 w-px bg-hairline" aria-hidden />

          {[
            {
              done: true,
              title: isFullyPaid ? "Order placed & payment confirmed" : "Order placed",
              body:  `Order ${order.quoteId} for ${order.seats} ${order.seats === 1 ? "user" : "users"} of ${order.tierName} is in our system.`,
            },
            {
              done: false,
              title: `Within ${SLA.short.firstReply} — our team calls or WhatsApps you`,
              body:  "We'll confirm your domain ownership (DNS TXT record method) and answer any pre-provisioning questions.",
              accent: true,
            },
            {
              done: false,
              title: `Within ${SLA.short.workspaceLive} of DNS verification — your team is live on Workspace`,
              body:  "Admin credentials emailed. We help configure MX records, recovery email, mobile sync — whatever your team needs.",
            },
            {
              done: false,
              title: "Day 7 — health-check call",
              body:  "Short call to confirm adoption, fix any teething issues, and walk you through Gemini AI / Vids / NotebookLM features.",
            },
          ].map((step, i) => (
            <li key={i} className="relative pl-12">
              <div
                className={`absolute left-0 top-0 w-7 h-7 rounded-full grid place-items-center border-2 ${
                  step.done
                    ? "bg-emerald border-emerald text-paper"
                    : step.accent
                      ? "bg-amber-soft border-amber text-amber-ink"
                      : "bg-paper border-hairline-strong text-ink-3"
                }`}
              >
                {step.done ? (
                  <Icon name="check" size={14} />
                ) : (
                  <Icon name="clock" size={13} />
                )}
              </div>
              <div className="font-serif text-base text-ink mb-1 leading-tight">
                {step.title}
              </div>
              <div className="text-sm text-ink-3 leading-relaxed">
                {step.body}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Support strip — dominant WhatsApp + secondary email/phone ── */}
      <section className="bg-paper-2/40 border-y border-hairline py-12 md:py-14">
        <div className="max-w-[680px] mx-auto px-6 text-center">
          <div className="text-2xs uppercase tracking-[0.12em] text-ink-3 font-semibold mb-3">
            Need help right now?
          </div>
          <h2 className="font-serif text-2xl md:text-3xl tracking-tight mb-2">
            A real person answers.
          </h2>
          <p className="text-sm text-ink-3 leading-relaxed mb-6">
            Fast answers, no ticket queue. Most domain-verification
            questions take a few minutes.
          </p>

          {WHATSAPP_READY && (
            <a
              href={whatsappLink(waSupportMsg)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 px-6 h-12 rounded-lg font-medium text-paper transition-transform hover:scale-[1.02] text-base mb-4"
              style={{ background: "#25D366", boxShadow: "0 8px 20px rgba(37,211,102,0.30)" }}
            >
              <Icon name="whatsapp" size={20} className="text-paper" />
              WhatsApp us — {phoneDisplay()}
            </a>
          )}

          <div className="text-xs text-ink-3 flex flex-wrap gap-x-4 gap-y-1 items-center justify-center">
            {tel && (
              <a href={tel.href} className="inline-flex items-center gap-1.5 hover:text-ink transition-colors">
                <Icon name="phone" size={12} />
                Call {tel.display}
              </a>
            )}
            <a href={mailtoLink(`Re: order ${order.quoteId}`)}
               className="inline-flex items-center gap-1.5 hover:text-ink transition-colors">
              <Icon name="mail" size={12} />
              {SUPPORT_EMAIL}
            </a>
            <span className="inline-flex items-center gap-1.5">
              <Icon name="clock" size={12} />
              {COMPANY.hours}
            </span>
          </div>
        </div>
      </section>

      <div className="py-6 text-center text-sm">
        <Link href="/buy/workspace" className="text-amber-ink underline underline-offset-2 hover:text-amber">
          Back to buy page
        </Link>
      </div>
      {/* R-1975: the buy page's own footer — tenant name, address, GSTIN, legal links. */}
      <SiteFooter brand={brand} />
    </div>
  );
}
