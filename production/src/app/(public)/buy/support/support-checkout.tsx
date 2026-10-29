"use client";

/**
 * /buy/support — the page (R-2083). One screen: pick the plan and the term, fill the details
 * the GST invoice needs, pay. The figures come from the server (page.tsx → price book); this
 * file never computes a price, and the server prices the order again from the plan + term.
 *
 * Layout: one column on a phone (the summary and Pay sit under the form), the form and a sticky
 * summary side by side from md — 960px wide at most, so it fits 1280 with room to spare.
 */
import * as React from "react";
import { useTurnstile } from "@/components/shared/turnstile";
import { fromRazorpayHandler } from "@/lib/checkout/confirm-payment";
import { payButtonLabel, type CheckoutPaymentMode } from "@/lib/checkout/checkout-payment-mode";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { rupee } from "@/lib/utils";
import { COMPANY } from "@/site/lib/config";
import { yearlySavingPct, type SupportBuyPlan, type SupportBuyTerm, type SupportPriceView } from "@/lib/support/public-checkout";
import { STATE_OPTIONS } from "../workspace/_parts/checkout-form";
import { postJson, NOT_REACHED } from "../workspace/post-json";
import { saveSupportPayment, supportThanksUrl } from "./payment-handoff";

export interface SupportPlanCard {
  id: SupportBuyPlan;
  label: string;
  summary: string;
  slaHours: number;
  features: string[];
  prices: Record<SupportBuyTerm, SupportPriceView>;
}

interface Props {
  plans: SupportPlanCard[];
  initialPlan: SupportBuyPlan;
  initialTerm: SupportBuyTerm;
  initialEmail: string;
  billingCustomerId: string;
  paymentMode: CheckoutPaymentMode;
  sellerName: string | null;
}

interface CheckoutAnswer {
  error?: string; simulated?: boolean; orderId?: string; amount?: number; currency?: string;
  razorpayKeyId?: string; quoteId?: string; publicToken?: string; tierName?: string;
}

type Field = "name" | "company" | "email" | "phone" | "gstin" | "stateCode" | "agree" | "form";

const inputCls = (bad?: string) =>
  `w-full h-11 px-3 rounded-[10px] border bg-white text-[15px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber ${bad ? "border-rose" : "border-hairline-strong"}`;

/* ── Razorpay Checkout JS, loaded when someone pays ─────────────────────────────────────── */
type RzpCtor = new (o: Record<string, unknown>) => { open: () => void; on: (e: string, h: (r: { error?: { description?: string } }) => void) => void };
const RZP_SRC = "https://checkout.razorpay.com/v1/checkout.js";
function loadRazorpay(): Promise<RzpCtor> {
  return new Promise((resolve, reject) => {
    const have = (window as unknown as { Razorpay?: RzpCtor }).Razorpay;
    if (have) return resolve(have);
    const s = document.createElement("script");
    s.src = RZP_SRC;
    s.async = true;
    s.onload = () => {
      const r = (window as unknown as { Razorpay?: RzpCtor }).Razorpay;
      if (r) resolve(r); else reject(new Error("Razorpay missing"));
    };
    s.onerror = () => reject(new Error("Razorpay script failed"));
    document.body.appendChild(s);
  });
}

