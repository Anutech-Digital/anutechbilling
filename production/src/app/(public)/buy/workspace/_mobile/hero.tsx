"use client";
/**
 * R-2020 (Pardeep, 27 Oct 2026: "mobile version me hero section bhi jodna", then "compact"): the
 * phone flow opens with a SHORT take on the R-2018 desktop hero — about a third of a 375×812
 * screen, so "What do you need?" is on the first screen with no scrolling and no button needed.
 * The same dark layer (HeroBackground, flat 80% ink on a phone) over the R-1990 poster ONLY — no
 * clip on a phone — and the same white / white-85 / orange-300 / emerald-300 text R-2018 measured
 * at 4.5:1 or more against the brightest frame. No panel behind the text.
 */
import { PARTNER_LINE } from "@/site/lib/config";
import { HeroBackground } from "../_parts/hero";
import { ChaiCup, GoogleWorkspaceWordmark } from "../_parts/wordmark";

const TICKS = ["GST invoice", "Setup call included"];

/** The partner line without the product name, for the pill beside the wordmark ("reseller since 2014"). */
const PILL = PARTNER_LINE.replace(/^Google Workspace\s*/i, "");

export function MobileHero() {
  return (
    <section data-testid="mobile-hero" aria-labelledby="m-hero-title" className="relative isolate border-b border-hairline">
      <HeroBackground posterOnly />
      <div data-testid="mobile-hero-text" className="max-w-[480px] mx-auto px-4 pt-4 pb-5 flex flex-col gap-2.5">
        <div className="self-start inline-flex items-center gap-2 px-2.5 py-1 border border-white/25 bg-ink/40 rounded-full text-xs text-white font-medium">
          <span aria-hidden className="w-2 h-2 rounded-full bg-emerald-300" />
          <span><span className="font-bold"><GoogleWorkspaceWordmark tone="dark" /></span> {PILL}</span>
        </div>
        <h1 id="m-hero-title" className="font-serif font-normal text-white text-[26px] leading-[1.08] tracking-[-0.01em] m-0 [text-wrap:balance]">
          <GoogleWorkspaceWordmark tone="dark" /> for your business.{" "}
          <span className="text-orange-300">Ready before your chai gets <span className="whitespace-nowrap">cold.<ChaiCup /></span></span>
        </h1>
        <p className="text-sm leading-snug text-white/85 m-0">Business email, Drive and Meet. We set it up and copy your old email for you.</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 list-none p-0 m-0">
          {TICKS.map((t) => (
            <li key={t} className="flex gap-1.5 text-sm text-white/85"><span aria-hidden className="text-emerald-300 font-bold">✓</span>{t}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
