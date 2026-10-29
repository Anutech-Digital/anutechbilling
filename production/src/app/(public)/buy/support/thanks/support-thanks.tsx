"use client";

/**
 * The /buy/support thanks page (R-2083). Paid → says so, and the one next step is the support
 * desk. Not recorded yet → confirms the payment this browser just made (verify, up to five
 * tries four seconds apart) and reloads once the server says "paid". Every other answer says
 * what happened and how to reach us — never "paid" unless the server said it.
 */
import * as React from "react";
import { confirmPayment, type VerifyState } from "@/lib/checkout/confirm-payment";
import { rupee } from "@/lib/utils";
import { COMPANY } from "@/site/lib/config";
import { CONFIRM_EVERY_MS, CONFIRM_TRIES } from "../../workspace/thanks/payment-handoff";
import { readSupportPayment } from "../payment-handoff";

export interface SupportThanksOrder {
  quoteId: string;
  planName: string;
  amount: number;
  paid: boolean;
}

type View = "paid" | "checking" | "still" | "failed" | "refused" | "none";

export function SupportThanks({ order, simulated, deskUrl }: { order: SupportThanksOrder | null; simulated: boolean; deskUrl: string | null }) {
  const [view, setView] = React.useState<View>(order?.paid ? "paid" : order ? "checking" : "none");
  const [message, setMessage] = React.useState("");

  React.useEffect(() => {
    if (!order || order.paid) return;
    const p = readSupportPayment(order.quoteId);
    if (!p) { setView("still"); return; }
    let stop = false;
    (async () => {
      for (let i = 0; i < CONFIRM_TRIES && !stop; i++) {
        const r = await confirmPayment(p);
        const s: VerifyState = r.state;
        setMessage(r.message);
        if (s === "paid") { window.location.reload(); return; }
        if (s === "failed" || s === "refused") { setView(s); return; }
        await new Promise((res) => setTimeout(res, CONFIRM_EVERY_MS));
      }
      if (!stop) setView("still");
    })();
    return () => { stop = true; };
  }, [order]);

  const mail = `mailto:${COMPANY.supportEmail}?subject=${encodeURIComponent(`Support plan order ${order?.quoteId ?? ""}`)}`;
  const box = "bg-white border border-hairline rounded-2xl p-6";
  return (
    <main className="min-h-screen bg-paper">
      <div className="mx-auto max-w-xl px-4 py-12">
        {view === "paid" && order && (
          <section className={box} aria-live="polite">
            <p className="text-sm font-semibold text-emerald m-0">{simulated ? "Test payment recorded" : "Payment received"}</p>
            <h1 className="text-2xl font-bold text-ink mt-1 mb-3">{order.planName}</h1>
            <p className="text-[15px] text-ink-2 m-0">Order {order.quoteId} · {rupee(order.amount)} incl. GST. Your GST tax invoice is on its way by email.</p>
            <p className="text-[15px] text-ink-2 mt-3 mb-5">The plan is switched on at our support desk within a few minutes, for the email you paid with.</p>
            {deskUrl ? (
              <a href={deskUrl} className="flex items-center justify-center h-12 rounded-xl bg-amber text-white font-bold hover:bg-amber-ink">Go to support desk</a>
            ) : (
              <a href={mail} className="flex items-center justify-center h-12 rounded-xl bg-amber text-white font-bold hover:bg-amber-ink">Email support</a>
            )}
          </section>
        )}
        {view === "checking" && (
          <section className={box} aria-live="polite">
            <h1 className="text-xl font-bold text-ink mt-0 mb-2">Confirming your payment…</h1>
            <p className="text-[15px] text-ink-2 m-0">This takes a few seconds. Please don&apos;t pay again.</p>
          </section>
        )}
        {(view === "still" || view === "failed" || view === "refused" || view === "none") && (
          <section className={box} aria-live="polite">
            <h1 className="text-xl font-bold text-ink mt-0 mb-2">
              {view === "failed" ? "The payment didn't go through" : view === "none" ? "We couldn't find this order" : "We're still confirming your payment"}
            </h1>
            <p className="text-[15px] text-ink-2 mt-0 mb-5">
              {message || (view === "none"
                ? "Open the link from your order email, or contact us with your order number."
                : "If money left your account, your order is safe — we'll confirm it by email. Please don't pay again.")}
            </p>
            <a href={mail} className="flex items-center justify-center h-12 rounded-xl bg-amber text-white font-bold hover:bg-amber-ink">Email {COMPANY.supportEmail}</a>
          </section>
        )}
      </div>
    </main>
  );
}
