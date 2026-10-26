"use client";
/**
 * R-1970: hero (headline, the two calls to action, what every plan includes) and the "Your
 * price" card — plan, users, Annual/Monthly and the live total. The card reads the SAME state as
 * the plan cards and the checkout, so a number shown here is the number charged there.
 */
import { CONTACT_FOR_PRICING } from "@/lib/catalog/public-price-policy";
import { WORKSPACE_TRIAL_DAYS } from "@/lib/trials/trial-days";
import { SLA } from "@/site/lib/config";
import { rupee } from "@/lib/utils";
import { priceHeadline } from "../price-headline";
import { BUSINESS_MAX_USERS, SEAT_PRESETS, clampSeats, type Billing, type BuyPlan, type PlanSum } from "./plans";
import { ChaiCup, GoogleWorkspaceWordmark } from "./wordmark";

/** Self-hosted app icons (public/), not a third-party host. */
const APPS: ReadonlyArray<{ name: string; src: string }> = [
  { name: "Gmail", src: "/ic-gmail.png" },
  { name: "Drive", src: "/ic-drive.png" },
  { name: "Meet", src: "/ic-meet.png" },
  { name: "Calendar", src: "/ic-calendar.png" },
  { name: "Gemini", src: "/ic-gemini.png" },
];

const CHECKS = ["GST tax invoice, ITC-ready", "UPI, cards and netbanking", "Domain + DNS setup included", "Hindi + English phone support"];

export interface PriceCardProps {
  plans: BuyPlan[];
  plan: BuyPlan;
  onPick: (id: BuyPlan["id"]) => void;
  seats: number;
  onSeats: (n: number) => void;
  billing: Billing;
  onBilling: (b: Billing) => void;
  monthlyOk: boolean;
  savePct: number;
  sum: PlanSum | null;
  /** A site promo (Online Promos) on this order: the pre-GST figures after it. */
  promo: { label: string; subtotal: number; gst: number; total: number; was: number } | null;
  onContinue: () => void;
  onQuote: () => void;
}

const seg = (on: boolean) =>
  `rounded-[7px] text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber ${
    on ? "bg-white text-ink shadow-sm" : "bg-transparent text-ink-3 hover:text-ink"
  }`;

export function BillingToggle({ billing, onBilling, savePct, compact }: { billing: Billing; onBilling: (b: Billing) => void; savePct: number; compact?: boolean }) {
  return (
    <div className={`flex gap-1 p-1 bg-paper-2 rounded-[10px] ${compact ? "" : "w-full"}`} role="group" aria-label="Billing">
      <button type="button" aria-pressed={billing === "annual"} onClick={() => onBilling("annual")} className={`${seg(billing === "annual")} h-10 px-4 ${compact ? "" : "flex-1"}`}>
        Annual{savePct > 0 && <span className="ml-1 text-[11px] text-emerald">· save {savePct}%</span>}
      </button>
      <button type="button" aria-pressed={billing === "monthly"} onClick={() => onBilling("monthly")} className={`${seg(billing === "monthly")} h-10 px-4 ${compact ? "" : "flex-1"}`}>
        Monthly
      </button>
    </div>
  );
}

