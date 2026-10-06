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
 * client area at /dashboard (that is the staff app; customers sign in at /login).
 */
import Link from "@/site/components/ui/SiteLink";
import { useEffect, useState, type ReactNode } from "react";
import { COMPANY, WHATSAPP_READY, WHATSAPP_URL } from "@/site/lib/config";
import { settlePageScroll } from "@/lib/ui/scroll-lock";

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
    } catch { /* storage blocked: the generic wording below still holds */ }
  }, []);

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
        <HelpBlock subject={orderNo ? `My order ${orderNo}` : "My order"} />
      </>}
      actions={<>
        <Link href="/login" className="btn btn-primary">Go to client login</Link>
        <Link href="/" className="btn btn-outline">Back to home</Link>
      </>}
    />
  );
}
