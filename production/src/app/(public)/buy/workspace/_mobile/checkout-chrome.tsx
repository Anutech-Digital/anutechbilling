"use client";
/**
 * R-2021 (R-2019 decision 9): what every phone checkout screen carries — a back arrow, "Step n of
 * 3", a three-part progress bar, "Talk to us" (opens the Help sheet), and a collapsible price
 * summary whose numbers are the ones the Review screen and the Pay button show.
 */
import * as React from "react";
import { rupee } from "@/lib/utils";
import type { Billing } from "../_parts/plans";
import { licences } from "./plans-step";

export const STEP_TITLES = ["Email address", "Your details", "Review & pay"] as const;

export function CheckoutHeader({ n, onBack, onTalk }: { n: 1 | 2 | 3; onBack: () => void; onTalk: () => void }) {
  const title = `Step ${n} of 3 · ${STEP_TITLES[n - 1]}`;
  return (
    <div className="bg-paper border-b border-hairline">
      <div className="flex items-center gap-2 px-2 pt-2">
        <button type="button" aria-label="Back" onClick={onBack}
          className="w-11 h-11 shrink-0 text-[22px] text-ink rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">←</button>
        <h1 data-testid="step-title" className="flex-1 min-w-0 font-bold text-[15px] m-0 truncate">{title}</h1>
        <button type="button" onClick={onTalk}
          className="h-11 px-3.5 border border-hairline rounded-full bg-white whitespace-nowrap shrink-0 text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">
          Talk to us
        </button>
      </div>
      <div role="progressbar" aria-label="Checkout progress" aria-valuemin={1} aria-valuemax={3} aria-valuenow={n} aria-valuetext={title}
        className="grid grid-cols-3 gap-1.5 px-4 pt-1.5 pb-3">
        {[1, 2, 3].map((i) => <span key={i} className={`h-1 rounded-full ${i <= n ? "bg-amber" : "bg-hairline"}`} />)}
      </div>
    </div>
  );
}

/** The money lines — every one read from the order totals (orderTotals, the server's maths). */
export interface PriceLines {
  planName: string;
  seats: number;
  billing: Billing;
  /** per licence, per month (catalogue) */
  rate: number;
  subtotal: number;
  promo: { label: string; off: number } | null;
  coupon: { code: string; off: number } | null;
  domain: { name: string; price: number } | null;
  gst: number;
  total: number;
}

export function PriceBreakdown({ p }: { p: PriceLines }) {
  const annual = p.billing === "annual";
  const row = "flex justify-between gap-3 text-sm";
  return (
    <dl className="flex flex-col gap-1.5 m-0">
      <div className={row}><dt className="text-ink-2">{rupee(p.rate)} × {licences(p.seats)}{annual ? " × 12 months" : " · 1 month"}</dt><dd className="m-0">{rupee(p.subtotal)}</dd></div>
      {p.promo && p.promo.off > 0 && <div className={row}><dt className="text-emerald-ink">{p.promo.label}</dt><dd className="m-0 text-emerald-ink">− {rupee(p.promo.off)}</dd></div>}
      {p.coupon && p.coupon.off > 0 && <div className={row}><dt className="text-emerald-ink">Coupon {p.coupon.code}</dt><dd className="m-0 text-emerald-ink">− {rupee(p.coupon.off)}</dd></div>}
      {p.domain && <div className={row}><dt className="text-ink-2">Domain {p.domain.name} · 1 year</dt><dd className="m-0">{rupee(p.domain.price)}</dd></div>}
      <div className={row}><dt className="text-ink-2">GST 18%</dt><dd className="m-0">{rupee(p.gst)}</dd></div>
      <div className="flex justify-between gap-3 text-base font-bold border-t border-hairline pt-2 mt-0.5">
        <dt>You pay today</dt><dd data-testid="breakdown-total" className="m-0">{rupee(p.total)}</dd>
      </div>
    </dl>
  );
}

export function PriceSummary({ p }: { p: PriceLines }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="bg-white border-b border-hairline">
      <button type="button" aria-expanded={open} aria-controls="m-price-summary" onClick={() => setOpen((o) => !o)}
        className="w-full min-h-12 px-4 py-2.5 flex justify-between items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">
        <span className="text-sm text-ink-2 min-w-0 truncate">{p.planName} · {licences(p.seats)} · {p.billing === "annual" ? "Yearly" : "Monthly"}</span>
        <span className="flex items-center gap-1.5 shrink-0">
          <span data-testid="summary-total" className="font-bold text-base">{rupee(p.total)}</span>
          <span aria-hidden className="text-ink-3">{open ? "▴" : "▾"}</span>
          <span className="sr-only">{open ? "Hide price details" : "Show price details"}</span>
        </span>
      </button>
      {open && <div id="m-price-summary" className="px-4 pb-3"><PriceBreakdown p={p} /></div>}
    </div>
  );
}

export const inputCls = (bad?: string | boolean) =>
  `w-full h-12 px-3.5 text-base border-[1.5px] rounded-[10px] bg-white text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-amber ${bad ? "border-rose" : "border-hairline-strong"}`;
export const primaryBtn = "w-full h-[54px] rounded-xl bg-amber text-white text-[17px] font-bold disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2";
export const choiceCls = (on: boolean) =>
  `text-left rounded-xl border-[1.5px] p-3.5 flex gap-3 items-start text-ink w-full ${on ? "bg-amber-soft border-amber" : "bg-white border-hairline"} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber`;

export function Dot({ on }: { on: boolean }) {
  return <span aria-hidden className={`w-[22px] h-[22px] rounded-full border-[1.5px] shrink-0 mt-0.5 shadow-[inset_0_0_0_5px_#fff] ${on ? "border-amber bg-amber" : "border-hairline-strong bg-white"}`} />;
}

/** The sticky bottom bar of a checkout step: the total and the step's one button. */
export function StepBar({ total, children }: { total: number | null; children: React.ReactNode }) {
  return (
    <div data-m-bar className="fixed inset-x-0 bottom-0 z-30 bg-white border-t border-hairline shadow-[0_-12px_24px_-16px_rgba(26,24,21,0.3)]">
      <div className="max-w-[480px] mx-auto px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] flex flex-col gap-2">
        {total != null && (
          <div className="flex justify-between items-baseline gap-2.5 text-sm text-ink-2">
            <span>Total incl. GST</span><span data-testid="bar-total" className="font-bold text-lg text-ink">{rupee(total)}</span>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
