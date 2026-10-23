"use client";
/**
 * Order / trial confirmation. Checkout leaves one of two things in sessionStorage:
 * `anutech.order` (the quote number of a paid order) or `anutech.trial` (the email a
 * free hosting trial's confirmation link went to — 24 Sep 2026, when the trial moved
 * into the cart).
 *
 * Neither is invented when missing. This page used to default to the order number
 * "ORD-ADPL-2026-4107", which belongs to no order, so a reload or a new tab told the
 * customer a number that support could never find (AGENTS.md §2).
 *
 * Redesigned 30 Sep 2026 into the site's card language (a status header, a "what happens
 * next" timeline, an order card). The copy was checked against what really happens:
 * the payment webhook emails a "Payment received" confirmation carrying the order number;
 * the GST tax invoice follows when it is issued; hosting logins arrive in a separate
 * email; a migration starts when the customer replies. It no longer promises a WhatsApp
 * call from a "migration desk", NEFT/RTGS activation (checkout takes Razorpay only), or a
 * client area at /dashboard (that is the staff app).
 * R-233 (6 Oct 2026): /login is the ResellerOS sign-in too — the button now opens the
 * hosting & domains customer panel (CLIENT_AREA_URL, which falls back to /login if unset).
 * R-1596 (18 Oct 2026): after a Razorpay payment the checkout leaves `anutech.payment` (the
 * order, payment and signature Razorpay returned). "Payment received" is shown only once our
 * server has confirmed it; until then this page shows "confirming" with progress, or what
 * went wrong and what to do next.
 * R-1111 (23 Oct 2026): "Payment received" was the last fallback, so any visitor (bookmark,
 * fresh tab, stray link) was told they had paid. It now needs proof for this order in this
 * session (done-view.ts); otherwise the page asks "Looking for your order?".
 */
import Link from "@/site/components/ui/SiteLink";
import { useEffect, useState, type ReactNode } from "react";
import { CLIENT_AREA_URL, COMPANY, WHATSAPP_READY, WHATSAPP_URL } from "@/site/lib/config";
import { settlePageScroll } from "@/lib/ui/scroll-lock";
import { AfterYouPay } from "@/site/components/checkout/AfterYouPay";
import { BusyPanel } from "@/components/ui/busy-panel";
import { confirmPayment, readPayment, savePayment, type ReturnedPayment, type VerifyBody } from "@/lib/checkout/confirm-payment";
import { doneView, SIMULATED_KEY } from "./done-view";

/* R-1596: while Razorpay completes an authorised payment, ask again this often, this many times.
   Kept small: /api/public/checkout/* shares one per-IP limit (10 per 10 min, lib/security/rate-limit.ts). */
const CONFIRM_EVERY_MS = 5000;
const CONFIRM_TRIES = 4;

type Tone = "success" | "warn";
interface Step { title: string; body: ReactNode; done?: boolean }

const TONE = {
  success: { fg: "var(--success)", bg: "#EEF7F0", ring: "#CFE9DA" },
  warn: { fg: "#92400E", bg: "#FFFBEB", ring: "#FDE68A" },
} as const;

function StatusMark({ tone }: { tone: Tone }) {
  const t = TONE[tone];
  return (
    <div aria-hidden style={{ width: 64, height: 64, borderRadius: 999, background: t.bg, boxShadow: `0 0 0 8px ${t.bg}80, inset 0 0 0 1px ${t.ring}`, display: "grid", placeItems: "center", margin: "0 auto 22px" }}>
      {tone === "success" ? (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={t.fg} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      ) : (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={t.fg} strokeWidth="2.4" strokeLinecap="round"><path d="M12 7v6" /><circle cx="12" cy="17" r="0.6" fill={t.fg} /></svg>
      )}
    </div>
  );
}

