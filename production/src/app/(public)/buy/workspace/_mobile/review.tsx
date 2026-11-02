"use client";
/**
 * R-2021 (R-2019b): Step 3 · Review & pay — rows with Change links, the price breakdown, the
 * renewal note, a coupon behind a link (/api/public/coupons/validate), "You're buying from" (the
 * website tenant: name, GSTIN, address, state — read from its row, never typed), "Is it safe to
 * pay?", the terms tick (R-226) and Pay. And the screens after Pay: Processing, the server's
 * price when it differs from the one shown, and Failed (the order is kept: Try again / Pay
 * another way / Talk to us).
 */
import * as React from "react";
import { rupee } from "@/lib/utils";
import { PARTNER_LINE } from "@/site/lib/config";
import { BUY_ANNUAL_NOTE, BUY_MONTHLY_NOTE, BUY_TERMS_ERROR } from "../buy-notes";
import { stateName, type BuyBrand } from "../_parts/brand";
import { PriceBreakdown, primaryBtn, type PriceLines } from "./checkout-chrome";
import { licences } from "./plans-step";
import { SHOW_SAMPLE_INVOICE } from "./flags";

export { BUY_TERMS_ERROR };

export interface ReviewRow { label: string; value: string; step: "plans" | "domain" | "details" }

export interface CouponUi {
  open: boolean; setOpen: (v: boolean) => void;
  input: string; setInput: (v: string) => void;
  applied: { code: string; discount: number } | null;
  error: string | null; busy: boolean;
  apply: () => void; remove: () => void;
}

