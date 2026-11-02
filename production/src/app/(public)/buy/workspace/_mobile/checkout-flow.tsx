"use client";
/**
 * R-2021 (R-2019b, Pardeep 27 Oct 2026 — design buy-workspace-mobile, R-2019 decisions 5–9):
 * the phone checkout after Plans — Step 1 Domain → Step 2 Details → Step 3 Review & pay →
 * Processing → Success (the existing /buy/workspace/thanks page) or Failed (order kept).
 *
 *  - The step is in the address bar (url-state.ts) and what was typed in this phone's storage
 *    (form-state.ts), so a refresh keeps both; a refresh on a later step with something missing
 *    lands on the first step that needs it.
 *  - Every total shown (summary, bar, Review, Pay) is ONE value — orderTotals on the desktop's
 *    plans (= the server's maths). The CHARGE is the server's: Razorpay opens with the amount the
 *    checkout route sent, and if that differs from what was shown, the buyer sees the server's
 *    amount first (pay.ts serverAmountDiffers).
 *  - Pay is the desktop's route + Razorpay window; paymentMode live / simulation / disabled as on
 *    the desktop (disabled → no Pay, the quote callback instead).
 *  - "WhatsApp me a link to finish this order" (separate, unticked): only with it ticked is a
 *    draft lead sent to our server; otherwise nothing leaves the phone before Pay.
 */
import * as React from "react";
import { rupee } from "@/lib/utils";
import { useTurnstile } from "@/components/shared/turnstile";
import { landingForForm } from "@/site/lib/ad-attribution";
import { postJson } from "../post-json";
import { checkCoupon, recheckCoupon, type AppliedCoupon } from "../coupon-check";
import { orderTotals } from "../_parts/checkout-form";
import { stateName, whatsappHref, type BuyBrand, type BuyContact } from "../_parts/brand";
import type { BuyPlan, PlanSum } from "../_parts/plans";
import { BUY_TERMS_ERROR } from "../buy-notes";
import {
  buyerState, clearForm, detailsErrors, domainStepErrors, errorSummary, firstIncompleteStep, fitMode, loadForm,
  mobileCheckoutBody, mobileDigits, needsAddress, orderDomain, saveForm, EMPTY_FORM, type MobileForm,
} from "./form-state";
import { CheckoutHeader, PriceSummary, StepBar, primaryBtn, type PriceLines } from "./checkout-chrome";
import { DomainStep, DetailsStep } from "./checkout-steps";
import { ReviewStep, ResultScreen, planRow, type Phase, type ReviewRow } from "./review";
import { startOrder, openRazorpay, serverAmountDiffers, type ServerOrder } from "./pay";
import { trackFunnel } from "./funnel";
import { checkoutStepNumber, type MobileState, type CheckoutStep } from "./url-state";

export const DRAFT_SENT_KEY = "buyWs.mobile.draftLead";

export interface MobileCheckoutProps {
  state: MobileState & { step: CheckoutStep };
  update: (patch: Partial<MobileState>) => void;
  plan: BuyPlan;
  sum: PlanSum;
  promo: { label: string; off: number } | null;
  brand: BuyBrand | null;
  contact: BuyContact;
  paymentMode: "live" | "simulation" | "disabled";
  onTalk: () => void;
  onQuote: () => void;
  /** The form as typed — the sheets prefill from it. */
  onForm?: (f: MobileForm) => void;
}

