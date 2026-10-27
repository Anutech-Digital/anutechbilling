"use client";
/**
 * R-2020 (R-2019a): the phone flow's Plans screen — "What do you need?" first (nothing else until
 * it is answered), then licences (stepper + presets, 300 online), Pay yearly / monthly with the
 * real saving, and the Starter / Standard cards. Every number is planSum on the desktop's plans.
 */
import * as React from "react";
import { rupee } from "@/lib/utils";
import { planSum, type Billing, type BuyPlan } from "../_parts/plans";
import type { BuyBrand, BuyContact } from "../_parts/brand";
import { MOBILE_MAX_ONLINE, type Intent, type MobileState } from "./url-state";
import { yearlySaving } from "./prices";
import { TrustCard, FounderCard } from "./trust";

export const SEAT_PRESETS_MOBILE = [1, 5, 10, 25, 50] as const;

const H = "font-bold text-[17px] m-0";

function Dot({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`w-[22px] h-[22px] rounded-full border-[1.5px] shrink-0 mt-0.5 shadow-[inset_0_0_0_5px_#fff] ${on ? "border-amber bg-amber" : "border-hairline-strong bg-white"}`} />
  );
}

const choice = (on: boolean) =>
  `text-left rounded-xl border-[1.5px] p-3.5 flex gap-3 items-start text-ink w-full ${on ? "bg-amber-soft border-amber" : "bg-white border-hairline"} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber`;

export const licences = (n: number) => `${n.toLocaleString("en-IN")} ${n === 1 ? "licence" : "licences"}`;

