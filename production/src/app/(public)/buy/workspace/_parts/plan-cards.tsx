"use client";
/**
 * R-1970: "Choose a plan" — one card per plan with its Annual or Monthly rate and the total for
 * the visitor's users — and the collapsible "Compare all features" table. No cart button
 * (DECISIONS 4): a card's button picks the plan and goes to checkout on this page.
 */
import * as React from "react";
import { SLA } from "@/site/lib/config";
import { rupee } from "@/lib/utils";
import { BillingToggle } from "./hero";
import { BUSINESS_MAX_USERS, COMPARE_ROWS, PLAN_COPY, SEAT_PRESETS, clampSeats, planRate, planSum, usersLabel, type Billing, type BuyPlan } from "./plans";
import { GoogleWorkspaceWordmark } from "./wordmark";
import { priceHeadline } from "../price-headline";
import { whatsappHref, type BuyContact } from "./brand";

/**
 * R-1986 (Pardeep): change the users right in "Choose a plan" — presets and − [n] +, writing the
 * page's ONE seats state (hero card, order summary and phone bar read the same), so every card's
 * working line moves with it. Over 300 users → the Enterprise note.
 */
export function PlanSeats({ seats, onSeats }: { seats: number; onSeats: (n: number) => void }) {
  const set = (n: number) => onSeats(clampSeats(n));
  const btn = "w-11 h-11 shrink-0 border border-hairline bg-white rounded-[10px] text-xl text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber";
  return (
    <div className="flex flex-col gap-1.5" data-testid="plan-seats">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="plans-seats" className="text-[13px] font-semibold text-ink-2">Users<span className="sr-only"> for every plan</span></label>
        <div className="flex gap-1.5" role="group" aria-label="Quick user counts for the plans">
          {SEAT_PRESETS.map((n) => (
            <button key={n} type="button" aria-pressed={seats === n} onClick={() => set(n)}
              className={`min-h-11 min-w-11 rounded-full text-xs px-2.5 border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber ${
                seats === n ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline bg-white text-ink-2"
              }`}>
              {n}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" aria-label="Fewer users for the plans" onClick={() => set(seats - 1)} className={btn}>−</button>
          <input id="plans-seats" type="number" inputMode="numeric" min={1} value={seats}
            onChange={(e) => set(Number(e.target.value))}
            className="w-[72px] h-11 text-center font-serif text-[20px] border border-hairline rounded-[10px] bg-white text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-amber" />
          <button type="button" aria-label="More users for the plans" onClick={() => set(seats + 1)} className={btn}>+</button>
        </div>
      </div>
      {seats > BUSINESS_MAX_USERS && (
        <p role="status" className="text-[13px] text-amber-ink bg-amber-soft rounded-lg px-3 py-2 m-0">Over {BUSINESS_MAX_USERS} users? That&apos;s Enterprise — Talk to sales below.</p>
      )}
    </div>
  );
}

/** R-1986: the WhatsApp text for a quoted plan — names the plan and the users, like the page's other WhatsApp links. */
export function salesWhatsappMessage(planName: string, seats: number): string {
  return `Hi, I'd like a Google Workspace ${planName} quote for ${usersLabel(seats)}.`;
}

export function PlanCards({
  plans, selectedId, seats, billing, onBilling, monthlyOk, savePct, onChoose, contact = { tel: null, whatsapp: null }, onSeats,
}: {
  /** R-1986: the users control in this section (the page's one seats state). */
  onSeats?: (n: number) => void;
  /** R-1986: the tenant phone / site WhatsApp (buyContact) for the "Talk to sales" cards. */
  contact?: BuyContact;
  plans: BuyPlan[];
  selectedId: BuyPlan["id"];
  seats: number;
  billing: Billing;
  onBilling: (b: Billing) => void;
  monthlyOk: boolean;
  savePct: number;
  onChoose: (id: BuyPlan["id"]) => void;
}) {
  const annual = billing === "annual";
  return (
    <section id="plans" className="max-w-[1200px] mx-auto px-4 sm:px-5 pt-[72px] pb-10 scroll-mt-20">
      <div className="flex flex-wrap justify-between items-end gap-5 mb-8">
        <div className="max-w-[620px]">
          <h2 className="font-serif font-normal text-[clamp(30px,3.6vw,42px)] leading-[1.1] mb-2.5">Choose a plan</h2>
          <p className="text-base text-ink-2 leading-relaxed m-0">
            Same Google Workspace you&apos;d get from Google. Prices are per user per month, before 18% GST. Totals below are
            for <b className="text-ink">{usersLabel(seats)}</b>.
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          {onSeats && <PlanSeats seats={seats} onSeats={onSeats} />}
          {monthlyOk && <BillingToggle billing={billing} onBilling={onBilling} savePct={savePct} compact />}
        </div>
      </div>

      {/* R-1986 (Pardeep): the buttons and the feature lists line up across the cards whatever the
          text above them — each card spans 8 rows of ONE grid (subgrid), so a row is as tall as its
          tallest card. Phone: the cards stack, a plain column. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-4 sm:gap-y-0" data-testid="plan-grid">
        {plans.map((p) => {
          const sel = p.id === selectedId;
          const rate = planRate(p, billing);
          const sum = planSum(p, seats, billing);
          const quote = p.custom || p.priceHidden || rate == null;
          const totalLine = quote
            ? `Written GST quote ${SLA.quote}`
            : seats > BUSINESS_MAX_USERS
              ? `Max ${BUSINESS_MAX_USERS} users — see Enterprise`
              : sum
                /* R-1986: the working, from the hero card's own helper (price-headline.ts) — the two never disagree. */
                ? priceHeadline({ rate: sum.rate, seats, billing, subtotal: sum.subtotal, gst: sum.gst, total: sum.total }).working
                : "";
          /* R-1986 (Pardeep): a priced plan's button says what it does — "Buy Business Starter" —
             picks the plan and opens the PAY checkout (R-1975: never the trial). */
          const cta = quote ? "Get a quote" : `Buy ${p.name}`; // R-1986: both quoted plans say "Get a quote"
          return (
            <article
              key={p.id}
              aria-label={p.name}
              className={`relative flex flex-col sm:grid sm:grid-rows-subgrid sm:row-span-8 sm:mb-4 bg-white rounded-[14px] p-[22px] border-2 ${
                sel ? "border-amber shadow-[0_16px_32px_-16px_rgba(194,65,12,0.35)]" : "border-hairline"
              }`}
            >
              {p.popular && (
                <span className="absolute -top-3 left-5 bg-ink text-paper text-[11px] font-semibold tracking-[0.04em] px-2.5 py-1 rounded-full">MOST CHOSEN</span>
              )}
              <div className="text-[13px] font-bold mb-1"><GoogleWorkspaceWordmark workspaceWeight={500} /></div>
              <h3 className="font-serif font-normal text-2xl mb-1.5">{p.name}</h3>
              <p className="text-sm text-ink-3 leading-normal min-h-[42px] mb-4">{p.blurb}</p>
              <div className="flex items-baseline gap-2 flex-wrap" data-testid={`plan-price-${p.id}`}>
                {quote ? (
                  /* R-1986 (Pardeep): Plus (price hidden, R-328) and Enterprise — "Talk to sales", no figure. */
                  <span className="font-serif text-[30px] leading-none">Talk to sales</span>
                ) : (
                  <>
                    <span className="font-serif text-[38px] leading-none">{rupee(rate)}</span>
                    <span className="text-[13px] text-ink-3">/user/month</span>
                  </>
                )}
              </div>
              {quote ? (
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5 text-[14px]" data-testid={`plan-sales-${p.id}`}>
                  {contact.tel && (
                    <a href={contact.tel.href} className="min-h-11 inline-flex items-center font-semibold text-amber-ink underline underline-offset-[3px] whitespace-nowrap">Call {contact.tel.display}</a>
                  )}
                  {contact.whatsapp && (
                    <a href={whatsappHref(contact.whatsapp, salesWhatsappMessage(p.name, seats))} target="_blank" rel="noopener noreferrer"
                      className="min-h-11 inline-flex items-center font-semibold text-amber-ink underline underline-offset-[3px]">WhatsApp us</a>
                  )}
                </div>
              ) : (
                <div className="text-[13px] text-ink-3 min-h-5 mt-2">{annual ? "Billed yearly · 12-month plan" : "Billed monthly"}</div>
              )}
              <div className="text-[13px] text-ink-2 px-3 py-2.5 bg-paper rounded-lg mt-3 mb-4 font-mono">{totalLine}</div>
              <button
                type="button"
                onClick={() => onChoose(p.id)}
                className={`w-full min-h-[46px] rounded-[10px] text-[15px] font-semibold border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 ${
                  !quote ? "bg-amber border-amber text-white hover:bg-amber-ink" : "bg-white border-hairline-strong text-ink hover:bg-paper-2"
                }`}
              >
                {cta}
              </button>
              <ul className="list-none p-0 mt-[18px] mb-0 flex flex-col gap-2">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2 text-sm text-ink-2 leading-snug"><span aria-hidden className="text-emerald font-bold shrink-0">✓</span><span>{f}</span></li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
      <p className="text-[13px] text-ink-3 mt-[18px] mb-0 leading-relaxed">
        Annual plan: 12-month commitment, add users any time. Monthly plan: add or remove users from month to month.
        Business plans support up to {BUSINESS_MAX_USERS} users.
      </p>
    </section>
  );
}

const cellTone = (v: string) => (v === "—" ? "text-ink-3 font-medium" : v === "✓" ? "text-emerald font-bold" : "text-ink-2 font-medium");

export function CompareTable({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const tableId = React.useId();
  return (
    <section id="compare" className="max-w-[1200px] mx-auto px-4 sm:px-5 pt-4 pb-14 scroll-mt-20">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={tableId}
        onClick={onToggle}
        className="w-full flex justify-between items-center bg-white border border-hairline rounded-xl px-5 py-[18px] text-base font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
      >
        <span>Compare all features</span>
        <span className="text-sm text-ink-3 font-medium">{open ? "Hide" : "Show all"}</span>
      </button>
      {open && (
        <div id={tableId} className="overflow-x-auto mt-2 border border-hairline rounded-xl bg-white">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="bg-paper-2">
                <th scope="col" className="text-left px-4 py-3.5 font-semibold w-[34%]">Feature</th>
                {(["starter", "standard", "plus", "enterprise"] as const).map((id) => PLAN_COPY[id].name).map((h) => (
                  <th key={h} scope="col" className="px-2.5 py-3.5 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((r) =>
                r.length === 1 ? (
                  <tr key={r[0]} className="border-t border-hairline bg-paper">
                    <th scope="colgroup" colSpan={5} className="text-left px-4 py-3 text-amber-ink font-semibold text-xs">{r[0]}</th>
                  </tr>
                ) : (
                  <tr key={r[0]} className="border-t border-hairline">
                    <th scope="row" className="text-left px-4 py-3 font-normal text-ink">{r[0]}</th>
                    {r.slice(1).map((v, i) => (
                      <td key={i} className={`px-2.5 py-3 text-center ${cellTone(v)}`}>
                        {v === "—" ? <span aria-label="Not included">—</span> : v === "✓" ? <span aria-label="Included">✓</span> : v}
                      </td>
                    ))}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
