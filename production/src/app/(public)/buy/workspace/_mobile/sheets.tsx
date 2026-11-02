"use client";
/**
 * R-2021 (R-2019b): the phone flow's bottom sheets.
 *  - Help: the founder card (COMPANY.founder, the site's WhatsApp / call — never typed numbers),
 *    and four plain answers. "Can I cancel?" is the checkout's own billing sentences + the policy.
 *  - Quote callback: name + mobile + email → /api/public/enquiry/workspace (the desktop's route).
 *  - Free trial: + domain → /api/public/trial/workspace; the length is WORKSPACE_TRIAL_DAYS.
 * Each form shows the R-2011 data notice (with its unticked offers box) and the bot check.
 * The Sample-invoice sheet waits for a real redacted invoice (flags.ts SHOW_SAMPLE_INVOICE).
 */
import * as React from "react";
import { useTurnstile } from "@/components/shared/turnstile";
import { DataNotice } from "@/site/components/legal/DataNotice";
import { formConsent } from "@/lib/consent/data-notice";
import { landingForForm } from "@/site/lib/ad-attribution";
import { COMPANY, SLA, whatsappDisplay } from "@/site/lib/config";
import { WORKSPACE_TRIAL_DAYS } from "@/lib/trials/trial-days";
import { postJson, NOT_REACHED } from "../post-json";
import { whatsappHref, type BuyBrand, type BuyContact } from "../_parts/brand";
import { BUY_ANNUAL_NOTE, BUY_MONTHLY_NOTE } from "../buy-notes";
import type { DomainMode, MigrationSource } from "@/app/api/public/checkout/workspace/buy-intent";
import { inputCls, primaryBtn } from "./checkout-chrome";
import { mobileDigits } from "./form-state";
import { licences } from "./plans-step";
import type { Intent, MobileTier } from "./url-state";
import type { Billing } from "../_parts/plans";

export type SheetKind = "help" | "quote" | "trial";

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div aria-hidden className="absolute inset-0 bg-ink/50" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        className="relative w-full max-w-[480px] max-h-[90vh] overflow-y-auto bg-paper rounded-t-[20px] px-4 pt-3 pb-[max(20px,env(safe-area-inset-bottom))] outline-none">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="font-bold text-[18px] m-0">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="w-11 h-11 rounded-full text-xl text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const FAQS: ReadonlyArray<[string, React.ReactNode]> = [
  ["Is my payment safe?", "Yes. You pay on Razorpay, India's widely used payment gateway. We never see your card number or UPI PIN."],
  ["Will I lose my old emails?", "No. We copy everything over first, and your old email keeps working until the switch is done."],
  ["Can I cancel?", <>{BUY_ANNUAL_NOTE} {BUY_MONTHLY_NOTE} The full terms are in our <a href="/refund" target="_blank" rel="noopener noreferrer" className="text-amber-ink underline underline-offset-[3px]">Refund policy</a>.</>],
  ["Do I need technical knowledge?", "No. We do the setup with you on one phone call. You only need access to where you bought your domain, and we'll guide you."],
];

export function HelpSheet({ brand, contact, onClose, onQuote }: { brand: BuyBrand | null; contact: BuyContact; onClose: () => void; onQuote: () => void }) {
  const [open, setOpen] = React.useState<number | null>(null);
  const wa = contact.whatsapp;
  return (
    <Sheet title="Talk to us" onClose={onClose}>
      <div className="bg-white border border-hairline rounded-[14px] p-3.5 flex flex-col gap-3 mb-4">
        <div className="flex flex-col gap-0.5">
          <span className="font-bold text-base">{COMPANY.founder}</span>
          <span className="text-sm text-ink-2">{brand ? `Founder, ${brand.name}` : "Founder"}</span>
        </div>
        {(wa || contact.tel) ? (
          <div className="grid grid-cols-2 gap-2">
            {wa && <a href={whatsappHref(wa, "Hi, I'm buying Google Workspace on your website and have a question.")} target="_blank" rel="noopener noreferrer" className="h-12 rounded-[10px] bg-ink text-paper text-[15px] font-bold grid place-items-center no-underline">WhatsApp</a>}
            {contact.tel && <a href={contact.tel.href} className="h-12 rounded-[10px] border-[1.5px] border-hairline-strong bg-white text-ink text-[15px] font-bold grid place-items-center no-underline">Call now</a>}
          </div>
        ) : null}
        <p className="text-sm text-ink-2 m-0">{wa ? `${whatsappDisplay(wa)} · ` : ""}{SLA.hours} · Hindi or English</p>
        <button type="button" onClick={onQuote} className="self-start min-h-11 text-sm font-semibold text-amber-ink underline underline-offset-[3px]">Or ask us to call you back</button>
      </div>
      <h3 className="font-bold text-[15px] m-0 mb-2">Common questions</h3>
      <div className="flex flex-col gap-2">
        {FAQS.map(([q, a], i) => (
          <div key={q} className="bg-white border border-hairline rounded-[12px]">
            <button type="button" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}
              className="w-full min-h-12 px-3.5 py-2.5 flex justify-between items-center gap-3 text-left text-[15px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-[12px]">
              {q}<span aria-hidden className="text-ink-3">{open === i ? "−" : "+"}</span>
            </button>
            {open === i && <p className="px-3.5 pb-3 text-sm text-ink-2 m-0">{a}</p>}
          </div>
        ))}
      </div>
    </Sheet>
  );
}