export function PlansStep({
  state, plans, monthlyOk, brand, contact, intentErr, talkHref,
  onIntent, onSeats, onBilling, onTier, onCompare,
}: {
  state: MobileState;
  plans: BuyPlan[];
  monthlyOk: boolean;
  brand: BuyBrand | null;
  contact: BuyContact;
  intentErr: boolean;
  talkHref: string;
  onIntent: (i: Intent) => void;
  onSeats: (n: number) => void;
  onBilling: (b: Billing) => void;
  onTier: (t: MobileState["tier"]) => void;
  onCompare: () => void;
}) {
  const { intent, seats, billing, tier } = state;
  const [open, setOpen] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<string | null>(null);
  const over = seats > MOBILE_MAX_ONLINE;
  const annual = billing === "annual";
  const sel = plans.find((p) => p.id === tier) ?? plans[0];
  const save = sel ? yearlySaving(sel, seats) : null;
  const seller = brand?.name ?? "us";

  const intents: ReadonlyArray<[Intent, string, string]> = [
    ["transfer", `Switch my existing Google Workspace to ${seller}`, "Keep your current account, emails and files. Only the billing moves to us."],
    ["new", "New Google Workspace", "Fresh setup for your domain, or a new domain we register for you."],
  ];

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="m-intent" className="flex flex-col gap-2.5">
        <h2 id="m-intent" tabIndex={-1} className={`${H} scroll-mt-20 focus:outline-none`}>What do you need?</h2>
        <div role="radiogroup" aria-labelledby="m-intent" className="flex flex-col gap-2.5">
          {intents.map(([id, title, desc]) => (
            <button key={id} type="button" role="radio" aria-checked={intent === id} onClick={() => onIntent(id)} className={choice(intent === id)}>
              <Dot on={intent === id} />
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="font-bold text-base">{title}</span>
                <span className="text-sm text-ink-2 leading-snug">{desc}</span>
              </span>
            </button>
          ))}
        </div>
        {intentErr && !intent && <p role="alert" className="text-sm text-rose-ink m-0">Please choose one to continue.</p>}
        {intent === "transfer" && (
          <div className="flex flex-col gap-1.5 bg-indigo-soft text-indigo-ink rounded-xl px-3.5 py-3 text-sm leading-snug">
            <b>Switching is safe</b>
            <span>Your emails, files and admin login stay exactly as they are, on Google. Nothing to re-install. Google moves the billing once you approve it in your admin console, and we guide you through it on a call.</span>
          </div>
        )}
      </section>

      {/* R-2020: the trust card sits after the first question, so the question peeks above the fold under the hero. */}
      <TrustCard />

      {intent && (
        <>
          <section aria-labelledby="m-seats" className="flex flex-col gap-2.5">
            <h2 id="m-seats" className={H}>{intent === "transfer" ? "How many licences do you have now?" : "How many licences do you need?"}</h2>
            <div className="flex items-center gap-3 flex-wrap">
              <div role="group" aria-label="Number of licences" className="flex items-center border border-hairline-strong rounded-xl bg-white overflow-hidden">
                <button type="button" aria-label="Fewer licences" onClick={() => onSeats(seats - 1)}
                  className="w-[52px] h-[52px] bg-white text-2xl text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber">−</button>
                <input
                  type="number" inputMode="numeric" min={1} aria-label="Number of licences"
                  value={draft ?? String(seats)}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    const n = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(n) && n >= 1) onSeats(n);
                  }}
                  onBlur={() => setDraft(null)}
                  className="w-16 h-[52px] border-x border-hairline text-center text-xl font-bold text-ink bg-white [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber"
                />
                <button type="button" aria-label="More licences" onClick={() => onSeats(seats + 1)}
                  className="w-[52px] h-[52px] bg-white text-2xl text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber">+</button>
              </div>
              <span className="text-[15px] text-ink-2">{seats === 1 ? "licence" : "licences"} · 1 licence = 1 email ID</span>
            </div>
            <div className="flex gap-2 flex-wrap">
              {SEAT_PRESETS_MOBILE.map((n) => (
                <button key={n} type="button" aria-pressed={n === seats} onClick={() => { setDraft(null); onSeats(n); }}
                  className={`h-11 min-w-[52px] px-3 rounded-full border-[1.5px] text-sm font-semibold text-ink ${n === seats ? "border-amber bg-amber-soft" : "border-hairline bg-white"} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber`}>
                  {n}
                </button>
              ))}
            </div>
          </section>

          <section aria-labelledby="m-plan" className="flex flex-col gap-2.5">
            <div className="flex justify-between items-center gap-2">
              <h2 id="m-plan" className={H}>{intent === "transfer" ? "Which plan should you continue on?" : "Pick a plan"}</h2>
              <button type="button" onClick={onCompare} className="h-11 shrink-0 text-amber-ink text-sm font-bold underline underline-offset-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded">Compare plans</button>
            </div>

            {monthlyOk && (
              <div role="radiogroup" aria-label="How you pay" className="flex p-1 bg-paper-2 rounded-xl gap-1">
                {([
                  ["annual", "Pay yearly", over || save == null ? "Lowest price" : `Save ${rupee(save)}`],
                  ["monthly", "Pay monthly", "Most flexible"],
                ] as const).map(([id, title, sub]) => {
                  const on = billing === id;
                  return (
                    <button key={id} type="button" role="radio" aria-checked={on} onClick={() => onBilling(id)}
                      className={`flex-1 min-h-12 rounded-[9px] flex flex-col items-center justify-center gap-px py-1 ${on ? "bg-white text-ink shadow-[0_1px_4px_rgba(26,24,21,0.18)]" : "text-ink-3"} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber`}>
                      <span className="text-[15px] font-bold">{title}</span>
                      <span className={`text-xs font-semibold ${on && id === "annual" ? "text-emerald-ink" : "text-ink-3"}`}>{sub}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-sm leading-snug text-ink-2 m-0">
              {annual
                ? "One payment for 12 months, lowest price. Add licences anytime. Removing licences waits until renewal."
                : "Pay every month. Add or remove licences anytime. Costs more over a year."}
            </p>

            <div role="radiogroup" aria-labelledby="m-plan" className="flex flex-col gap-2.5">
              {plans.map((p) => {
                const on = p.id === tier;
                const s = planSum(p, seats, billing);
                return (
                  <div key={p.id} className={`rounded-[14px] border-[1.5px] overflow-hidden ${on ? "bg-amber-soft border-amber" : "bg-white border-hairline"}`}>
                    <button type="button" role="radio" aria-checked={on} onClick={() => onTier(p.id as MobileState["tier"])}
                      className="w-full text-left p-4 flex gap-3 items-start text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber">
                      <Dot on={on} />
                      <span className="flex-1 flex flex-col gap-1 min-w-0">
                        <span className="flex justify-between gap-2 items-center">
                          <span className="font-serif text-[22px] leading-none">{p.short}</span>
                          {p.popular && <span className="text-xs font-bold text-amber-ink bg-white border border-amber/50 px-2 py-0.5 rounded-full">Most picked</span>}
                        </span>
                        <span className="text-sm text-ink-2 leading-snug">{p.blurb}</span>
                        <span className="flex items-baseline gap-1.5 flex-wrap pt-1">
                          <span className="text-[22px] font-bold">{over || !s ? "Not available" : rupee(s.total)}</span>
                          <span className="text-sm text-ink-2">{over || !s ? `above ${MOBILE_MAX_ONLINE} licences` : `${annual ? "a year" : "a month"} for ${licences(seats)}`}</span>
                        </span>
                        {!over && s && annual && <span className="text-sm font-semibold">That&apos;s about {rupee(Math.round(s.total / 12))} a month</span>}
                        {s && <span className="text-sm text-ink-3">{rupee(s.rate)} per licence / month + GST</span>}
                      </span>
                    </button>
                    <button type="button" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)}
                      className="w-full h-11 border-t border-hairline text-sm font-semibold text-amber-ink text-left pl-[50px] pr-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber">
                      {open === p.id ? "Hide what's included" : "See what's included"}
                    </button>
                    {open === p.id && (
                      <ul className="pl-[50px] pr-4 pb-4 m-0 flex flex-col gap-2 list-none">
                        {p.features.map((f) => (
                          <li key={f} className="flex gap-2 text-sm leading-snug"><span aria-hidden className="text-emerald-ink font-bold">✓</span><span>{f}</span></li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
            {over && (
              <p className="text-sm leading-normal text-amber-ink bg-amber-soft px-3.5 py-3 rounded-[10px] m-0">
                Online purchase works for up to {MOBILE_MAX_ONLINE} licences. For more, we&apos;ll call you with a quote.
              </p>
            )}
            <p className="text-sm text-ink-2 m-0">
              Need Plus or Enterprise?{" "}
              <a href={talkHref} target="_blank" rel="noopener noreferrer" className="font-bold text-amber-ink underline underline-offset-[3px]">Talk to us</a>
            </p>
          </section>

          <FounderCard brand={brand} contact={contact} />
        </>
      )}
    </div>
  );
}
