"use client";
/**
 * R-1971 (26 Oct 2026, design v2): checkout on the page — no popup. Three steps (your domain,
 * business and GST details, payment) beside the sticky order summary. Completed steps fold to
 * one line with Edit. Enterprise (or more than 300 users) is a call / WhatsApp panel instead.
 * The last button pays (Razorpay, server-priced), starts the free trial, or sends a GST quote.
 */
import * as React from "react";
import { useTurnstile } from "@/components/shared/turnstile";
import { WORKSPACE_TRIAL_DAYS } from "@/lib/trials/trial-days";
import { rupee } from "@/lib/utils";
import { SLA, WHATSAPP_READY } from "@/site/lib/config";
import { normalizeGstinInput } from "@/site/lib/checkout-details";
import { buyNowSchema, BUY_ANNUAL_NOTE, BUY_TERMS_ERROR } from "../buy-now-schema";
import { stateName, whatsappHref, type BuyBrand, type BuyContact } from "./brand";
import {
  NEW_DOMAIN_TLDS, STATE_OPTIONS, checkoutBody, domainValue, orderCompany, stateFromGstin,
  type BuyerField, type NewDomainTld, type PayMethod,
} from "./checkout-form";
import { BUSINESS_MAX_USERS, type Billing, type BuyPlan, type PlanSum } from "./plans";
import { payOrder, requestQuote, startTrial, type SubmitContext } from "./submit-order";
import { OrderSummary } from "./order-summary";
import type { CheckoutState, Step } from "./use-checkout";

export const BUY_MONTHLY_NOTE = "Monthly plan — billed each month for your users.";

const METHODS: ReadonlyArray<{ id: PayMethod; label: string; sub: string }> = [
  { id: "upi", label: "UPI", sub: "GPay, PhonePe, Paytm, BHIM" },
  { id: "card", label: "Card", sub: "Credit or debit, incl. corporate cards" },
  { id: "netbanking", label: "Netbanking", sub: "All major Indian banks" },
];

const input = (bad?: string) =>
  `w-full h-12 px-3.5 text-base border rounded-[10px] bg-paper focus:outline-none focus-visible:ring-2 focus-visible:ring-amber ${bad ? "border-rose" : "border-hairline"}`;
const amberBtn = "h-12 px-6 rounded-[10px] bg-amber text-white text-[15px] font-semibold hover:bg-amber-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 disabled:opacity-60";

function Err({ id, msg }: { id: string; msg?: string }) {
  return <div id={id} className="text-[13px] text-rose min-h-5 mt-1">{msg ?? ""}</div>;
}

function StepCard({ n, step, title, summary, onEdit, children }: { n: Step; step: Step; title: string; summary: string; onEdit?: () => void; children: React.ReactNode }) {
  const done = step > n, open = step === n;
  return (
    <section aria-label={title} className="bg-white border border-hairline rounded-[14px] overflow-hidden">
      <div className="flex items-center gap-3.5 px-[22px] py-5">
        <span aria-hidden className={`w-[30px] h-[30px] rounded-full grid place-items-center text-sm font-bold shrink-0 ${done ? "bg-emerald text-white" : open ? "bg-amber text-white" : "bg-paper-2 text-ink-3"}`}>
          {done ? "✓" : n}
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="text-[17px] font-semibold m-0">{title}</h3>
          <p className="text-sm text-ink-3 mt-0.5 mb-0 truncate">{summary}</p>
        </div>
        {done && onEdit && <button type="button" onClick={onEdit} className="min-h-11 text-sm font-semibold text-amber-ink">Edit<span className="sr-only"> {title}</span></button>}
      </div>
      {open && <div className="px-[22px] pb-6 pt-5 border-t border-hairline">{children}</div>}
    </section>
  );
}

export interface CheckoutProps {
  plan: BuyPlan; seats: number; billing: Billing; sum: PlanSum | null;
  promo: { label: string; off: number } | null;
  co: CheckoutState; brand: BuyBrand | null; contact: BuyContact; waMessage: string;
  /** The page can take money online (live, or simulated on a test site). */
  onlinePay: boolean;
  isSimulation: boolean;
  onChangePlan: () => void;
}

