"use client";
/**
 * R-2020 (R-2019a, 27 Oct 2026): the buy page's site promo (Online Promos) — the hook that reads
 * /api/public/site-promo/current, the pre-GST discount it gives, and its banner. Moved out of
 * buy-workspace-client.tsx unchanged, so the desktop page and the phone flow share ONE copy.
 */
import * as React from "react";
import type { SitePromoRow, SitePromoBannerStyle } from "@/lib/supabase/database.types";
import { rupee } from "@/lib/utils";

// ──────────────────────────────────────────────────────────────────────
// Site promo — fetched from /api/public/site-promo/current. Updates as
// the visitor changes tier/seats so the eligibility check stays accurate.
// ──────────────────────────────────────────────────────────────────────
export function useActiveSitePromo(tierId?: string, seats?: number) {
  const [promo, setPromo] = React.useState<SitePromoRow | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (tierId) params.set("tier",  tierId);
    if (seats)  params.set("seats", String(seats));
    fetch(`/api/public/site-promo/current?${params.toString()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setPromo((j?.promo as SitePromoRow | null) ?? null); })
      .catch(() => { if (!cancelled) setPromo(null); });
    return () => { cancelled = true; };
  }, [tierId, seats]);
  return promo;
}

/**
 * Compute the pre-GST rupee discount for a site promo given a gross
 * subtotal. Mirrors the server-side math in /api/public/checkout/workspace
 * so the calculator preview matches the eventual payable amount.
 */
export function computeSitePromoDiscount(promo: SitePromoRow | null, grossSubtot: number): number {
  if (!promo || grossSubtot <= 0) return 0;
  const raw = promo.discount_type === "percent"
    ? Math.round(grossSubtot * promo.discount_value / 100)
    : promo.discount_value;
  return Math.min(raw, grossSubtot);
}

function bannerBg(style?: SitePromoBannerStyle | null): string {
  switch (style) {
    case "rose":    return "bg-gradient-to-r from-rose-500 to-rose-600";
    case "emerald": return "bg-gradient-to-r from-emerald-500 to-emerald-600";
    case "indigo":  return "bg-gradient-to-r from-indigo-500 to-indigo-600";
    case "ink":     return "bg-gradient-to-r from-ink to-ink/80";
    case "amber":
    default:        return "bg-gradient-to-r from-amber-500 to-amber-600";
  }
}

/**
 * SitePromoBanner — sticky bar below the header, animated, with live
 * countdown to the promo end (if set). The discount itself is applied
 * inside the calculator/checkout — this is the visual hook that screams
 * "you're getting a deal RIGHT NOW".
 */
export function SitePromoBanner({ promo }: { promo: SitePromoRow }) {
  const [remaining, setRemaining] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!promo.valid_until) { setRemaining(null); return; }
    const ends = new Date(promo.valid_until).getTime();
    const tick = () => {
      const diff = ends - Date.now();
      if (diff <= 0) { setRemaining(null); return; }
      const days = Math.floor(diff / 86_400_000);
      const hrs  = Math.floor((diff % 86_400_000) / 3_600_000);
      const mins = Math.floor((diff % 3_600_000) / 60_000);
      const secs = Math.floor((diff % 60_000) / 1000);
      if (days >= 1) {
        setRemaining(`${days}d ${hrs}h left`);
      } else {
        setRemaining(`${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")} left`);
      }
    };
    tick();
    const intervalMs = promo.valid_until && (new Date(promo.valid_until).getTime() - Date.now()) < 86_400_000 ? 1000 : 60_000;
    const t = setInterval(tick, intervalMs);
    return () => clearInterval(t);
  }, [promo.valid_until]);

  const off = promo.discount_type === "percent"
    ? `${promo.discount_value}% off`
    : `${rupee(promo.discount_value)} off`;

  return (
    <div className={`${bannerBg(promo.banner_style)} text-paper`}>
      <div className="max-w-[1240px] mx-auto px-4 py-2.5 flex items-center justify-center gap-x-3 gap-y-1 flex-wrap text-xs sm:text-sm">
        {promo.badge_text && (
          <span className="text-3xs uppercase tracking-wider font-semibold bg-paper/20 backdrop-blur px-2 py-0.5 rounded-full whitespace-nowrap">
            {promo.badge_text}
          </span>
        )}
        <span className="font-medium">{promo.headline}</span>
        {promo.subheadline && (
          <span className="opacity-90 hidden md:inline">· {promo.subheadline}</span>
        )}
        <span className="font-mono text-2xs bg-paper text-ink px-2 py-0.5 rounded font-semibold whitespace-nowrap">
          {off}
        </span>
        {remaining && (
          <span className="inline-flex items-center gap-1 font-mono text-2xs bg-ink/30 backdrop-blur px-2 py-0.5 rounded whitespace-nowrap">
            <span aria-hidden>⏱</span> {remaining}
          </span>
        )}
      </div>
    </div>
  );
}