function Timeline({ steps }: { steps: Step[] }) {
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <li key={s.title} style={{ display: "grid", gridTemplateColumns: "32px 1fr", gap: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <span style={{
                width: 32, height: 32, borderRadius: 999, display: "grid", placeItems: "center", flexShrink: 0,
                background: s.done ? "var(--success)" : "#fff",
                border: s.done ? "1px solid var(--success)" : "1px solid var(--border-strong)",
                color: s.done ? "#fff" : "var(--text-secondary)",
              }} className="mono">
                {s.done
                  ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-label="done"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                  : <span style={{ fontSize: 13, fontWeight: 600 }}>{i + 1}</span>}
              </span>
              {!last && <span aria-hidden style={{ width: 1, flex: 1, minHeight: 18, background: s.done ? "var(--success)" : "var(--border)", margin: "6px 0" }} />}
            </div>
            <div style={{ paddingBottom: last ? 0 : 22, paddingTop: 5 }}>
              <div style={{ fontWeight: 600, fontSize: 16, color: "var(--text)", marginBottom: 4 }}>{s.title}</div>
              <div style={{ fontSize: 15, lineHeight: 1.55, color: "var(--text-secondary)" }}>{s.body}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function CopyNumber({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }, () => { /* no clipboard: the number is on screen */ });
      }}
      style={{ fontSize: 13, fontWeight: 600, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border-strong)", background: "#fff", color: copied ? "var(--success)" : "var(--text)", cursor: "pointer" }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function HelpBlock({ subject }: { subject: string }) {
  return (
    <div style={{ borderTop: "1px solid var(--border-light)", paddingTop: 18, marginTop: 18 }}>
      <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 8 }}>Need help?</div>
      <a href={`mailto:${COMPANY.supportEmail}?subject=${encodeURIComponent(subject)}`} style={{ color: "var(--primary)", fontWeight: 600, fontSize: 15 }}>{COMPANY.supportEmail}</a>
      {WHATSAPP_READY && (
        <div style={{ marginTop: 6 }}>
          <a href={WHATSAPP_URL} target="_blank" rel="noreferrer" style={{ color: "var(--primary)", fontWeight: 600, fontSize: 15 }}>WhatsApp us</a>
        </div>
      )}
      <div className="meta" style={{ marginTop: 6 }}>{COMPANY.hours}</div>
    </div>
  );
}

const card = { background: "#fff", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "var(--shadow-panel)", padding: 28 } as const;

function DoneLayout({ tone, badge, title, lead, steps, aside, actions }: {
  tone: Tone; badge: string; title: ReactNode; lead: ReactNode; steps: Step[]; aside: ReactNode; actions: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <section className="section rise" style={{ background: "linear-gradient(180deg, var(--tint) 0%, #fff 340px)" }}>
      <div className="wrap" style={{ maxWidth: 1000 }}>
        <header style={{ textAlign: "center", maxWidth: 640, margin: "0 auto 40px" }}>
          <StatusMark tone={tone} />
          <div className="mono-label" style={{ display: "inline-block", padding: "7px 12px", borderRadius: 999, background: t.bg, color: t.fg, border: `1px solid ${t.ring}`, marginBottom: 18 }}>
            {badge}
          </div>
          <h1 className="h1-narrow" style={{ marginBottom: 14 }}>{title}</h1>
          <p className="body-lg" style={{ margin: 0 }}>{lead}</p>
        </header>

        <div data-grid style={{ display: "grid", gridTemplateColumns: "1.35fr .9fr", gap: 24, alignItems: "start" }}>
          <div style={card}>
            <div className="eyebrow" style={{ color: "var(--text-muted)", marginBottom: 20 }}>What happens next</div>
            <Timeline steps={steps} />
          </div>
          <aside style={card}>
            {aside}
            <div style={{ display: "grid", gap: 10, marginTop: 22 }}>{actions}</div>
          </aside>
        </div>
      </div>
    </section>
  );
}

