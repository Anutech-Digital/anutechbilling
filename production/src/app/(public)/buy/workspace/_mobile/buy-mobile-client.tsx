"use client";
/**
 * R-2020 (R-2019a, 27 Oct 2026, Pardeep — design buy-workspace-mobile, R-2019 decisions 1–9):
 * /buy/workspace on a PHONE. page.tsx renders this OR the desktop v2 page (never both, so the
 * phone downloads one tree — this file must never import buy-workspace-client.tsx).
 * One screen at a time, every choice in the address bar (url-state.ts; ad params untouched).
 * Prices: the desktop's plans (_parts/tiers.ts → _parts/plans.ts planSum), Starter + Standard
 * only; the site promo is the desktop's too. Consent banner, Meta Pixel and the first-touch ad
 * landing (R-2010 / R-1979 / R-1978) are mounted exactly as on the desktop page.
 * Until the phone checkout (R-2021) ships, Continue opens the v2 checkout with the same choices.
 */
import * as React from "react";
import Link from "next/link";
import { rupee } from "@/lib/utils";
import { isPublicPriceHiddenTier } from "@/lib/catalog/public-price-policy";
import { PARTNER_BADGE } from "@/site/lib/config";
import { landingForForm } from "@/site/lib/ad-attribution";
import { MetaPixel, trackMeta } from "@/site/lib/meta-pixel";
import { ConsentBanner } from "@/site/components/chrome/ConsentBanner";
import { contentIdForPlan } from "@/lib/meta/pixel-ids";
import { toBuyPlans, planSum, monthlyOffered, type Billing } from "../_parts/plans";
import { buyContact, whatsappHref, type BuyBrand, type BuyContact } from "../_parts/brand";
import { buildTiers, FALLBACK_TIERS, type CatalogItem } from "../_parts/tiers";
import { useActiveSitePromo, computeSitePromoDiscount, SitePromoBanner } from "../_parts/site-promo";
import { orderTotals } from "../_parts/checkout-form";
import { TestModeBar } from "../_parts/info-sections";
import { readMobileState, writeMobileState, continueHref, MOBILE_MAX_ONLINE, type MobileState, type Intent } from "./url-state";
import { mobilePlans } from "./prices";
import { PlansStep, licences } from "./plans-step";
import { CompareStep } from "./compare-step";
import { MobileHero } from "./hero";
import { trackFunnel } from "./funnel";

/**
 * R-2019 goal 5: only the consent banner may overlay — on the phone it sits ABOVE the sticky
 * Continue bar (never over it) and is kept short (scrolls inside), so the first question stays
 * readable. Scoped to this page; the shared banner is unchanged everywhere else.
 */
const CONSENT_ON_PHONE = ".m-buy .consent-banner{bottom:calc(var(--m-bar-h,0px) + 12px);max-height:34vh}";

/** Continue without an answer: bring the first question into view and give it focus. */
export function goToIntent(): void {
  const h = document.getElementById("m-intent");
  if (!h) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  h.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "start" });
  h.focus({ preventScroll: true });
}

/** Where "Talk to us" goes until the phone help sheet (R-2021): WhatsApp, else a call, else the v2 page's talk-to-us band. */
export function talkHref(contact: BuyContact, message: string): string {
  if (contact.whatsapp) return whatsappHref(contact.whatsapp, message);
  if (contact.tel) return contact.tel.href;
  return "/buy/workspace?view=desktop#talk-to-us";
}