export function SupportCheckout(p: Props) {
  const [plan, setPlan] = React.useState<SupportBuyPlan>(p.initialPlan);
  const [term, setTerm] = React.useState<SupportBuyTerm>(p.initialTerm);
  const [f, setF] = React.useState({ name: "", company: "", email: p.initialEmail, phone: "", gstin: "", stateCode: "" });
  const [agree, setAgree] = React.useState(false);
  const [errors, setErrors] = React.useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = React.useState(false);
  const ts = useTurnstile();

  const card = p.plans.find((x) => x.id === plan) ?? p.plans[0];
  const price = card.prices[term];
  const canPay = p.paymentMode !== "disabled" && price.exGst > 0;
  const set = (k: keyof typeof f, v: string) => { setF((o) => ({ ...o, [k]: v })); setErrors({}); };

  function check(): boolean {
    const e: Partial<Record<Field, string>> = {};
    if (f.name.trim().length < 2) e.name = "Enter your name";
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) e.email = "Enter the email you use at the support desk";
    if (f.phone.replace(/\D/g, "").length < 10) e.phone = "Enter a 10-digit mobile number";
    if (f.gstin.trim() && !stateCodeFromGstin(f.gstin.trim().toUpperCase())) e.gstin = "Check the GSTIN, or leave it empty";
    if (!f.stateCode) e.stateCode = "Choose your state — it decides CGST + SGST or IGST";
    if (!agree) e.agree = "Please accept the terms to continue";
    if (ts.required && !ts.ready) e.form = "Wait for the security check to finish, then press again.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function pay() {
    if (busy || !canPay || !check()) return;
    setBusy(true);
    /* Every way out says what did NOT happen, and frees the button. */
    const stop = (form: string) => { setErrors({ form }); setBusy(false); };
    try {
      const r = await postJson<CheckoutAnswer>("/api/public/checkout/support", {
        plan, term, fullName: f.name.trim(), companyName: f.company.trim() || undefined, email: f.email.trim(),
        phone: f.phone.trim(), gstin: f.gstin.trim() || undefined, stateCode: f.stateCode,
        billingCustomerId: p.billingCustomerId || undefined,
        simulate: p.paymentMode === "simulation" ? true : undefined,
      }, ts.headers);
      ts.reset();
      if (!r.reached) return stop(`${NOT_REACHED} No money was taken — check your connection and press Pay again.`);
      const j = r.json;
      if (!r.ok || j.error) return stop(j.error ?? "Could not start the payment. No money was taken.");
      if (j.simulated && j.quoteId && j.publicToken) { window.location.href = supportThanksUrl(j.quoteId, j.publicToken, true); return; }
      if (!j.orderId || !j.razorpayKeyId || !j.amount || !j.quoteId || !j.publicToken) return stop("Could not open the payment window. No money was taken.");
      const Rzp = await loadRazorpay().catch(() => null);
      if (!Rzp) return stop("Could not load the payment window. No money was taken — press Pay again.");
      const quoteId = j.quoteId, token = j.publicToken;
      const rzp = new Rzp({
        key: j.razorpayKeyId, amount: j.amount, currency: j.currency ?? "INR", order_id: j.orderId,
        name: p.sellerName ?? COMPANY.short, description: j.tierName ?? price.label,
        prefill: { name: f.name.trim(), email: f.email.trim(), contact: f.phone.trim() },
        theme: { color: "#1668E3" },
        handler: (resp: unknown) => {
          saveSupportPayment(quoteId, fromRazorpayHandler(resp));
          window.location.href = supportThanksUrl(quoteId, token, false);
        },
        modal: { ondismiss: () => setBusy(false), escape: true },
      });
      rzp.on("payment.failed", (resp) => setErrors({ form: `Payment failed${resp.error?.description ? `: ${resp.error.description}` : "."} No money was taken.` }));
      rzp.open(); // busy stays on while the window is open; closing it frees the button
    } catch {
      stop("Something went wrong before payment. No money was taken — press Pay again.");
    }
  }

  const saving = yearlySavingPct(card.prices.monthly.exGst, card.prices.yearly.exGst);
  const field = (k: "name" | "company" | "email" | "phone", label: React.ReactNode, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label htmlFor={`sup-${k}`} className="block text-[13px] font-semibold text-ink-2 mb-1.5">{label}</label>
      <input id={`sup-${k}`} value={f[k]} onChange={(e) => set(k, e.target.value)} aria-invalid={!!errors[k]} aria-describedby={`sup-${k}-err`} className={inputCls(errors[k])} {...extra} />
      <p id={`sup-${k}-err`} className="text-[13px] text-rose min-h-5 mt-1">{errors[k] ?? ""}</p>
    </div>
  );

  return (
    <main className="min-h-screen bg-paper">
      {p.paymentMode === "simulation" && (
        <p className="bg-amber-soft text-amber-ink text-center text-sm font-semibold px-4 py-2">Test mode — no real payment is taken on this computer.</p>
      )}
      <div className="mx-auto max-w-5xl px-4 py-8 md:py-12">
        <p className="text-sm text-ink-3 m-0">{p.sellerName ?? COMPANY.short}</p>
        <h1 className="text-2xl md:text-3xl font-bold text-ink mt-1 mb-2">Buy a support plan</h1>
        <p className="text-[15px] text-ink-2 mb-8 max-w-2xl">Faster answers from our support desk. Pay online and get a GST tax invoice; the plan is switched on at the desk for the same email within minutes.</p>

        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_340px] items-start">
          <div className="min-w-0 space-y-6">
            <section aria-labelledby="sup-plan-h" className="bg-white border border-hairline rounded-2xl p-5">
              <h2 id="sup-plan-h" className="text-base font-semibold text-ink mt-0 mb-3">1. Plan</h2>
              <div role="radiogroup" aria-label="Plan" className="grid gap-3 sm:grid-cols-2">
                {p.plans.map((x) => (
                  <button key={x.id} type="button" role="radio" aria-checked={plan === x.id} onClick={() => setPlan(x.id)}
                    className={`text-left p-4 rounded-xl border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber ${plan === x.id ? "border-amber bg-amber-soft" : "border-hairline bg-white"}`}>
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-[16px] font-semibold text-ink">{x.label}</span>
                      <span className="text-[15px] font-semibold text-ink whitespace-nowrap">{rupee(x.prices[term].exGst)}<span className="text-xs font-normal text-ink-3">{term === "yearly" ? "/yr" : "/mo"}</span></span>
                    </span>
                    <ul className="mt-2 mb-0 pl-4 text-[13px] text-ink-2 space-y-0.5">
                      {x.features.map((t) => <li key={t}>{t}</li>)}
                    </ul>
                  </button>
                ))}
              </div>
              <div role="radiogroup" aria-label="Billing" className="mt-4 inline-flex rounded-xl border border-hairline p-1 bg-paper">
                {(["yearly", "monthly"] as const).map((t) => (
                  <button key={t} type="button" role="radio" aria-checked={term === t} onClick={() => setTerm(t)}
                    className={`min-h-10 px-4 rounded-lg text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber ${term === t ? "bg-white text-ink shadow-sm" : "text-ink-3"}`}>
                    {t === "yearly" ? `Yearly${saving ? ` · save ${saving}%` : ""}` : "Monthly"}
                  </button>
                ))}
              </div>
            </section>

            <section aria-labelledby="sup-det-h" className="bg-white border border-hairline rounded-2xl p-5">
              <h2 id="sup-det-h" className="text-base font-semibold text-ink mt-0 mb-3">2. Your details (for the GST invoice)</h2>
              <div className="grid gap-x-4 sm:grid-cols-2">
                {field("name", "Your name", { autoComplete: "name" })}
                {field("company", <>Company <span className="font-normal text-ink-3">(optional)</span></>, { autoComplete: "organization" })}
                {field("email", "Email (the one you use at the support desk)", { type: "email", autoComplete: "email" })}
                {field("phone", "Mobile", { type: "tel", autoComplete: "tel", placeholder: "98765 43210" })}
                <div>
                  <label htmlFor="sup-gstin" className="block text-[13px] font-semibold text-ink-2 mb-1.5">GSTIN <span className="font-normal text-ink-3">(optional)</span></label>
                  <input id="sup-gstin" value={f.gstin} maxLength={15} placeholder="07ABCDE1234F1Z5" aria-invalid={!!errors.gstin} aria-describedby="sup-gstin-err"
                    onChange={(e) => {
                      const v = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "");
                      set("gstin", v);
                      const st = stateCodeFromGstin(v);
                      if (st) setF((o) => ({ ...o, gstin: v, stateCode: st }));
                    }}
                    className={`${inputCls(errors.gstin)} font-mono`} />
                  <p id="sup-gstin-err" className="text-[13px] text-rose min-h-5 mt-1">{errors.gstin ?? ""}</p>
                </div>
                <div>
                  <label htmlFor="sup-state" className="block text-[13px] font-semibold text-ink-2 mb-1.5">State (place of supply)</label>
                  <select id="sup-state" value={f.stateCode} onChange={(e) => set("stateCode", e.target.value)} aria-invalid={!!errors.stateCode} aria-describedby="sup-state-err" className={inputCls(errors.stateCode)}>
                    <option value="">Select state</option>
                    {STATE_OPTIONS.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
                  </select>
                  <p id="sup-state-err" className="text-[13px] text-rose min-h-5 mt-1">{errors.stateCode ?? ""}</p>
                </div>
              </div>
            </section>
          </div>

          <aside aria-labelledby="sup-sum-h" className="bg-white border border-hairline rounded-2xl p-5 md:sticky md:top-6">
            <h2 id="sup-sum-h" className="text-base font-semibold text-ink mt-0 mb-3">3. Pay</h2>
            <dl className="m-0 text-[15px] space-y-2">
              <div className="flex justify-between gap-3"><dt className="text-ink-2">{price.label}</dt><dd className="m-0 text-ink">{rupee(price.exGst)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink-2">GST 18%</dt><dd className="m-0 text-ink">{rupee(price.gst)}</dd></div>
              <div className="flex justify-between gap-3 border-t border-hairline pt-2 font-bold"><dt className="text-ink">Total</dt><dd className="m-0 text-ink">{rupee(price.total)}</dd></div>
            </dl>
            <p className="text-[13px] text-ink-3 mt-2 mb-4">{term === "yearly" ? "Covers 12 months. We remind you before it renews." : "Covers one month. We send the next month's invoice before it renews."}</p>
            <label htmlFor="sup-agree" className="flex gap-2.5 items-start text-sm text-ink-2 leading-normal cursor-pointer">
              <input id="sup-agree" type="checkbox" checked={agree} onChange={(e) => { setAgree(e.target.checked); setErrors({}); }} aria-describedby="sup-agree-err" className="w-5 h-5 mt-0.5 shrink-0 accent-[hsl(var(--amber))]" />
              <span>I agree to the <a href="/terms-and-conditions" target="_blank" rel="noopener noreferrer" className="text-amber-ink underline underline-offset-[3px]">Terms</a> and the <a href="/refund" target="_blank" rel="noopener noreferrer" className="text-amber-ink underline underline-offset-[3px]">Refund policy</a>.</span>
            </label>
            <p id="sup-agree-err" className="text-[13px] text-rose min-h-5 mt-1">{errors.agree ?? ""}</p>
            {ts.widget}
            {canPay ? (
              <button type="button" onClick={() => void pay()} disabled={busy}
                className="w-full h-12 rounded-xl bg-amber text-white text-[16px] font-bold hover:bg-amber-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 disabled:opacity-60">
                {busy ? "Please wait…" : payButtonLabel(p.paymentMode, rupee(price.total))}
              </button>
            ) : (
              <a href={`mailto:${COMPANY.supportEmail}?subject=${encodeURIComponent(`${price.label} — please send a GST quote`)}`}
                className="flex items-center justify-center w-full h-12 rounded-xl bg-amber text-white text-[16px] font-bold hover:bg-amber-ink">
                Ask for a GST quote
              </a>
            )}
            <p role="alert" className="text-[13px] text-rose min-h-5 mt-2 mb-0">{errors.form ?? ""}</p>
            {canPay && <p className="text-xs text-ink-3 text-center m-0">Secure payment via Razorpay — UPI, card or netbanking.</p>}
          </aside>
        </div>
      </div>
    </main>
  );
}
