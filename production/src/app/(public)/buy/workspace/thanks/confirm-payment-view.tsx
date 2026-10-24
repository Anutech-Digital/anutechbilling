"use client";

/**
 * R-1625 (24 Oct 2026) — the thanks page confirms a Workspace payment on OUR server.
 *
 * Shown when the thanks page has no paid order to show yet. If the buy page kept a Razorpay
 * payment for this order (payment-handoff.ts), the page asks POST /api/public/checkout/verify
 * — the R-1596 path the cart checkout uses, which settles through the webhook's own
 * idempotent settleCapturedPayment — and shows a BusyPanel while it does. Every few seconds
 * while Razorpay is still completing it, then on "Check again".
 *
 *   paid               → reload once: the server now finds the order and shows it.
 *   failed             → Razorpay's own word, never "nothing was charged".
 *   refused / still    → honest words, "don't pay again", and the support next step.
 *   no stored payment  → the usual not-found card (a guessed number looks the same as before).
 */
import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { BusyPanel } from "@/components/ui/busy-panel";
import { settlePageScroll } from "@/lib/ui/scroll-lock";
import { confirmPayment, type VerifyBody } from "@/lib/checkout/confirm-payment";
import { WHATSAPP_READY } from "@/site/lib/config";
import {
  CONFIRM_EVERY_MS, CONFIRM_TRIES, confirmView, pageReload, readWorkspacePayment, saveWorkspacePayment,
  type WorkspacePayment,
} from "./payment-handoff";
import { mailtoLink, phoneDisplay, supportEmail, whatsappLink } from "./support-links";

