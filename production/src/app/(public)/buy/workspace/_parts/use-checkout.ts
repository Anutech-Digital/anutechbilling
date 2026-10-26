"use client";
/**
 * R-1971: the inline checkout's state — the three steps, the buyer's details, the coupon and the
 * order sums. The hero card, plan cards, order summary, invoice preview and the phone bar all
 * read this ONE state, so a number shown anywhere is the number the server will charge.
 */
import * as React from "react";
import { checkCoupon, recheckCoupon, type AppliedCoupon } from "../coupon-check";
import {
  EMPTY_BUYER, EMPTY_DOMAIN, buyerErrors, buyerStateCode, domainCharge, domainErrors, orderTotals,
  type BuyerDetails, type BuyerField, type CheckoutMode, type DomainChoice, type PayMethod,
} from "./checkout-form";
import type { Billing, PlanSum } from "./plans";

export type Step = 1 | 2 | 3;
export type FieldErrors = Partial<Record<BuyerField | "domain" | "newName" | "agree", string>>;

export function useCheckout({ planId, seats, sum, promoOff, billing = "annual", canBuy = true }: { planId: string; seats: number; sum: PlanSum | null; promoOff: number; billing?: Billing; canBuy?: boolean }) {
  const [step, setStep] = React.useState<Step>(1);
  const [mode, setMode] = React.useState<CheckoutMode>("pay");
  const [domain, setDomain] = React.useState<DomainChoice>(EMPTY_DOMAIN);
  const [buyer, setBuyer] = React.useState<BuyerDetails>(EMPTY_BUYER);
  const [method, setMethod] = React.useState<PayMethod>("upi");
  const [agree, setAgree] = React.useState(false);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [busy, setBusy] = React.useState(false);

  // Coupon (R-1630): re-checked when plan or users change; the server re-validates anyway.
  const [couponInput, setCouponInput] = React.useState("");
  const [coupon, setCoupon] = React.useState<AppliedCoupon | null>(null);
  const [couponError, setCouponError] = React.useState<string | null>(null);
  const [couponBusy, setCouponBusy] = React.useState(false);
  const afterPromo = sum ? Math.max(0, sum.subtotal - Math.min(promoOff, sum.subtotal)) : 0;
  /* R-1977: a new domain bought with an annual order adds its (shown) live price; the server prices it again. */
  const domainPrice = domainCharge(domain, billing, mode, canBuy);
  const buysDomain = canBuy && domain.mode === "new" && billing === "annual" && mode === "pay";
  const totals = sum ? orderTotals(sum.subtotal, promoOff, coupon?.discount ?? 0, domainPrice) : null;

  const seq = React.useRef(0);
  React.useEffect(() => {
    if (!coupon) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setCouponBusy(true);
      const next = await recheckCoupon(coupon, { code: coupon.code, tier: planId, seats, gross_amount: afterPromo });
      if (mine !== seq.current) return;
      setCoupon(next.applied);
      setCouponError(next.error);
      if (!next.applied) setCouponInput(coupon.code);
      setCouponBusy(false);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-check on plan / users / bill size only
  }, [planId, seats, afterPromo]);

  async function applyCoupon(codeIn?: string) {
    if (couponBusy) return; // a check is already running — the button says "Checking…"
    const code = (typeof codeIn === "string" ? codeIn : couponInput).trim().toUpperCase();
    if (code.length < 2) { setCouponError("Enter a code first"); return; }
    seq.current++;
    setCouponBusy(true);
    setCouponError(null);
    try {
      const r = await checkCoupon({ code, tier: planId, seats, gross_amount: afterPromo });
      if (!r.ok) { setCoupon(null); setCouponError(r.message); return; }
      setCoupon(r.coupon);
    } catch {
      setCouponError("Network error — try again");
    } finally {
      setCouponBusy(false);
    }
  }
  function removeCoupon() {
    seq.current++;
    setCouponBusy(false);
    setCoupon(null);
    setCouponInput("");
    setCouponError(null);
  }

  function setField(k: BuyerField, v: string) {
    setBuyer((b) => ({ ...b, [k]: v }));
    setErrors((e) => { const n = { ...e }; delete n[k]; return n; });
  }
  function next1(): boolean {
    const e = domainErrors(domain, buysDomain);
    setErrors(e);
    if (Object.keys(e).length) return false;
    setStep(2);
    return true;
  }
  function next2(): boolean {
    const e = buyerErrors(buyer, buysDomain);
    setErrors(e);
    if (Object.keys(e).length) return false;
    setStep(3);
    return true;
  }

  return {
    step, setStep, mode, setMode, domain, setDomain, buyer, setField, method, setMethod,
    agree, setAgree, errors, setErrors, busy, setBusy, next1, next2,
    buyerState: buyerStateCode(buyer),
    buysDomain,
    coupon, couponInput, setCouponInput, couponError, couponBusy, applyCoupon, removeCoupon,
    totals,
  };
}

export type CheckoutState = ReturnType<typeof useCheckout>;