/** Pay is offered only for a priced business plan, ≤300 users, with online payment on. */
export function canPayOnline(plan: BuyPlan, seats: number, sum: PlanSum | null, onlinePay: boolean): boolean {
  return onlinePay && !plan.custom && !plan.priceHidden && !!sum && seats <= BUSINESS_MAX_USERS;
}

function EnterprisePanel({ contact, waMessage, seats }: { contact: BuyContact; waMessage: string; seats: number }) {
  return (
    <div className="bg-white border border-hairline rounded-[14px] p-7">
      <h3 className="font-serif font-normal text-[26px] mb-2">Enterprise is quoted, not checked out</h3>
      <p className="text-[15px] text-ink-2 leading-relaxed mb-5">
        {seats > BUSINESS_MAX_USERS ? `Business plans stop at ${BUSINESS_MAX_USERS} users. ` : ""}
        Tell us your user count and compliance needs and we send a written GST quote {SLA.quote}. Or pick a Business plan above to buy online now.
      </p>
      <div className="flex flex-wrap gap-2.5">
        {contact.tel && <a href={contact.tel.href} className="inline-flex items-center h-[46px] px-5 rounded-[10px] bg-ink text-paper no-underline font-semibold">Call {contact.tel.display}</a>}
        {contact.whatsapp && <a href={whatsappHref(contact.whatsapp, waMessage)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center h-[46px] px-5 rounded-[10px] border border-hairline-strong text-ink no-underline font-semibold">WhatsApp us</a>}
      </div>
    </div>
  );
}

export function Checkout(p: CheckoutProps) {
  const { co, plan } = p;
  const ts = useTurnstile();
  const [rzpOpen, setRzpOpen] = React.useState(false);
  const payable = canPayOnline(plan, p.seats, p.sum, p.onlinePay);
  /* The mode the last step runs: pay / trial as the buyer picks; a quote when paying is not on. */
  const mode = co.mode === "trial" ? "trial" : payable ? "pay" : "quote";
  const enterprise = plan.custom || p.seats > BUSINESS_MAX_USERS;
  const total = co.totals?.total ?? 0;
  const domain = domainValue(co.domain);
  /* Paying / sending, or Razorpay's own window is open — the label says "Please wait…". */
  const busy = co.busy || rzpOpen;

  const ctx = (): SubmitContext => ({
    plan, seats: p.seats, billing: p.billing, domain: co.domain, buyer: co.buyer,
    ts: { headers: ts.headers, reset: ts.reset }, sellerName: p.brand?.name ?? "Google Workspace",
  });

  async function place() {
    if (co.busy || rzpOpen) return;
    if (!co.agree) { co.setErrors({ agree: BUY_TERMS_ERROR }); return; }
    /* The bot check must finish first — say so instead of a silently dead button. */
    if (ts.required && !ts.ready) { co.setErrors({ agree: "Wait for the security check above to finish, then press again." }); return; }
    co.setBusy(true);
    try {
      if (mode === "trial") { await startTrial(ctx(), () => void place()); return; }
      if (mode === "quote") { await requestQuote(ctx(), () => void place()); return; }
      const body = checkoutBody({ plan, seats: p.seats, billing: p.billing, domain: co.domain, buyer: co.buyer, couponCode: co.coupon?.code ?? null, simulate: p.isSimulation });
      /* The same rules as the old Buy now form (R-173 state, R-226 terms, R-227 GSTIN, R-232). */
      const check = buyNowSchema.safeParse(body);
      if (!check.success) { co.setErrors({ agree: check.error.issues[0]?.message }); return; }
      await payOrder(ctx(), body, co.method, setRzpOpen, () => void place());
    } finally {
      co.setBusy(false);
    }
  }

  const field = (k: BuyerField, label: React.ReactNode, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label htmlFor={`buy-${k}`} className="block text-[13px] font-semibold text-ink-2 mb-1.5">{label}</label>
      <input
        id={`buy-${k}`}
        value={co.buyer[k]}
        onChange={(e) => co.setField(k, k === "gstin" ? normalizeGstinInput(e.target.value) : e.target.value)}
        aria-invalid={!!co.errors[k]}
        aria-describedby={`buy-${k}-err`}
        className={input(co.errors[k])}
        {...extra}
      />
      <Err id={`buy-${k}-err`} msg={co.errors[k]} />
    </div>
  );
  const gstinState = stateFromGstin(co.buyer.gstin);

  const payLabel = mode === "trial" ? "Start free trial"
    : mode === "quote" ? "Send me a GST quote"
    : p.isSimulation ? `Place test order · ${rupee(total)}` : `Pay ${rupee(total)} securely`;

  return (
    <section id="checkout" className="bg-paper-2 border-y border-hairline scroll-mt-16">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-16">
        <h2 tabIndex={-1} className="font-serif font-normal text-[clamp(30px,3.6vw,42px)] leading-[1.1] mb-2 outline-none">{mode === "trial" ? "Start your free trial" : "Checkout"}</h2>
        <p className={`text-base text-ink-2 ${mode === "trial" ? "mb-2" : "mb-8"}`}>Three short steps. No account needed — we set up your admin login with you after {mode === "trial" ? "you start" : "payment"}.</p>
        {/* R-1975: in trial mode the way back to paying is here from step 1, not only on step 3. */}
        {mode === "trial" && (
          <p className="text-sm text-ink-2 mb-8">
            Ready to buy today?{" "}
            <button type="button" onClick={() => co.setMode("pay")} className="min-h-11 font-semibold text-amber-ink underline underline-offset-[3px]">Pay now instead</button>
          </p>
        )}
        <div className="flex flex-wrap gap-6 items-start">
          <div className="flex-[1_1_520px] min-w-0 flex flex-col gap-3">
            {enterprise ? <EnterprisePanel contact={p.contact} waMessage={p.waMessage} seats={p.seats} /> : (
              <>
                <StepCard n={1} step={co.step} title="Your domain" onEdit={() => co.setStep(1)}
                  summary={co.step > 1 ? `${domain} · ${co.domain.mode === "new" ? "new — we register it" : "you own it"}` : "Use your own or ask us to register a new one"}>
                  <div role="radiogroup" aria-label="Domain" className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5 mb-5">
                    {([["existing", "I already have a domain", "e.g. yourcompany.in — keep your website as it is"], ["new", "I need a new domain", "We register it and connect it for you"]] as const).map(([m, t, s]) => (
                      <button key={m} type="button" role="radio" aria-checked={co.domain.mode === m}
                        onClick={() => { co.setDomain({ ...co.domain, mode: m }); co.setErrors({}); }}
                        className={`text-left p-4 rounded-[10px] border-2 ${co.domain.mode === m ? "border-amber bg-amber-soft" : "border-hairline bg-white"}`}>
                        <div className="text-[15px] font-semibold text-ink">{t}</div>
                        <div className="text-[13px] text-ink-3 mt-1">{s}</div>
                      </button>
                    ))}
                  </div>
                  {co.domain.mode === "existing" ? (
                    <>
                      <label htmlFor="buy-domain" className="block text-[13px] font-semibold text-ink-2 mb-1.5">Your domain</label>
                      <input id="buy-domain" value={co.domain.domain} placeholder="yourcompany.in" autoComplete="off" aria-invalid={!!co.errors.domain} aria-describedby="buy-domain-err"
                        onChange={(e) => { co.setDomain({ ...co.domain, domain: e.target.value }); co.setErrors({}); }}
                        className={`${input(co.errors.domain)} font-mono`} />
                      <Err id="buy-domain-err" msg={co.errors.domain} />
                      <p className="text-[13px] text-ink-3 leading-relaxed m-0">After payment we verify ownership with one DNS record — on a call, with you. Your website keeps working; only email moves to Google.</p>
                    </>
                  ) : (
                    <>
                      <label htmlFor="buy-newdomain" className="block text-[13px] font-semibold text-ink-2 mb-1.5">The domain you want</label>
                      <div className="flex gap-2 flex-wrap">
                        <input id="buy-newdomain" value={co.domain.newName} placeholder="yourcompany" autoComplete="off" aria-invalid={!!co.errors.newName} aria-describedby="buy-newdomain-err"
                          onChange={(e) => { co.setDomain({ ...co.domain, newName: e.target.value }); co.setErrors({}); }}
                          className={`${input(co.errors.newName)} flex-[1_1_200px] w-auto min-w-0 font-mono`} />
                        <label htmlFor="buy-tld" className="sr-only">Domain ending</label>
                        <select id="buy-tld" value={co.domain.tld} onChange={(e) => co.setDomain({ ...co.domain, tld: e.target.value as NewDomainTld })}
                          className="h-12 px-3 text-[15px] border border-hairline rounded-[10px] bg-paper">
                          {NEW_DOMAIN_TLDS.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                      <Err id="buy-newdomain-err" msg={co.errors.newName} />
                      <p className="text-[13px] text-ink-3 leading-relaxed m-0">We&apos;ll register it for you — we&apos;ll call you to confirm the name and its price before it is bought.</p>
                    </>
                  )}
                  <button type="button" onClick={co.next1} className={`${amberBtn} mt-5`}>Continue</button>
                </StepCard>

                <StepCard n={2} step={co.step} title="Business and GST details" onEdit={() => co.setStep(2)}
                  summary={co.step > 2 ? `${orderCompany(co.buyer)} · ${co.buyer.gstin || "No GSTIN"}` : "For your GST invoice and admin login"}>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4 gap-y-1">
                    {field("name", "Your name", { autoComplete: "name" })}
                    {field("company", <>Company or business name <span className="font-normal text-ink-3">(optional)</span></>, { autoComplete: "organization" })}
                    {field("email", "Email for invoice and login", { type: "email", autoComplete: "email", placeholder: "you@gmail.com is fine" })}
                    {field("phone", "Mobile (WhatsApp)", { type: "tel", autoComplete: "tel", placeholder: "98765 43210" })}
                    <div>
                      <label htmlFor="buy-gstin" className="block text-[13px] font-semibold text-ink-2 mb-1.5">GSTIN <span className="font-normal text-ink-3">(optional, for input tax credit)</span></label>
                      <input id="buy-gstin" value={co.buyer.gstin} maxLength={15} placeholder="07ABCDE1234F1Z5" aria-invalid={!!co.errors.gstin} aria-describedby="buy-gstin-err"
                        onChange={(e) => {
                          const v = normalizeGstinInput(e.target.value);
                          co.setField("gstin", v);
                          const st = stateFromGstin(v);
                          if (st) co.setField("stateCode", st);
                        }}
                        className={`${input(co.errors.gstin)} font-mono uppercase`} />
                      <div id="buy-gstin-err" className={`text-[13px] min-h-5 mt-1 ${co.errors.gstin ? "text-rose" : gstinState ? "text-emerald" : "text-ink-3"}`}>
                        {co.errors.gstin ?? (gstinState ? `Valid · ${stateName(gstinState)} · input tax credit available` : "Without a GSTIN you get a B2C invoice")}
                      </div>
                    </div>
                    <div>
                      <label htmlFor="buy-stateCode" className="block text-[13px] font-semibold text-ink-2 mb-1.5">State (place of supply)</label>
                      <select id="buy-stateCode" value={co.buyer.stateCode} onChange={(e) => co.setField("stateCode", e.target.value)} aria-invalid={!!co.errors.stateCode} aria-describedby="buy-stateCode-err"
                        className={`${input(co.errors.stateCode)} px-3`}>
                        <option value="">Select state</option>
                        {STATE_OPTIONS.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
                      </select>
                      <Err id="buy-stateCode-err" msg={co.errors.stateCode} />
                    </div>
                  </div>
                  <button type="button" onClick={co.next2} className={`${amberBtn} mt-2`}>{mode === "quote" ? "Continue" : "Continue to payment"}</button>
                </StepCard>

                <StepCard n={3} step={co.step}
                  title={mode === "trial" ? "Start trial" : mode === "quote" ? "Your GST quote" : "Payment"}
                  summary={mode === "trial" ? "No payment needed" : mode === "quote" ? "A written quote, no online payment" : "UPI, card or netbanking"}>
                  {mode === "pay" && (
                    <>
                      <div role="radiogroup" aria-label="Payment method" className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5 mb-4">
                        {METHODS.map((m) => (
                          <button key={m.id} type="button" role="radio" aria-checked={co.method === m.id} onClick={() => co.setMethod(m.id)}
                            className={`text-left p-3.5 rounded-[10px] border-2 min-h-[72px] ${co.method === m.id ? "border-amber bg-amber-soft" : "border-hairline bg-white"}`}>
                            <div className="text-[15px] font-semibold text-ink">{m.label}</div>
                            <div className="text-xs text-ink-3 mt-1 leading-snug">{m.sub}</div>
                          </button>
                        ))}
                      </div>
                      <p className="flex gap-2.5 items-start px-3.5 py-3 border border-hairline rounded-[10px] mb-4 text-sm text-ink-2 leading-normal">
                        <span aria-hidden className="text-emerald font-bold">✓</span>
                        <span>Your {co.method === "upi" ? "UPI app" : "payment screen and bank statement"} will show <b className="text-ink">{p.brand?.name ?? "our company name"}</b>. If you see any other name, stop and call us{p.contact.tel ? ` on ${p.contact.tel.display}` : ""}.</span>
                      </p>
                      <p className="text-sm text-ink-2 mb-4">{p.billing === "annual" ? BUY_ANNUAL_NOTE : BUY_MONTHLY_NOTE}</p>
                    </>
                  )}
                  {mode === "trial" && (
                    <p className="text-sm text-ink-2 leading-relaxed px-4 py-3.5 bg-paper rounded-[10px] mb-4">
                      Free for {WORKSPACE_TRIAL_DAYS} days, with no payment details. Our team {WHATSAPP_READY ? "WhatsApps" : "calls or emails"} you {SLA.firstReply} to set it up; if you don&apos;t buy, the trial simply stops.
                    </p>
                  )}
                  {mode === "quote" && (
                    <p className="text-sm text-ink-2 leading-relaxed px-4 py-3.5 bg-paper rounded-[10px] mb-4">
                      {!p.onlinePay ? "Online payment opens soon. " : ""}We send a written GST quote for {plan.name} {SLA.quote}, and call you to finish the order.
                    </p>
                  )}
                  <label htmlFor="buy-agree-terms" className="flex gap-2.5 items-start text-sm text-ink-2 leading-normal mb-1 cursor-pointer">
                    <input id="buy-agree-terms" type="checkbox" checked={co.agree} onChange={(e) => { co.setAgree(e.target.checked); co.setErrors({}); }}
                      aria-describedby="buy-agree-err" className="w-5 h-5 mt-0.5 shrink-0 accent-[hsl(var(--amber))]" />
                    <span>I agree to the <a href="/terms-and-conditions" target="_blank" rel="noopener noreferrer" className="text-amber-ink underline underline-offset-[3px]">Terms</a>, the <a href="/refund" target="_blank" rel="noopener noreferrer" className="text-amber-ink underline underline-offset-[3px]">Refund policy</a> and the <a href="https://workspace.google.com/terms/" target="_blank" rel="noopener noreferrer" className="text-amber-ink underline underline-offset-[3px]">Google Workspace terms</a>.</span>
                  </label>
                  <Err id="buy-agree-err" msg={co.errors.agree} />
                  {ts.widget}
                  <button type="button" onClick={() => void place()} disabled={busy}
                    className="w-full h-14 rounded-xl bg-amber text-white text-[17px] font-bold hover:bg-amber-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 disabled:opacity-60">
                    {busy ? "Please wait…" : payLabel}
                  </button>
                  {payable && co.mode !== "trial" && (
                    <div className="flex justify-center mt-3">
                      <button type="button" onClick={() => co.setMode("trial")} className="min-h-11 text-sm text-amber-ink underline underline-offset-[3px]">
                        {`Not ready? Start a ${WORKSPACE_TRIAL_DAYS}-day free trial instead`}
                      </button>
                    </div>
                  )}
                  {mode === "pay" && <p className="text-xs text-ink-3 text-center leading-relaxed m-0">Secure payment via Razorpay. We never see your card or UPI PIN.</p>}
                </StepCard>
              </>
            )}
          </div>
          <OrderSummary plan={plan} seats={p.seats} billing={p.billing} sum={p.sum} promo={p.promo} co={co} brand={p.brand} contact={p.contact} waMessage={p.waMessage} onChangePlan={p.onChangePlan} />
        </div>
      </div>
    </section>
  );
}