export interface LeadPrefill { name: string; phone: string; email: string; company: string; domain: string }

/** Quote callback or free trial — the desktop's routes, the same bodies plus the phone flow's intent. */
export function LeadSheet({ kind, prefill, tier, planName, seats, billing, intent, domainMode, migrationSource, onClose }: {
  kind: "quote" | "trial"; prefill: LeadPrefill; tier: MobileTier; planName: string; seats: number; billing: Billing;
  intent: Intent | null; domainMode: DomainMode | null; migrationSource: MigrationSource | null; onClose: () => void;
}) {
  const ts = useTurnstile();
  const [v, setV] = React.useState({ name: prefill.name, phone: prefill.phone, email: prefill.email, domain: prefill.domain });
  const [optIn, setOptIn] = React.useState(false);
  const [tried, setTried] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [fail, setFail] = React.useState<string | null>(null);
  const digits = mobileDigits(v.phone);
  const errs = {
    name: v.name.trim().length < 2 ? "Please add your name" : "",
    phone: digits.length !== 10 ? "Please enter a 10-digit mobile number" : "",
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim()) ? "" : "Please check this email address",
    domain: kind === "trial" && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v.domain.trim()) ? "Type your domain, like acme.in" : "",
  };
  const bad = Object.values(errs).some(Boolean);
  const title = kind === "quote" ? "Get a quote by phone" : `Try free for ${WORKSPACE_TRIAL_DAYS} days`;
  const sub = kind === "quote"
    ? `For ${licences(seats)} on ${planName}. We'll call you ${SLA.firstReply}.`
    : "No payment needed. We'll set up a trial and call you to get started.";

  async function send() {
    setTried(true);
    if (bad || busy) return;
    if (ts.required && !ts.ready) { setFail("Wait for the security check to finish, then press again."); return; }
    setBusy(true); setFail(null);
    const name = v.name.trim();
    const common = {
      fullName: name, companyName: prefill.company.trim() || name, email: v.email.trim(), phone: `+91${digits}`, tierId: tier,
      ...(intent ? { intent } : {}), ...(domainMode ? { domainMode } : {}), ...(migrationSource ? { migrationSource } : {}), ...landingForForm(),
    };
    const r = kind === "quote"
      ? await postJson<{ error: string }>("/api/public/enquiry/workspace", { ...common, seats, billing, ...formConsent("buy_quote", optIn) }, ts.headers)
      : await postJson<{ error: string }>("/api/public/trial/workspace", { ...common, seats: Math.min(seats, 300), domain: v.domain.trim().toLowerCase(), ...formConsent("buy_trial", optIn) }, ts.headers);
    ts.reset();
    setBusy(false);
    if (!r.reached) { setFail(`${NOT_REACHED} Nothing was sent — check your internet and try again.`); return; }
    if (!r.ok || r.json.error) { setFail(`${r.json.error ?? "Could not send it."} Nothing was sent yet.`); return; }
    setDone(true);
  }

  const f = (k: keyof typeof v, label: string, extra: React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={`ls-${k}`} className="block text-sm font-semibold text-ink-2 mb-1.5">{label}</label>
      <input id={`ls-${k}`} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} aria-invalid={tried && !!errs[k]} aria-describedby={`ls-${k}-msg`}
        className={inputCls(tried && errs[k])} {...extra} />
      <div id={`ls-${k}-msg`} className="text-sm text-rose-ink min-h-5">{tried ? errs[k] : ""}</div>
    </div>
  );

  return (
    <Sheet title={title} onClose={onClose}>
      {done ? (
        <div role="status" className="flex flex-col gap-3">
          <p className="text-[15px] m-0">{kind === "quote" ? `Thanks! We'll call +91 ${digits} ${SLA.firstReply}.` : `Trial requested. We'll call +91 ${digits} ${SLA.firstReply} to set it up.`}</p>
          <button type="button" onClick={onClose} className={primaryBtn}>Done</button>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-ink-2 m-0 mb-2">{sub}</p>
          {f("name", "Your name", { autoComplete: "name" })}
          {f("phone", "Mobile number (+91)", { type: "tel", inputMode: "numeric", autoComplete: "tel-national", maxLength: 11 })}
          {f("email", "Email", { type: "email", inputMode: "email", autoComplete: "email", autoCapitalize: "none" })}
          {kind === "trial" && f("domain", "Your domain", { inputMode: "url", autoCapitalize: "none", placeholder: "acme.in" })}
          <DataNotice purpose={kind === "quote" ? "quote" : "trial"} optIn={optIn} onOptIn={setOptIn} idPrefix={`ls-${kind}`} compact className="text-ink-2" style={{ margin: "4px 0 10px" }} />
          {ts.widget}
          {fail && <p role="alert" className="text-sm text-rose-ink m-0 mb-2">{fail}</p>}
          <button type="button" onClick={() => void send()} disabled={busy} className={primaryBtn}>
            {busy ? "Please wait…" : kind === "quote" ? "Call me back" : "Start my free trial"}
          </button>
        </div>
      )}
    </Sheet>
  );
}