export function PriceCard(p: PriceCardProps) {
  const overCap = !p.plan.custom && p.seats > BUSINESS_MAX_USERS;
  const shown = p.promo ?? p.sum;
  const head = p.sum && shown ? priceHeadline({
    rate: p.sum.rate, seats: p.seats, billing: p.billing,
    subtotal: shown.subtotal, gst: shown.gst, total: shown.total,
    wasSubtotal: p.promo?.was,
  }) : null;
  return (
    <div className="flex-[1_1_360px] max-w-[460px] min-w-0 bg-white border border-hairline rounded-2xl p-6 shadow-[0_24px_48px_-24px_rgba(26,24,21,0.18)]">
      <div className="flex justify-between items-baseline mb-4">
        <h2 className="font-serif text-[22px] font-normal m-0">Your price</h2>
        <span className="text-xs text-ink-3">Live estimate</span>
      </div>
      <p id="hero-plan-label" className="text-xs font-semibold text-ink-2 mb-2">Plan</p>
      <div role="group" aria-labelledby="hero-plan-label" className="grid gap-1 p-1 bg-paper-2 rounded-[10px] mb-[18px]" style={{ gridTemplateColumns: `repeat(${p.plans.length}, minmax(0, 1fr))` }}>
        {p.plans.map((x) => (
          <button key={x.id} type="button" aria-pressed={x.id === p.plan.id} onClick={() => p.onPick(x.id)} className={`${seg(x.id === p.plan.id)} min-h-11 px-1 py-1.5`}>
            {x.short}
          </button>
        ))}
      </div>
      <div className="flex justify-between items-center gap-2 mb-2">
        <label htmlFor="hero-seats" className="text-xs font-semibold text-ink-2">Users</label>
        <div className="flex gap-1.5" role="group" aria-label="Quick user counts">
          {SEAT_PRESETS.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={p.seats === n}
              onClick={() => p.onSeats(n)}
              className={`rounded-full text-xs px-2.5 py-1 border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber ${
                p.seats === n ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline bg-white text-ink-2"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-stretch gap-2 mb-[18px]">
        <button type="button" aria-label="Fewer users" onClick={() => p.onSeats(p.seats - 1)} className="w-12 h-12 shrink-0 border border-hairline bg-paper rounded-[10px] text-[22px] text-ink">−</button>
        <input
          id="hero-seats"
          type="number"
          inputMode="numeric"
          min={1}
          value={p.seats}
          onChange={(e) => p.onSeats(clampSeats(Number(e.target.value)))}
          className="flex-1 min-w-0 h-12 text-center font-serif text-[26px] border border-hairline rounded-[10px] bg-paper text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
        />
        <button type="button" aria-label="More users" onClick={() => p.onSeats(p.seats + 1)} className="w-12 h-12 shrink-0 border border-hairline bg-paper rounded-[10px] text-[22px] text-ink">+</button>
      </div>
      {p.monthlyOk && <div className="mb-5"><BillingToggle billing={p.billing} onBilling={p.onBilling} savePct={p.savePct} /></div>}

      {p.plan.custom || p.plan.priceHidden ? (
        <>
          <div className="p-4 rounded-[10px] bg-paper border border-hairline mb-4">
            <div className="font-serif text-2xl mb-1.5">{p.plan.custom ? "Custom quote" : CONTACT_FOR_PRICING}</div>
            <p className="text-sm text-ink-2 leading-normal m-0">
              {p.plan.custom
                ? `Enterprise is priced on your users, security and compliance needs. We reply with a written GST quote ${SLA.quote}.`
                : `Business Plus is priced for your team. We send a written GST quote ${SLA.quote}.`}
            </p>
          </div>
          <button type="button" onClick={p.onQuote} className="w-full h-[52px] rounded-[10px] bg-ink text-paper text-base font-semibold hover:bg-ink-2">
            {p.plan.custom ? "Request an Enterprise quote" : "Get a GST quote"}
          </button>
        </>
      ) : head && shown ? (
        <>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-serif text-[40px] leading-none" data-testid="hero-total">{overCap ? "—" : head.big}</span>
            {!overCap && head.was && <span className="font-mono text-sm text-ink-3 line-through">{head.was}</span>}
            <span className="text-sm text-ink-3">{head.bigSuffix}</span>
          </div>
          {!overCap && (
            <>
              <div className="text-[13px] text-ink-3 mt-1.5">{head.breakdown}</div>
              <div className="text-[13px] text-ink-3 mt-0.5 font-mono">{head.gstLine}</div>
              <div className="text-[13px] text-ink-3 mt-0.5">
                {rupee(Math.round(shown.subtotal / p.seats / (p.billing === "annual" ? 12 : 1)))} per user per month on average
              </div>
            </>
          )}
          {!overCap && p.promo && <div className="text-[13px] text-emerald font-semibold mt-1.5">{p.promo.label}</div>}
          {overCap && (
            <p role="status" className="text-[13px] text-amber-ink bg-amber-soft rounded-lg px-3 py-2.5 mt-2.5 mb-0">
              Business plans support up to {BUSINESS_MAX_USERS} users. For more, choose Enterprise.
            </p>
          )}
          <button
            type="button"
            onClick={overCap ? p.onQuote : p.onContinue}
            className="mt-[18px] w-full h-[52px] rounded-[10px] bg-amber text-white text-base font-semibold hover:bg-amber-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2"
          >
            {overCap ? "Talk to us about Enterprise" : "Continue to checkout"}
          </button>
          <p className="text-xs text-ink-3 text-center mt-2.5 mb-0">No account needed to buy · we call you to set it up</p>
        </>
      ) : null}
    </div>
  );
}

export function Hero({ card, onPlans, onTrial, trialOk }: { card: PriceCardProps; onPlans: () => void; onTrial: () => void; trialOk: boolean }) {
  return (
    <section className="border-b border-hairline">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 pt-14 pb-16 flex flex-wrap gap-12 items-center">
        <div className="flex-[1_1_440px] min-w-0">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 border border-hairline-strong rounded-full text-xs text-ink-2 font-medium mb-5">
            <span aria-hidden className="w-2 h-2 rounded-full bg-emerald" />
            <span className="font-bold"><GoogleWorkspaceWordmark /></span> reseller since 2014
          </div>
          <h1 className="font-serif font-normal text-[clamp(36px,5vw,56px)] leading-[1.04] tracking-[-0.01em] mb-[18px] [text-wrap:balance]">
            <GoogleWorkspaceWordmark /> for your business.{" "}
            <span className="text-amber">Ready before your chai gets <span className="whitespace-nowrap">cold.<ChaiCup /></span></span>
          </h1>
          <p className="text-[17px] leading-relaxed text-ink-2 mb-7 max-w-[540px]">
            Professional email on your own domain, plus Drive, Meet, Docs and Gemini. Pay in rupees by UPI, card or
            netbanking, get a GST invoice, and we configure everything with you on a call.
          </p>
          <div className="flex flex-wrap gap-3 mb-7">
            <button type="button" onClick={onPlans} className="h-12 px-[22px] rounded-[10px] bg-ink text-paper text-[15px] font-semibold hover:bg-ink-2">
              See plans and prices
            </button>
            {trialOk && (
              <button type="button" onClick={onTrial} className="h-12 px-[22px] rounded-[10px] border border-hairline-strong text-ink text-[15px] font-semibold hover:bg-paper-2">
                Start {WORKSPACE_TRIAL_DAYS}-day free trial
              </button>
            )}
          </div>
          <ul className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-x-5 gap-y-2.5 max-w-[560px] list-none p-0 m-0">
            {CHECKS.map((c) => (
              <li key={c} className="flex gap-2 text-sm text-ink-2"><span aria-hidden className="text-emerald font-bold">✓</span>{c}</li>
            ))}
          </ul>
          <div className="mt-8 pt-6 border-t border-hairline max-w-[560px]">
            <p className="text-xs font-semibold tracking-[0.08em] text-ink-3 mb-3.5">EVERY PLAN INCLUDES</p>
            <ul className="flex flex-wrap gap-2.5 list-none p-0 m-0">
              {APPS.map((a) => (
                <li key={a.name} className="flex flex-col items-center gap-1.5 w-[60px]">
                  <span className="w-[52px] h-[52px] rounded-[14px] bg-white border border-hairline grid place-items-center shadow-[0_4px_10px_-6px_rgba(26,24,21,0.2)]">
                    {/* eslint-disable-next-line @next/next/no-img-element -- small static icon */}
                    <img src={a.src} alt="" width={28} height={28} className="w-7 h-7 object-contain" />
                  </span>
                  <span className="text-xs text-ink-2">{a.name}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <PriceCard {...card} />
      </div>
    </section>
  );
}