export function ReviewStep({ rows, price, brand, coupon, agree, onAgree, agreeErr, onChange, onSampleInvoice }: {
  rows: ReviewRow[]; price: PriceLines; brand: BuyBrand | null; coupon: CouponUi;
  agree: boolean; onAgree: (v: boolean) => void; agreeErr: string | null;
  onChange: (step: ReviewRow["step"]) => void; onSampleInvoice: () => void;
}) {
  const sellerState = stateName(brand?.stateCode ?? null);
  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-serif font-normal text-[26px] leading-tight m-0">Check everything once</h2>
      <dl className="bg-white border border-hairline rounded-[14px] m-0 divide-y divide-hairline">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start gap-3 px-3.5 py-2.5">
            <div className="flex-1 min-w-0">
              <dt className="text-sm text-ink-3">{r.label}</dt>
              <dd className="m-0 text-[15px] text-ink break-words">{r.value}</dd>
            </div>
            <button type="button" onClick={() => onChange(r.step)} className="min-h-11 px-2 text-sm font-semibold text-amber-ink underline underline-offset-[3px] shrink-0">
              Change<span className="sr-only"> {r.label}</span>
            </button>
          </div>
        ))}
      </dl>

      <section aria-label="Price" className="bg-white border border-hairline rounded-[14px] p-3.5 flex flex-col gap-2.5">
        <PriceBreakdown p={price} />
        <p className="text-sm text-ink-2 m-0">{price.billing === "annual" ? BUY_ANNUAL_NOTE : BUY_MONTHLY_NOTE}</p>
        {coupon.applied ? (
          <p className="text-sm m-0 flex justify-between items-center gap-2">
            <span className="text-emerald-ink">✓ Coupon {coupon.applied.code} applied</span>
            <button type="button" onClick={coupon.remove} className="min-h-11 px-2 text-sm font-semibold text-amber-ink underline underline-offset-[3px]">Remove</button>
          </p>
        ) : !coupon.open ? (
          <button type="button" onClick={() => coupon.setOpen(true)} className="self-start min-h-11 text-sm font-semibold text-amber-ink underline underline-offset-[3px]">Have a coupon code?</button>
        ) : (
          <div className="flex flex-col gap-1">
            <label htmlFor="m-coupon" className="text-sm font-semibold text-ink-2">Coupon code</label>
            <div className="flex gap-2">
              <input id="m-coupon" value={coupon.input} onChange={(e) => coupon.setInput(e.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="off" spellCheck={false}
                aria-invalid={!!coupon.error} aria-describedby="m-coupon-msg"
                className="flex-1 min-w-0 h-12 px-3.5 text-base border-[1.5px] border-hairline-strong rounded-[10px] bg-white font-mono uppercase focus:outline-none focus-visible:ring-2 focus-visible:ring-amber" />
              <button type="button" onClick={coupon.apply} disabled={coupon.busy} className="h-12 px-4 rounded-[10px] bg-ink text-paper text-[15px] font-semibold disabled:opacity-60">
                {coupon.busy ? "Checking…" : "Apply"}
              </button>
            </div>
            <div id="m-coupon-msg" className="text-sm text-rose-ink min-h-5">{coupon.error ?? ""}</div>
          </div>
        )}
      </section>

      <section aria-labelledby="m-seller" className="bg-white border border-hairline rounded-[14px] p-3.5 flex flex-col gap-1">
        <h3 id="m-seller" className="text-sm text-ink-3 font-normal m-0">You&apos;re buying from</h3>
        <p className="font-bold text-[15px] m-0">{brand?.name ?? "Our company"}</p>
        <p className="text-sm text-ink-2 m-0">{PARTNER_LINE}</p>
        {brand?.gstin && <p className="text-sm text-ink-2 m-0">GSTIN {brand.gstin}</p>}
        {brand?.address && <p className="text-sm text-ink-2 m-0">{brand.address}</p>}
        {sellerState && <p className="text-sm text-ink-2 m-0">GST: CGST + SGST if you are in {sellerState}, IGST from any other state.</p>}
        {SHOW_SAMPLE_INVOICE && (
          <button type="button" onClick={onSampleInvoice} className="self-start min-h-11 text-sm font-semibold text-amber-ink underline underline-offset-[3px]">See what your invoice will look like</button>
        )}
      </section>

      <section aria-labelledby="m-safe" className="bg-paper-2 border border-hairline rounded-[14px] p-3.5 flex flex-col gap-1.5">
        <h3 id="m-safe" className="font-bold text-[15px] m-0">Is it safe to pay?</h3>
        <p className="text-sm m-0 flex gap-2"><span aria-hidden className="text-emerald-ink font-bold">✓</span>Payment happens on Razorpay. We never see your card details or UPI PIN.</p>
        <p className="text-sm m-0 flex gap-2"><span aria-hidden className="text-emerald-ink font-bold">✓</span>UPI, debit/credit card or NetBanking</p>
        <p className="text-sm m-0 flex gap-2">
          <span aria-hidden className="text-emerald-ink font-bold">✓</span>
          <span>Your payment screen will show <b>{brand?.name ?? "our company name"}</b>. Read our <a href="/refund" target="_blank" rel="noopener noreferrer" className="text-amber-ink underline underline-offset-[3px]">Refund policy</a>.</span>
        </p>
      </section>

      <div>
        <label htmlFor="m-agree" className="flex gap-2.5 items-start text-sm text-ink-2 cursor-pointer min-h-11">
          <input id="m-agree" type="checkbox" checked={agree} onChange={(e) => onAgree(e.target.checked)} aria-describedby="m-agree-msg"
            className="w-5 h-5 mt-0.5 shrink-0 accent-[hsl(var(--amber))]" />
          <span>I agree to the <a href="/terms-and-conditions" target="_blank" rel="noopener noreferrer" className="text-amber-ink underline underline-offset-[3px]">Terms</a>, the <a href="/refund" target="_blank" rel="noopener noreferrer" className="text-amber-ink underline underline-offset-[3px]">Refund policy</a> and the <a href="https://workspace.google.com/terms/" target="_blank" rel="noopener noreferrer" className="text-amber-ink underline underline-offset-[3px]">Google Workspace terms</a>.</span>
        </label>
        <div id="m-agree-msg" role={agreeErr ? "alert" : undefined} className="text-sm text-rose-ink min-h-5">{agreeErr ?? ""}</div>
      </div>
    </div>
  );
}

export type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "price-changed"; serverRupees: number; shownRupees: number }
  | { kind: "paying" }
  | { kind: "confirming" }
  | { kind: "failed"; reason: string; dismissed: boolean };