function TopBar({ brand, href }: { brand: BuyBrand | null; href: string }) {
  const name = brand?.name ?? "Google Workspace";
  return (
    <header className="sticky top-0 z-30 bg-paper/95 backdrop-blur-sm border-b border-hairline">
      <div className="max-w-[480px] mx-auto flex justify-between items-center gap-3 px-4 py-2">
        <Link href="/" className="flex items-center gap-2.5 min-w-0 no-underline text-ink">
          {brand?.logoUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element -- tenant logo, any host */
            <img src={brand.logoUrl} alt="" className="h-8 w-8 shrink-0 rounded-lg object-contain bg-white" />
          ) : (
            <span aria-hidden className="h-8 w-8 shrink-0 rounded-lg bg-ink text-paper grid place-items-center font-serif text-[17px]">{name.charAt(0).toUpperCase()}</span>
          )}
          <span className="flex flex-col min-w-0">
            <span className="font-serif text-[15px] leading-tight truncate">{name}</span>
            <span className="text-xs text-ink-3 truncate">{PARTNER_BADGE}</span>
          </span>
        </Link>
        <a href={href} target="_blank" rel="noopener noreferrer"
          className="h-11 px-3.5 border border-hairline rounded-full bg-white whitespace-nowrap shrink-0 text-sm font-semibold text-ink grid place-items-center no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">
          Talk to us
        </a>
      </div>
    </header>
  );
}