export default function DonePage() {
  const [orderNo, setOrderNo] = useState<string | null>(null);
  const [trialEmail, setTrialEmail] = useState<string | null>(null);
  /* False only when the server said the confirmation link did NOT go out (30 Sep 2026). */
  const [trialSent, setTrialSent] = useState(true);
  /* R-1111: the simulated-order mark (laptop, no Razorpay keys), and "storage has been read" —
     until then nothing renders, so no screen flashes before the real one. */
  const [simulatedFor, setSimulatedFor] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  /* Nothing on this page locks scrolling, so whatever the checkout or Razorpay left behind is
     undone here (3 Oct 2026: the page arrived unscrollable after a payment). */
  useEffect(() => {
    settlePageScroll();
    const t = window.setTimeout(settlePageScroll, 1000);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    try {
      setOrderNo(window.sessionStorage.getItem("anutech.order") || null);
      setTrialEmail(window.sessionStorage.getItem("anutech.trial") || null);
      setTrialSent(window.sessionStorage.getItem("anutech.trial.sent") !== "0");
      setSimulatedFor(window.sessionStorage.getItem(SIMULATED_KEY));
    } catch { /* storage blocked: the neutral screen below still holds */ }
    setReady(true);
  }, []);

  /* R-1596: a Razorpay payment is confirmed by OUR server (POST /api/public/checkout/verify),
     not assumed. The checkout asked once; this page asks again unless the answer was "paid" —
     every few seconds while Razorpay is still completing it, then on "Check again". */
  const [payment, setPayment] = useState<ReturnedPayment | null>(null);
  const [verdict, setVerdict] = useState<VerifyBody | null>(null);
  const [polling, setPolling] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const p = readPayment();
    setPayment(p);
    if (p?.state === "paid") setVerdict({ state: "paid", message: "" });
    else if (p) setRound(1);
  }, []);
  useEffect(() => {
    if (!payment || round === 0) return;
    let stop = false;
    let timer = 0;
    let tries = 0;
    setPolling(true);
    const ask = async () => {
      const answer = await confirmPayment(payment);
      if (stop) return;
      tries += 1;
      savePayment({ ...payment, state: answer.state });
      setVerdict(answer);
      if (answer.state === "confirming" && tries < CONFIRM_TRIES) timer = window.setTimeout(ask, CONFIRM_EVERY_MS);
      else setPolling(false);
    };
    void ask();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [payment, round]);

  const view = doneView({ trialEmail, trialSent, hasPayment: payment !== null, verdict: verdict?.state ?? null, orderNo, simulatedFor });
  if (!ready) return null;

  if (trialEmail && !trialSent) {
    return (
      <DoneLayout
        tone="warn"
        badge="Trial saved · email not sent"
        title="Your trial is saved — but the email did not go out."
        lead={<>We tried to send the confirmation link to <strong>{trialEmail}</strong> and it did not go through. Nothing was charged, and your request is with us.</>}
        steps={[
          { title: "Trial request saved", done: true, body: "Nothing was charged and no card was taken." },
          { title: "Write to us from that address", body: <>Email <a href={`mailto:${COMPANY.supportEmail}?subject=${encodeURIComponent("Please start my hosting trial")}`} style={{ color: "var(--primary)", fontWeight: 600 }}>{COMPANY.supportEmail}</a> from {trialEmail} and we start the trial for you.</> },
          { title: "Mistyped the address?", body: "Start again from the hosting page with the right one." },
        ]}
        aside={<>
          <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 8 }}>Trial for</div>
          <div style={{ fontWeight: 600, fontSize: 16, wordBreak: "break-all" }}>{trialEmail}</div>
          <HelpBlock subject="Please start my hosting trial" />
        </>}
        actions={<>
          <Link href="/hosting" className="btn btn-primary">Back to hosting</Link>
          <Link href="/" className="btn btn-outline">Back to home</Link>
        </>}
      />
    );
  }

  if (trialEmail) {
    return (
      <DoneLayout
        tone="success"
        badge="Trial requested · nothing charged"
        title="One step left — confirm your email."
        lead={<>We sent a link to <strong>{trialEmail}</strong>. Open it within 48 hours and we set up your Starter hosting.</>}
        steps={[
          { title: "Trial requested", done: true, body: "No card was taken, so nothing can be charged when the trial ends." },
          { title: "Confirm your email", body: <>Open the link we sent to {trialEmail} within 48 hours. Check spam if it is not in your inbox.</> },
          { title: "We set up your hosting", body: "Your Starter account is created and the login is emailed to you. Your 15 free days start then." },
          { title: "Moving from another host?", body: "Reply to that email with your current login — the migration is free." },
        ]}
        aside={<>
          <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 8 }}>Link sent to</div>
          <div style={{ fontWeight: 600, fontSize: 16, wordBreak: "break-all" }}>{trialEmail}</div>
          <div className="meta" style={{ marginTop: 8 }}>Starter hosting · 15 days free</div>
          <HelpBlock subject="My hosting trial" />
        </>}
        actions={<>
          <Link href="/hosting" className="btn btn-primary">Back to hosting</Link>
          <Link href="/" className="btn btn-outline">Back to home</Link>
        </>}
      />
    );
  }

  const orderAside = (subject: string) => (
    <>
      <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 10 }}>Your order</div>
      <div className="mono" style={{ fontSize: 17, fontWeight: 600, color: "var(--text)", wordBreak: "break-all" }}>{orderNo ?? "—"}</div>
      {payment && <div className="meta" style={{ marginTop: 8, wordBreak: "break-all" }}>Razorpay payment {payment.paymentId}</div>}
      <HelpBlock subject={`${subject}${orderNo ? ` — ${orderNo}` : ""}${payment ? ` (${payment.paymentId})` : ""}`} />
    </>
  );

  if (payment && verdict?.state !== "paid") {
    const state = verdict?.state ?? "confirming";
    const checking = polling || !verdict;
    if (state === "refused" || state === "failed") {
      const refused = state === "refused";
      return (
        <DoneLayout
          tone="warn"
          badge={refused ? "Payment needs a check" : "Payment not completed"}
          title={refused ? "We couldn't match this payment to your order." : "The payment didn't go through."}
          lead={verdict?.message || (refused ? "Please don't pay again — email support and we'll sort it out." : "Your bank or Razorpay did not complete it.")}
          steps={refused
            ? [
                { title: "Don't pay again", body: "If money left your account, it is with Razorpay and we can see it." },
                { title: "Email support", body: "Send us your order number and the Razorpay payment id shown here — we finish the order by hand, or refund it." },
              ]
            : [
                { title: "If money left your account", body: "Your bank refunds a payment that did not complete automatically, usually within 5–7 working days." },
                { title: "Try again", body: "Email support with your order number and we send you a payment link for the same order and price." },
              ]}
          aside={orderAside(refused ? "Please check my payment" : "My payment didn't go through")}
          actions={<>
            <a href={`mailto:${COMPANY.supportEmail}?subject=${encodeURIComponent(`Payment ${payment.paymentId}${orderNo ? ` for ${orderNo}` : ""}`)}`} className="btn btn-primary">Email support</a>
            <Link href="/" className="btn btn-outline">Back to home</Link>
          </>}
        />
      );
    }
    return (
      <DoneLayout
        tone="warn"
        badge="Payment taken · confirming your order"
        title={checking ? "We're confirming your payment." : "Your payment is still being confirmed."}
        lead={checking
          ? "Razorpay has your payment and we're recording your order. This usually takes a few seconds — please keep this page open."
          : "It's taking longer than usual. Please don't pay again: your order completes automatically as soon as Razorpay confirms the payment, and a “Payment received” email follows."}
        steps={[
          { title: "Payment taken by Razorpay", done: true, body: "Your bank approved it." },
          { title: "Recording your order", body: <>
            <BusyPanel active={checking} title="Confirming your payment" steps={["Checking the payment with Razorpay", "Recording your order", "Issuing your GST invoice"]} />
            {!checking && (verdict?.message || "We'll keep checking.")}
          </> },
          { title: "Confirmation email", body: "A “Payment received” email with your order number and GST invoice." },
        ]}
        aside={orderAside("My payment is still confirming")}
        actions={<>
          {/* While a check runs the BusyPanel shows it; the button only appears when idle, so it is never silently disabled. */}
          {!checking && <button type="button" className="btn btn-primary" onClick={() => setRound((r) => r + 1)}>Check again</button>}
          <Link href="/" className="btn btn-outline">Back to home</Link>
        </>}
      />
    );
  }

  if (view !== "paid") {
    return (
      <DoneLayout
        tone="warn"
        badge="No order in this browser"
        title="Looking for your order?"
        lead={orderNo
          ? <>This page can&apos;t confirm a payment for <span className="mono">{orderNo}</span>. If you paid, the confirmation email is your record.</>
          : "This page shows your order right after you pay. Opened later, in a new tab or from a link, it has nothing to show."}
        steps={[
          { title: "Paid already?", body: "Look for the “Payment received” email — it carries your order number and arrives within a few minutes of paying. Check spam too." },
          { title: "No email after 15 minutes?", body: "Write to support from the email address you used at checkout and we find your order." },
          { title: "Haven't ordered yet?", body: "Your cart is kept on this device — go back to it and check out." },
        ]}
        aside={<>
          <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 10 }}>Your order</div>
          <div style={{ fontSize: 15, lineHeight: 1.55, color: "var(--text-secondary)" }}>Your order number is in the confirmation email.</div>
          <HelpBlock subject={orderNo ? `My order ${orderNo}` : "Finding my order"} />
        </>}
        actions={<>
          <Link href="/cart" className="btn btn-primary">Go to cart</Link>
          <Link href="/" className="btn btn-outline">Back to home</Link>
        </>}
      />
    );
  }

  return (
    <DoneLayout
      tone="success"
      badge="Payment received · order placed"
      title="Thank you — your order is with us."
      lead="Your payment went through. A confirmation with your order number is on its way to your inbox."
      steps={[
        { title: "Payment received", done: true, body: "Your payment is confirmed, and the amount includes GST." },
        { title: "Confirmation email", body: <>A “Payment received” email{orderNo ? <> for <span className="mono">{orderNo}</span></> : ""} arrives in a few minutes. Keep it: it carries your order number.</> },
        { title: "We set it up", body: "Hosting and domains are set up for you, and the login details come in a separate email. For Google Workspace, our team contacts you to verify your domain." },
        { title: "GST tax invoice", body: "Issued in your business name and emailed to you. Moving from another host? Reply to the confirmation and we migrate you free." },
      ]}
      aside={<>
        <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 10 }}>Your order</div>
        {orderNo ? (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 14px", borderRadius: 8, background: "var(--tint)", border: "1px solid var(--border-light)" }}>
              <span className="mono" style={{ fontSize: 17, fontWeight: 600, color: "var(--text)", wordBreak: "break-all" }}>{orderNo}</span>
              <CopyNumber value={orderNo} />
            </div>
            <div className="meta" style={{ marginTop: 8 }}>Quote this number and support finds your order at once.</div>
          </>
        ) : (
          <div style={{ fontSize: 15, lineHeight: 1.55, color: "var(--text-secondary)" }}>Your order number is in the confirmation email.</div>
        )}
        <AfterYouPay style={{ borderTop: "1px solid var(--border-light)", paddingTop: 18, marginTop: 18 }} />
        <HelpBlock subject={orderNo ? `My order ${orderNo}` : "My order"} />
      </>}
      actions={<>
        <Link href={CLIENT_AREA_URL as never} className="btn btn-primary">Customer login (hosting &amp; domains)</Link>
        <Link href="/" className="btn btn-outline">Back to home</Link>
      </>}
    />
  );
}