/** Processing / price changed / Failed — full screen, one decision each. */
export function ResultScreen({ phase, serverRupees, orderId, onTryAgain, onPayAnotherWay, onTalk, onBackToReview, waHref }: {
  phase: Phase; serverRupees: number | null; orderId: string | null;
  onTryAgain: () => void; onPayAnotherWay: () => void; onTalk: () => void; onBackToReview: () => void; waHref: string | null;
}) {
  if (phase.kind === "starting" || phase.kind === "paying" || phase.kind === "confirming") {
    return (
      <div role="status" aria-live="polite" className="min-h-[60vh] px-6 flex flex-col items-center justify-center text-center gap-3">
        <span aria-hidden className="w-12 h-12 rounded-full border-4 border-hairline border-t-amber animate-spin motion-reduce:animate-none" />
        <h1 className="font-serif font-normal text-[26px] m-0">{phase.kind === "confirming" ? "Confirming your payment" : "Opening secure payment"}</h1>
        <p className="text-[15px] text-ink-2 m-0">This takes a few seconds. Please keep this screen open.</p>
      </div>
    );
  }
  if (phase.kind === "price-changed") {
    return (
      <div role="alert" className="px-4 py-8 flex flex-col gap-3">
        <h1 className="font-serif font-normal text-[26px] m-0">The price for your order is {rupee(phase.serverRupees)}</h1>
        <p className="text-[15px] text-ink-2 m-0">
          The page showed {rupee(phase.shownRupees)}, but our price list says {rupee(phase.serverRupees)} incl. GST right now. Nothing has been charged.
        </p>
        <button type="button" onClick={onTryAgain} className={primaryBtn}>Pay {rupee(phase.serverRupees)} securely</button>
        <button type="button" onClick={onBackToReview} className="h-12 rounded-xl border-[1.5px] border-hairline-strong bg-white text-ink text-[15px] font-bold">Back to review</button>
        <button type="button" onClick={onTalk} className="min-h-11 text-sm font-semibold text-amber-ink underline underline-offset-[3px]">Talk to us</button>
      </div>
    );
  }
  if (phase.kind === "failed") {
    return (
      <div role="alert" className="px-4 py-8 flex flex-col gap-3">
        <span aria-hidden className="w-12 h-12 rounded-full bg-rose-soft text-rose-ink grid place-items-center text-2xl font-bold">!</span>
        <h1 className="font-serif font-normal text-[26px] m-0">{phase.dismissed ? "Payment not finished" : "The payment didn't go through"}</h1>
        <p className="text-[15px] text-ink-2 m-0">
          {phase.dismissed ? "The payment window was closed. " : `This happens sometimes with bank or UPI timeouts${phase.reason ? ` (${phase.reason})` : ""}. `}
          Your order is <b>saved</b>, so you won&apos;t need to fill anything again.
        </p>
        {orderId && (
          <p className="text-sm text-ink-2 m-0">
            If money left your account, {waHref ? <a href={waHref} target="_blank" rel="noopener noreferrer" className="text-amber-ink underline underline-offset-[3px]">WhatsApp us</a> : "contact us"} with order <b>{orderId}</b> and we&apos;ll sort it out the same day.
          </p>
        )}
        <button type="button" onClick={onTryAgain} className={primaryBtn}>Try again{serverRupees != null ? ` · ${rupee(serverRupees)}` : ""}</button>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onPayAnotherWay} className="h-12 rounded-xl border-[1.5px] border-hairline-strong bg-white text-ink text-[15px] font-bold">Pay another way</button>
          <button type="button" onClick={onTalk} className="h-12 rounded-xl border-[1.5px] border-hairline-strong bg-white text-ink text-[15px] font-bold">Talk to us</button>
        </div>
      </div>
    );
  }
  return null;
}

/** "Standard · 10 licences · Yearly" — the plan row of Review. */
export function planRow(planName: string, seats: number, annual: boolean): string {
  return `${planName} · ${licences(seats)} · ${annual ? "Yearly" : "Monthly"}`;
}