export function BuyMobileClient({
  catalogItems = [],
  paymentMode = "simulation",
  brand = null,
  metaPixelId = null,
  initialSearch = {},
}: {
  catalogItems?: CatalogItem[];
  paymentMode?: "live" | "simulation" | "disabled";
  brand?: BuyBrand | null;
  metaPixelId?: string | null;
  /** The request's search params (page.tsx) — the first render matches the server's. */
  initialSearch?: Record<string, string | string[] | undefined>;
}) {
  const plans = React.useMemo(
    () => mobilePlans(toBuyPlans(catalogItems.length > 0 ? buildTiers(catalogItems) : FALLBACK_TIERS, isPublicPriceHiddenTier)),
    [catalogItems],
  );
  const monthlyOk = monthlyOffered(plans);
  const contact = buyContact(brand);

  const [state, setState] = React.useState<MobileState>(() => {
    const s = readMobileState(initialSearch);
    return { ...s, billing: monthlyOk ? s.billing : "annual", tier: plans.some((p) => p.id === s.tier) ? s.tier : (plans[0]?.id as MobileState["tier"]) ?? "standard" };
  });
  const [intentErr, setIntentErr] = React.useState(false);

  /** Every change is written to the address bar: a new step is a history entry (Back works), a choice replaces it. */
  const update = (patch: Partial<MobileState>) => {
    const next = { ...state, ...patch };
    setState(next);
    const url = `${window.location.pathname}${writeMobileState(window.location.search, next)}${window.location.hash}`;
    if (next.step !== state.step) { window.history.pushState(null, "", url); window.scrollTo?.({ top: 0 }); trackFunnel("step_viewed", { step: next.step }); }
    else window.history.replaceState(null, "", url);
  };
  React.useEffect(() => {
    const onPop = () => setState(readMobileState(new URLSearchParams(window.location.search)));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const plan = plans.find((p) => p.id === state.tier) ?? plans[0];
  const over = state.seats > MOBILE_MAX_ONLINE;
  const sum = plan ? planSum(plan, state.seats, state.billing) : null;

  /* Site promo (Online Promos): the same hook and maths as the desktop page; the checkout route applies it. */
  const sitePromo = useActiveSitePromo(plan?.id, state.seats);
  const promoOff = sum ? computeSitePromoDiscount(sitePromo, sum.subtotal) : 0;
  const totals = sum ? orderTotals(sum.subtotal, promoOff, 0) : null;

  /* R-1978: remember the ad this visit landed from (first touch) — the checkout sends it. */
  React.useEffect(() => {
    landingForForm();
    trackFunnel("step_viewed", { step: state.step });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  /* Goal 5: the sticky bar's real height, so the consent banner can sit above it. */
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const bar = root.querySelector<HTMLElement>("[data-m-bar]");
    const set = () => root.style.setProperty("--m-bar-h", `${bar?.offsetHeight ?? 0}px`);
    set();
    if (!bar || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(set);
    ro.observe(bar);
    return () => ro.disconnect();
  });
  /* R-1979: ViewContent once, as on the desktop page (a no-op without consent + pixel id). */
  React.useEffect(() => {
    trackMeta("ViewContent", { content_ids: contentIdForPlan(`google-workspace-${state.tier}`), content_type: "product", value: sum?.subtotal ?? 0, currency: "INR", num_items: state.seats });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, []);

  const bill = state.billing === "annual" ? "Yearly" : "Monthly";
  const quoteHref = talkHref(contact, `Hi, I'd like a Google Workspace quote for ${licences(state.seats)}.`);
  const plusHref = talkHref(contact, "Hi, I'd like to know about Google Workspace Business Plus or Enterprise.");
  const helpHref = talkHref(contact, "Hi, I'm looking at Google Workspace on your website.");

  const onContinue = () => {
    if (!state.intent) { setIntentErr(true); goToIntent(); return; }
    trackFunnel("checkout_started", { tier: state.tier, seats: state.seats, billing: state.billing });
    window.location.assign(continueHref(window.location.search, state));
  };

  return (
    <div ref={rootRef} className="m-buy min-h-screen bg-paper text-ink">
      <style>{CONSENT_ON_PHONE}</style>
      <MetaPixel pixelId={metaPixelId} />
      {/* R-2010: the same consent banner as the desktop page and the site. */}
      <ConsentBanner />
      {paymentMode === "simulation" && <TestModeBar />}
      <TopBar brand={brand} href={helpHref} />
      {sitePromo && <SitePromoBanner promo={sitePromo} />}
      <main className="max-w-[480px] mx-auto pb-[160px]">
        {state.step === "compare" ? (
          <CompareStep plans={plans} onBack={() => update({ step: "plans" })} onChoose={(t) => { update({ step: "plans", tier: t }); trackFunnel("plan_selected", { tier: t, seats: state.seats, billing: state.billing }); }} />
        ) : plan ? (
          <>
          <MobileHero />
          <div className="px-4 pt-[18px]">
            <PlansStep
              state={state} plans={plans} monthlyOk={monthlyOk} brand={brand} contact={contact}
              intentErr={intentErr} talkHref={plusHref}
              onIntent={(i: Intent) => { setIntentErr(false); update({ intent: i }); trackFunnel("intent_selected", { intent: i }); }}
              onSeats={(n) => update({ seats: Math.max(1, Math.min(10_000, Math.round(n) || 1)) })}
              onBilling={(b: Billing) => update({ billing: b })}
              onTier={(t) => { update({ tier: t }); trackFunnel("plan_selected", { tier: t, seats: state.seats, billing: state.billing }); }}
              onCompare={() => update({ step: "compare" })}
            />
          </div>
          </>
        ) : (
          <div className="px-4 pt-6 flex flex-col gap-3">
            <h1 className="font-serif font-normal text-[30px] leading-tight m-0">Buy Google Workspace</h1>
            <p className="text-[15px] text-ink-2 m-0">Online prices are not available right now. Talk to us and we&apos;ll send a GST quote.</p>
            <a href={helpHref} className="h-[54px] rounded-xl bg-amber text-white text-[17px] font-bold grid place-items-center no-underline">Talk to us</a>
          </div>
        )}
      </main>

      {state.step === "plans" && plan && (
        <div data-m-bar data-testid="mobile-continue-bar" className="fixed inset-x-0 bottom-0 z-30 bg-white border-t border-hairline shadow-[0_-12px_24px_-16px_rgba(26,24,21,0.3)]">
          <div className="max-w-[480px] mx-auto px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] flex flex-col gap-2.5">
            <div className="flex justify-between items-baseline gap-2.5">
              <span className="text-sm text-ink-2 min-w-0">{plan.short} · {licences(state.seats)} · {bill}</span>
              <span className="font-bold text-lg whitespace-nowrap">{over || !totals ? "Custom quote" : rupee(totals.total)}</span>
            </div>
            {!over && promoOff > 0 && sitePromo && (
              <span className="text-sm text-emerald-ink -mt-1.5">{sitePromo.headline} · online sale applied</span>
            )}
            {over ? (
              <a href={quoteHref} target="_blank" rel="noopener noreferrer"
                className="h-[54px] rounded-xl bg-amber text-white text-[17px] font-bold grid place-items-center no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2">
                Get a call back with a quote
              </a>
            ) : (
              <button type="button" onClick={onContinue}
                className="h-[54px] rounded-xl bg-amber text-white text-[17px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2">
                Continue
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