export function ConfirmPaymentView({ quoteId, notFound }: { quoteId: string; notFound: React.ReactNode }) {
  /* undefined = storage not read yet (render nothing, so no "not found" flashes first). */
  const [payment, setPayment] = React.useState<WorkspacePayment | null | undefined>(undefined);
  const [answer, setAnswer] = React.useState<VerifyBody | null>(null);
  const [polling, setPolling] = React.useState(false);
  const [round, setRound] = React.useState(0);
  /* Paid, but the reload still found no order — never loop: say it plainly instead. */
  const [paidBefore, setPaidBefore] = React.useState(false);

  /* Razorpay may leave page scrolling locked (§24, 3 Oct 2026) — undo it on arrival. */
  React.useEffect(() => {
    settlePageScroll();
    const t = window.setTimeout(settlePageScroll, 1000);
    return () => window.clearTimeout(t);
  }, []);

  React.useEffect(() => {
    const p = readWorkspacePayment(quoteId);
    setPayment(p);
    if (p?.state === "paid") {
      setPaidBefore(true);
      setAnswer({ state: "paid", message: "", quoteId });
    } else if (p) {
      setRound(1);
    }
  }, [quoteId]);

  React.useEffect(() => {
    if (!payment || round === 0) return;
    let stop = false;
    let timer = 0;
    let tries = 0;
    setPolling(true);
    const ask = async () => {
      const got = await confirmPayment(payment);
      if (stop) return;
      tries += 1;
      if (got.state === "confirming" && tries < CONFIRM_TRIES) {
        timer = window.setTimeout(ask, CONFIRM_EVERY_MS);
        return;
      }
      // A "paid" for another quote is not this order's confirmation (confirmView shows "refused").
      const mine = !got.quoteId || got.quoteId === quoteId;
      saveWorkspacePayment(quoteId, { ...payment, state: mine ? got.state : "refused" });
      setAnswer(got);
      setPolling(false);
      if (got.state === "paid" && mine) pageReload.run();
    };
    void ask();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [payment, round, quoteId]);

  if (payment === undefined) return null;
  if (payment === null) return <>{notFound}</>;

  const view = confirmView(answer?.state ?? null, polling, answer?.quoteId, quoteId);
  const message = answer?.message ?? "";

  if (view === "checking" || (view === "paid" && !paidBefore)) {
    return (
      <Shell icon="clock" tone="neutral" title={view === "paid" ? "Payment received" : "Confirming your payment"}>
        <p className="text-sm text-ink-3 mb-2 leading-relaxed">
          {view === "paid"
            ? <>Opening your order <span className="font-mono">{quoteId}</span>…</>
            : <>Razorpay has passed your payment to us. We&apos;re checking it and recording order <span className="font-mono">{quoteId}</span>. Please keep this page open.</>}
        </p>
        <BusyPanel
          active
          title={view === "paid" ? "Opening your order" : "Confirming your payment"}
          steps={["Checking the payment with Razorpay", "Recording your order", "Issuing your GST invoice"]}
          slowAfterSec={12}
        />
      </Shell>
    );
  }

  if (view === "paid") {
    return (
      <Shell icon="check" tone="good" title="Payment received">
        <p className="text-sm text-ink-3 mb-6 leading-relaxed">
          Your payment for order <span className="font-mono">{quoteId}</span> is confirmed, but this page couldn&apos;t load the order details.
          The confirmation email has them — or press Reload.
        </p>
        <Actions quoteId={quoteId} subject={`Order ${quoteId} — paid, page did not load`}>
          <Button variant="default" onClick={() => pageReload.run()}>Reload</Button>
        </Actions>
      </Shell>
    );
  }

  if (view === "failed") {
    return (
      <Shell icon="info" tone="warn" title="Your payment didn't go through">
        <p className="text-sm text-ink-3 mb-6 leading-relaxed">{message}</p>
        <Actions quoteId={quoteId} subject={`Payment for order ${quoteId} did not go through`}>
          <Button asChild variant="default"><Link href="/buy/workspace">Try again</Link></Button>
        </Actions>
      </Shell>
    );
  }

  if (view === "refused") {
    return (
      <Shell icon="info" tone="warn" title="We couldn't confirm this payment">
        <p className="text-sm text-ink-3 mb-6 leading-relaxed">
          {message || "Please don't pay again — email support with your order number and we'll finish it for you."}
        </p>
        <Actions quoteId={quoteId} subject={`Please confirm my payment for order ${quoteId}`} />
      </Shell>
    );
  }

  // still-confirming: the server could not say yet (Razorpay still completing, or our side busy).
  return (
    <Shell icon="clock" tone="warn" title="Your payment is still being confirmed">
      <p className="text-sm text-ink-3 mb-2 leading-relaxed">
        {message || "We're still confirming your payment."}
      </p>
      <p className="text-sm text-ink-3 mb-6 leading-relaxed">
        Please don&apos;t pay again. Order <span className="font-mono">{quoteId}</span> is saved — press Check again in a minute, or write to us and we&apos;ll finish it for you.
      </p>
      <Actions quoteId={quoteId} subject={`Please confirm my payment for order ${quoteId}`}>
        <Button variant="default" onClick={() => setRound((r) => r + 1)}>Check again</Button>
      </Actions>
    </Shell>
  );
}

function Shell({ icon, tone, title, children }: {
  icon: "clock" | "check" | "info"; tone: "neutral" | "good" | "warn"; title: string; children: React.ReactNode;
}) {
  const ring = tone === "good" ? "bg-emerald text-paper" : tone === "warn" ? "bg-amber-soft text-amber-ink" : "bg-paper-2 text-ink-3";
  return (
    <div className="min-h-screen bg-paper grid place-items-center px-4 py-12">
      <Card className="max-w-md w-full p-8 text-center">
        <div className={`w-16 h-16 mx-auto mb-4 rounded-full grid place-items-center ${ring}`}>
          <Icon name={icon} size={28} />
        </div>
        <h1 className="font-serif text-2xl mb-2">{title}</h1>
        {children}
      </Card>
    </div>
  );
}

/** The support next step, always present: WhatsApp when the number is real, else email. */
function Actions({ quoteId, subject, children }: { quoteId: string; subject: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row flex-wrap gap-2 justify-center">
      {children}
      {WHATSAPP_READY ? (
        <a
          href={whatsappLink(`Hi, I paid for Google Workspace (order ${quoteId}) and the page couldn't confirm it.`)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 px-5 h-11 rounded-lg font-medium text-paper"
          style={{ background: "#25D366" }}
          aria-label={`WhatsApp us on ${phoneDisplay()}`}
        >
          <Icon name="whatsapp" size={18} />
          WhatsApp us
        </a>
      ) : (
        <a
          href={mailtoLink(subject)}
          className="inline-flex items-center justify-center gap-2 px-5 h-11 rounded-lg font-medium text-paper bg-ink"
          aria-label={`Email ${supportEmail()}`}
        >
          <Icon name="mail" size={18} />
          Email us
        </a>
      )}
    </div>
  );
}