export function MobileCheckout({ state, update, plan, sum, promo, brand, contact, paymentMode, onTalk, onQuote, onForm }: MobileCheckoutProps) {
  const intent = state.intent ?? "new";
  const [form, setFormState] = React.useState<MobileForm>(EMPTY_FORM);
  const [loaded, setLoaded] = React.useState(false);
  const [domainTried, setDomainTried] = React.useState(false);
  const [detailsTried, setDetailsTried] = React.useState(false);
  const [optIn, setOptIn] = React.useState(false);
  const [resume, setResume] = React.useState(false);
  const [agree, setAgree] = React.useState(false);
  const [agreeErr, setAgreeErr] = React.useState<string | null>(null);
  const [payErr, setPayErr] = React.useState<string | null>(null);
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const [order, setOrder] = React.useState<ServerOrder | null>(null);
  const tsDraft = useTurnstile();
  const tsPay = useTurnstile();

  /* This phone's copy comes back after the first paint (the server never has it). */
  React.useEffect(() => { setFormState(loadForm()); setLoaded(true); }, []);
  React.useEffect(() => { if (loaded) { saveForm(form); onForm?.(form); } }, [form, loaded, onForm]);
  /* A refresh (or a deep link) on a later step with something missing → the step that needs it. */
  React.useEffect(() => {
    if (!loaded || !state.intent) return;
    const need = firstIncompleteStep(form, state.intent);
    const at = checkoutStepNumber(state.step);
    if (need && checkoutStepNumber(need) < at) update({ step: need });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the step or the stored form arrives
  }, [loaded, state.step]);
  /* No answer to "What do you need?" yet → back to Plans, where it is asked. */
  React.useEffect(() => {
    if (!state.intent) update({ step: "plans" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on the intent only
  }, [state.intent]);

  const setForm = React.useCallback((patch: Partial<MobileForm>) => setFormState((f) => ({ ...f, ...patch })), []);

  // ── Money: one set of numbers for the summary, the bar, Review and the Pay button ──
  const [couponOpen, setCouponOpen] = React.useState(false);
  const [couponInput, setCouponInput] = React.useState("");
  const [coupon, setCoupon] = React.useState<AppliedCoupon | null>(null);
  const [couponErr, setCouponErr] = React.useState<string | null>(null);
  const [couponBusy, setCouponBusy] = React.useState(false);
  const promoOff = promo?.off ?? 0;
  const afterPromo = Math.max(0, sum.subtotal - Math.min(promoOff, sum.subtotal));
  const mode = fitMode(form, intent);
  const canPay = paymentMode !== "disabled";
  /* R-1977 / R-1985: a new domain picked from the live search goes in the same payment. */
  const domainPick = mode === "new" && canPay ? form.newDomain.picked : null;
  const totals = orderTotals(sum.subtotal, promoOff, coupon?.discount ?? 0, domainPick?.price ?? 0, state.billing === "monthly");
  const price: PriceLines = {
    planName: plan.short, seats: state.seats, billing: state.billing, rate: sum.rate, subtotal: sum.subtotal,
    promo: promo && promo.off > 0 ? { label: promo.label, off: Math.min(promo.off, sum.subtotal) } : null,
    coupon: coupon ? { code: coupon.code, off: totals.coupon } : null,
    domain: domainPick ? { name: domainPick.domain, price: domainPick.price } : null,
    gst: totals.gst, total: totals.total,
  };

  /* The coupon is checked again when the bill changes (the server checks it once more anyway). */
  const seq = React.useRef(0);
  React.useEffect(() => {
    if (!coupon) return;
    const mine = ++seq.current;
    void recheckCoupon(coupon, { code: coupon.code, tier: plan.id, seats: state.seats, gross_amount: afterPromo }).then((next) => {
      if (mine !== seq.current) return;
      setCoupon(next.applied);
      setCouponErr(next.error);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the bill, not the coupon object
  }, [plan.id, state.seats, afterPromo]);
  async function applyCoupon() {
    const code = couponInput.trim().toUpperCase();
    if (code.length < 2) { setCouponErr("Enter a code first"); return; }
    seq.current++;
    setCouponBusy(true); setCouponErr(null);
    try {
      const r = await checkCoupon({ code, tier: plan.id, seats: state.seats, gross_amount: afterPromo });
      if (r.ok) setCoupon(r.coupon); else { setCoupon(null); setCouponErr(r.message); }
    } catch {
      setCouponErr("Network error — try again");
    } finally {
      setCouponBusy(false);
    }
  }

  // ── Steps ──
  const domainErrs = domainTried ? domainStepErrors(form, intent) : {};
  const needAddr = needsAddress(form, intent);
  const detailErrs = detailsTried ? detailsErrors(form, needAddr) : {};
  const go = (step: CheckoutStep | "plans") => { setPayErr(null); update({ step }); };
  const back = () => go(state.step === "domain" ? "plans" : state.step === "details" ? "domain" : "details");

  function fromDomain() {
    setDomainTried(true);
    const e = domainStepErrors(form, intent);
    if (Object.keys(e).length) { focusFirst(["m-domain", "buy-newdomain"]); return; }
    setDomainTried(false);
    go("details");
  }

  function fromDetails() {
    setDetailsTried(true);
    const e = detailsErrors(form, needAddr);
    if (Object.keys(e).length) { focusFirst(Object.keys(e).map((k) => `m-${k}`)); return; }
    setDetailsTried(false);
    if (resume) void sendDraft();
    go("review");
  }

  /** The draft lead — ONLY with the WhatsApp box ticked; once per visit. */
  async function sendDraft() {
    if (!resume) return;
    try { if (window.sessionStorage.getItem(DRAFT_SENT_KEY)) return; } catch { /* no session storage: send once now */ }
    const r = await postJson<{ leadId: string }>("/api/public/enquiry/workspace/draft", {
      resumeConsent: true, fullName: form.name.trim(), phone: `+91${mobileDigits(form.phone)}`, email: form.email.trim(),
      companyName: form.company.trim() || undefined, seats: state.seats, tierId: plan.id, billing: state.billing,
      domain: orderDomain(form, intent) || undefined, intent, domainMode: mode,
      migrationSource: mode === "have" || mode === "later" ? form.migrationSource : undefined, ...landingForForm(),
    }, tsDraft.headers);
    tsDraft.reset();
    if (r.reached && r.ok) { try { window.sessionStorage.setItem(DRAFT_SENT_KEY, r.json.leadId ?? "1"); } catch { /* fine */ } }
  }

  async function openPay(o: ServerOrder) {
    setPhase({ kind: "paying" });
    const ok = await openRazorpay(o, {
      sellerName: brand?.name ?? "Google Workspace",
      buyer: { name: form.name.trim(), email: form.email.trim(), phone: `+91${mobileDigits(form.phone)}` },
      planName: plan.name, billing: state.billing, domain: orderDomain(form, intent),
    }, {
      onPaid: () => { trackFunnel("payment_success", { tier: plan.id, seats: state.seats, billing: state.billing }); clearForm(); setPhase({ kind: "confirming" }); },
      onFailed: (reason) => { trackFunnel("payment_failed", { tier: plan.id, seats: state.seats, billing: state.billing }); setPhase({ kind: "failed", reason, dismissed: false }); },
      onDismiss: () => setPhase((p) => (p.kind === "failed" || p.kind === "confirming" ? p : { kind: "failed", reason: "", dismissed: true })),
    });
    if (!ok) setPhase({ kind: "failed", reason: "the payment window did not load", dismissed: false });
  }

  async function pay() {
    if (phase.kind !== "idle") return;
    setPayErr(null);
    if (!agree) { setAgreeErr(BUY_TERMS_ERROR); return; }
    if (tsPay.required && !tsPay.ready) { setAgreeErr("Wait for the security check above to finish, then press again."); return; }
    const missing = firstIncompleteStep(form, intent);
    if (missing) { go(missing); return; }
    const body = mobileCheckoutBody({ plan, seats: state.seats, billing: state.billing, intent, form, couponCode: coupon?.code ?? null, simulate: paymentMode === "simulation" });
    setPhase({ kind: "starting" });
    const r = await startOrder(body, tsPay.headers, optIn);
    tsPay.reset();
    if (r.kind === "not-reached" || r.kind === "error") { setPhase({ kind: "idle" }); setPayErr(r.message); return; }
    if (r.kind === "simulated") {
      trackFunnel("payment_success", { tier: plan.id, seats: state.seats, billing: state.billing });
      clearForm();
      setPhase({ kind: "confirming" });
      window.location.href = r.url;
      return;
    }
    setOrder(r.order);
    if (serverAmountDiffers(r.order, totals.total)) {
      setPhase({ kind: "price-changed", serverRupees: r.order.amountPaise / 100, shownRupees: totals.total });
      return;
    }
    await openPay(r.order);
  }

  const n = checkoutStepNumber(state.step) as 1 | 2 | 3;
  const waHref = contact.whatsapp ? whatsappHref(contact.whatsapp, `Hi, about my Google Workspace order ${order?.quoteId ?? ""}.`) : null;

  if (phase.kind !== "idle") {
    return (
      <ResultScreen phase={phase} serverRupees={order ? order.amountPaise / 100 : null} orderId={order?.quoteId ?? null} waHref={waHref}
        onTryAgain={() => { if (order) void openPay(order); }}
        onPayAnotherWay={() => { if (order) void openPay(order); }}
        onTalk={onTalk}
        onBackToReview={() => setPhase({ kind: "idle" })} />
    );
  }

  const domainShown = mode === "later" ? "Decide later — on the setup call"
    : mode === "new" ? `${form.newDomain.picked?.domain ?? ""} (new — we register it)`
    : mode === "google" ? `${orderDomain(form, intent)} (already on Google Workspace)` : orderDomain(form, intent);
  const st = buyerState(form);
  const rows: ReviewRow[] = [
    { label: "Plan", value: planRow(plan.short, state.seats, state.billing === "annual"), step: "plans" },
    { label: "Email address", value: domainShown, step: "domain" },
    { label: "Your details", value: `${form.name.trim()} · +91 ${mobileDigits(form.phone)} · ${form.email.trim()}`, step: "details" },
    { label: "GST invoice", value: form.needGst ? `${form.company.trim()} · GSTIN ${form.gstin}` : `No GSTIN${st ? ` · ${stateName(st) ?? st}` : ""}`, step: "details" },
  ];

  const payLabel = paymentMode === "simulation" ? `Place test order · ${rupee(totals.total)}` : `Pay ${rupee(totals.total)} securely`;

  return (
    <div>
      <div className="sticky top-0 z-20">
        <CheckoutHeader n={n} onBack={back} onTalk={onTalk} />
        <PriceSummary p={price} />
      </div>
      <div className="px-4 pt-4">
        {!loaded ? (
          <p role="status" className="text-sm text-ink-2">Loading your order…</p>
        ) : state.step === "domain" ? (
          <DomainStep intent={intent} form={form} setForm={setForm} errors={domainErrs} seats={state.seats} billsWithOrder={canPay} />
        ) : state.step === "details" ? (
          <DetailsStep form={form} setForm={setForm} errors={detailErrs} summary={errorSummary(detailErrs)} needAddress={needAddr}
            optIn={optIn} onOptIn={setOptIn} resume={resume} onResume={setResume} turnstile={tsDraft.widget} />
        ) : (
          <>
            <ReviewStep rows={rows} price={price} brand={brand} agree={agree} onAgree={(v) => { setAgree(v); setAgreeErr(null); }} agreeErr={agreeErr}
              onChange={(s) => go(s)} onSampleInvoice={() => undefined}
              coupon={{ open: couponOpen, setOpen: setCouponOpen, input: couponInput, setInput: setCouponInput, applied: coupon, error: couponErr, busy: couponBusy, apply: () => void applyCoupon(), remove: () => { seq.current++; setCoupon(null); setCouponInput(""); setCouponErr(null); } }} />
            {canPay && tsPay.widget}
          </>
        )}
      </div>
      <StepBar total={totals.total}>
        {payErr && <p role="alert" className="text-sm text-rose-ink m-0">{payErr}</p>}
        {state.step === "review" ? (
          canPay ? (
            <>
              <button type="button" onClick={() => void pay()} className={primaryBtn}>{payLabel}</button>
              <span className="text-xs text-ink-3 text-center">Secure payment via Razorpay. We never see your card or UPI PIN.</span>
            </>
          ) : (
            <>
              <span className="text-sm text-ink-2 text-center">Online payment opens soon — we&apos;ll call you with a GST quote.</span>
              <button type="button" onClick={onQuote} className={primaryBtn}>Get a GST quote</button>
            </>
          )
        ) : (
          <button type="button" onClick={state.step === "domain" ? fromDomain : fromDetails} disabled={!loaded} className={primaryBtn}>Continue</button>
        )}
      </StepBar>
    </div>
  );
}

function focusFirst(ids: string[]): void {
  window.setTimeout(() => {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) { el.focus(); el.scrollIntoView?.({ block: "center" }); return; }
    }
  }, 0);
}
