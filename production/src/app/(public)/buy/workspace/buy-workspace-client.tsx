"use client";

/**
 * Buy Google Workspace — public page (/buy/workspace).
 *
 * R-1970 (26 Oct 2026): Pardeep's design v2 — header, hero + "Your price" card, plan cards
 * (Annual / Monthly), compare, why us, checkout, after-you-pay, FAQ, talk-to-us band, footer.
 * R-1971: checkout is ON the page — three steps + sticky order summary (coupon), the GST
 * invoice preview, Monthly priced on the server, the phone bottom bar. No popups: the old Buy
 * now / Quote / Trial dialogs are gone; their submit logic lives in _parts/submit-order.ts.
 * The sections are in _parts/; this file keeps the page state and the catalogue → tier merge.
 * No website cart on this page (DECISIONS 4) — the site cart stays for domains and hosting.
 */

import * as React from "react";
import { isPublicPriceHiddenTier } from "@/lib/catalog/public-price-policy";
import { tierAnnualPrice } from "./tier-price";
import type { SitePromoRow, SitePromoBannerStyle } from "@/lib/supabase/database.types";
import { toBuyPlans, planSum, monthlyOffered, annualSavingPct, clampSeats, usersLabel, BUSINESS_MAX_USERS, type Billing, type BuyPlan } from "./_parts/plans";
import { buyContact, type BuyBrand } from "./_parts/brand";
import { goTo } from "./_parts/wordmark";
import { SiteHeader } from "./_parts/site-header";
import { Hero } from "./_parts/hero";
import { PlanCards, CompareTable } from "./_parts/plan-cards";
import { WhyUs, AfterYouPay, Faq, SupportBand, SiteFooter, TestModeBar } from "./_parts/info-sections";
import { Checkout, canPayOnline } from "./_parts/checkout";
import { SamePrice } from "./_parts/same-price";
import { InvoicePreview, PhoneBar } from "./_parts/order-summary";
import { orderTotals } from "./_parts/checkout-form";
import { useCheckout } from "./_parts/use-checkout";
import { rupee } from "@/lib/utils";
import { landingForForm } from "@/site/lib/ad-attribution";


// ──────────────────────────────────────────────────────────────────────
// Site promo — fetched from /api/public/site-promo/current. Updates as
// the visitor changes tier/seats so the eligibility check stays accurate.
// ──────────────────────────────────────────────────────────────────────
function useActiveSitePromo(tierId?: string, seats?: number) {
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
function computeSitePromoDiscount(promo: SitePromoRow | null, grossSubtot: number): number {
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
function SitePromoBanner({ promo }: { promo: SitePromoRow }) {
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


// ──────────────────────────────────────────────────────────────────────
// Pricing tiers
// ──────────────────────────────────────────────────────────────────────
interface Tier {
  id:           string;
  catalogId:    string | null;   // FK to items.id when the tier came from the catalog
  name:         string;
  monthlyPrice: number | null;
  annualPrice:  number | null;
  promoPrice?:  number | null;
  promoLabel?:  string | null;
  maxUsers:     number | null;
  isPopular?:   boolean;
  cta:          string;
  introHeader:  string;
  features:     string[];
}

/**
 * What the Server Component (page.tsx) passes in. One row per enabled
 * Google Workspace SKU in the reseller's Item Catalog. When empty, the
 * client falls back to FALLBACK_TIERS below.
 */
export interface CatalogItem {
  id:         string;
  name:       string;
  msrp:       number;
  wholesale:  number;
  margin_pct: number | null;
  is_active:  boolean;
  prices: {
    annual?:  { msrp: number; wholesale: number };
    monthly?: { msrp: number; wholesale: number };
  };
}

// Hardcoded feature lists + popularity flag — the Item Catalog doesn't store
// these yet, so we keep a slug-keyed preset and merge it with each item's
// pricing data when building runtime tiers.
type TierSlug = "starter" | "standard" | "plus" | "enterprise";

interface TierPreset {
  slug:        TierSlug;
  introHeader: string;
  features:    string[];
  isPopular?:  boolean;
}

const TIER_PRESETS: Record<TierSlug, TierPreset> = {
  starter: {
    slug: "starter",
    introHeader: "Starter includes:",
    features: [
      "30 GB pooled storage per person",
      "Custom business email @yourcompany",
      "Gemini AI in Gmail",
      "Gemini app access + NotebookLM",
      "100-participant video meetings",
      "Google Vids — AI video creation",
      "Workspace Studio automation",
      "Manage up to 300 users",
    ],
  },
  standard: {
    slug: "standard",
    isPopular: true,
    introHeader: "All of Starter, and:",
    features: [
      "2 TB pooled storage (65× more than Starter)",
      "Gemini in Docs, Meet, Sheets, Slides",
      "Expanded NotebookLM access",
      "150-participant meetings with recording",
      "Noise cancellation + auto-transcripts",
      "Custom email layouts + mail merge",
      "Appointment booking + eSignature in Docs",
      "Google Workspace Migrate tool",
    ],
  },
  plus: {
    slug: "plus",
    introHeader: "All of Standard, and:",
    features: [
      "5 TB pooled storage per person",
      "500-participant meetings with attendance tracking",
      "Enhanced security · S/MIME · DLP",
      "Vault retention + eDiscovery",
      "Advanced endpoint management",
      "Secure LDAP for legacy apps",
    ],
  },
  enterprise: {
    slug: "enterprise",
    introHeader: "All features, with:",
    features: [
      "5 TB pooled storage per person",
      "1,000-participant livestreaming",
      "S/MIME encryption",
      "Data Loss Prevention (DLP)",
      "Context-aware access policies",
      "Enterprise data regions",
      "Cloud Identity Premium",
      "Enhanced support for mission-critical issues",
    ],
  },
};

/** Slug a catalog item name into a known preset key. */
function slugFromName(name: string): TierSlug {
  if (/starter/i.test(name))    return "starter";
  if (/standard/i.test(name))   return "standard";
  if (/\bplus\b/i.test(name))   return "plus";
  if (/enterprise/i.test(name)) return "enterprise";
  return "standard";
}

/** Merge catalog rows with hardcoded presets to produce runtime tiers. */
function buildTiers(catalog: CatalogItem[]): Tier[] {
  return catalog.map((item) => {
    const slug    = slugFromName(item.name);
    const preset  = TIER_PRESETS[slug];
    /* R-328 (7 Oct 2026, Pardeep): Business Plus has no price on the website — like Google's
       own page. Its card says "Contact us for pricing" and goes to the quote form; the server
       page already sends it with no figures and the checkout route refuses it. */
    const onRequest = slug === "enterprise" || isPublicPriceHiddenTier(slug);
    /* R-276: same floor as the server's order amount, so a stale row is never shown below list. */
    const annual  = tierAnnualPrice(slug, item.prices?.annual?.msrp ?? item.msrp);
    /* R-157: used to multiply the annual rate by 1.25 when no monthly existed — an invented rate. Only a real
       flexible price above the annual one is shown (a lower one is a stale catalogue row). */
    const flex = item.prices?.monthly?.msrp ?? null;
    const monthly = flex != null && flex > annual ? flex : null;
    return {
      id:           slug,
      catalogId:    item.id,
      name:         item.name.replace(/^Google Workspace\s*/i, "") || item.name,
      monthlyPrice: onRequest ? null : monthly,
      annualPrice:  onRequest ? null : annual,
      maxUsers:     slug === "enterprise" ? null : 300,
      isPopular:    preset.isPopular,
      cta:          slug === "enterprise" ? "Contact sales" : "Get a quote",
      introHeader:  preset.introHeader,
      features:     preset.features,
    };
  });
}

// NOTE: Business Base (₹99/user) is excluded — it's vendor-direct only,
// resellers cannot sell it. Customers wanting Base must buy from Google directly.
// FALLBACK_TIERS used only when the catalog returns zero enabled Google Workspace
// items. Real source of truth is the items table (page.tsx fetches it server-side).
const FALLBACK_TIERS: Tier[] = [
  {
    id: "starter",
    catalogId: null,
    name: "Business Starter",
    monthlyPrice: 325,
    annualPrice:  270,
    maxUsers:     300,
    cta:          "Get a quote",
    introHeader:  "Starter includes:",
    features: [
      "30 GB pooled storage per person",
      "Custom business email @yourcompany",
      "Gemini AI in Gmail",
      "Gemini app access + NotebookLM",
      "100-participant video meetings",
      "Google Vids — AI video creation",
      "Workspace Studio automation",
      "Manage up to 300 users",
    ],
  },
  {
    id: "standard",
    catalogId: null,
    name: "Business Standard",
    monthlyPrice: 1300,
    annualPrice:  1080,
    maxUsers:     300,
    isPopular:    true,
    cta:          "Get a quote",
    introHeader:  "All of Starter, and:",
    features: [
      "2 TB pooled storage (65× more than Starter)",
      "Gemini in Docs, Meet, Sheets, Slides",
      "Expanded NotebookLM access",
      "150-participant meetings with recording",
      "Noise cancellation + auto-transcripts",
      "Custom email layouts + mail merge",
      "Appointment booking + eSignature in Docs",
      "Google Workspace Migrate tool",
    ],
  },
  /* R-1970 (Pardeep, 26 Oct): Plus is 1,500 / 1,800 — but R-328 keeps its price off the
     website, so while that policy holds the fallback card is quote-only, like the catalogue one. */
  {
    id: "plus",
    catalogId: null,
    name: "Business Plus",
    monthlyPrice: isPublicPriceHiddenTier("plus") ? null : 1800,
    annualPrice:  isPublicPriceHiddenTier("plus") ? null : 1500,
    maxUsers:     300,
    cta:          "Get a quote",
    introHeader:  "All of Standard, and:",
    features:     TIER_PRESETS.plus.features,
  },
  {
    id: "enterprise",
    catalogId: null,
    name: "Enterprise",
    monthlyPrice: null,
    annualPrice:  null,
    maxUsers:     null,
    cta:          "Contact sales",
    introHeader:  "All features, with:",
    features: [
      "5 TB pooled storage per person",
      "1,000-participant livestreaming",
      "S/MIME encryption",
      "Data Loss Prevention (DLP)",
      "Context-aware access policies",
      "Enterprise data regions",
      "Cloud Identity Premium",
      "Enhanced support for mission-critical issues",
    ],
  },
];


// ──────────────────────────────────────────────────────────────────────
// The page. The sections live in _parts/; this body keeps the one state they all read
// (plan, users, billing — and the checkout via useCheckout). No cart here.
// ──────────────────────────────────────────────────────────────────────
type BuyWorkspaceProps = Parameters<typeof BuyWorkspaceBody>[0];

export function BuyWorkspaceClient(props: BuyWorkspaceProps) {
  return <BuyWorkspaceBody {...props} />;
}

function BuyWorkspaceBody({
  catalogItems = [],
  paymentMode = "simulation",
  initialTierId,
  initialSeats,
  openBuy = false,
  brand = null,
  initialCoupon,
}: {
  /** R-1978: ?coupon=CODE on the buy link — filled in and checked on arrival. */
  initialCoupon?: string;
  /** R-120: edition and seats chosen on the home card (lib/checkout/buy-link.ts). */
  initialTierId?: string;
  initialSeats?: number;
  /** Arrived from a "Buy now" elsewhere (?buy=1): go straight to checkout. */
  openBuy?: boolean;
  /** Server-fetched, enabled Google Workspace SKUs from the reseller's Item
   *  Catalog. When empty, we fall back to the hardcoded FALLBACK_TIERS. */
  catalogItems?: CatalogItem[];
  /** "live": Razorpay configured, real money taken. "simulation": no Razorpay but a
   *  simulated checkout is allowed (non-prod) — TEST MODE bar. "disabled": production before
   *  Razorpay go-live — no online pay; the checkout sends a GST quote request instead. */
  paymentMode?: "live" | "simulation" | "disabled";
  /** R-1970: the website tenant's name, logo, GSTIN, address, phone (page.tsx). */
  brand?: BuyBrand | null;
} = {}) {
  const isSimulation = paymentMode === "simulation";
  const onlinePay = paymentMode !== "disabled";
  const TIERS = React.useMemo<Tier[]>(
    () => (catalogItems.length > 0 ? buildTiers(catalogItems) : FALLBACK_TIERS),
    [catalogItems],
  );
  const plans = React.useMemo(() => toBuyPlans(TIERS, isPublicPriceHiddenTier), [TIERS]);
  const monthlyOk = monthlyOffered(plans);
  const savePct = annualSavingPct(plans);
  const contact = buyContact(brand);

  const defaultId = plans.find((p) => p.popular && !p.priceHidden)?.id ?? plans[0]?.id ?? "standard";
  const [planId, setPlanId] = React.useState<BuyPlan["id"]>(
    plans.some((p) => p.id === initialTierId) ? (initialTierId as BuyPlan["id"]) : defaultId,
  );
  const [seats, setSeatsRaw] = React.useState<number>(clampSeats(initialSeats ?? 10));
  const setSeats = (n: number) => setSeatsRaw(clampSeats(n));
  const [billing, setBilling] = React.useState<Billing>("annual");
  const [compareOpen, setCompareOpen] = React.useState(false);
  const plan = plans.find((p) => p.id === planId) ?? plans[0];
  const sum = planSum(plan, seats, billing);

  /* Site promo (Online Promos) — the checkout route applies it to annual and monthly alike. */
  const sitePromo = useActiveSitePromo(plan.id, seats);
  const promoOff = sum ? computeSitePromoDiscount(sitePromo, sum.subtotal) : 0;
  const promoLabel = sitePromo ? `${sitePromo.headline} · online sale` : "";
  const heroPromo = sum && promoOff > 0 ? (() => {
    const t = orderTotals(sum.subtotal, promoOff, 0);
    return { label: `${promoLabel} · you save ${rupee(Math.round(promoOff * 1.18))}`, subtotal: t.taxable, gst: t.gst, total: t.total, was: sum.subtotal };
  })() : null;
  const promo = promoOff > 0 ? { label: promoLabel, off: promoOff } : null;

  const co = useCheckout({ planId: plan.id, seats, sum, promoOff, billing, canBuy: canPayOnline(plan, seats, sum, onlinePay) });

  const goCheckout = () => goTo("checkout", { instant: true });
  /* R-1975: every buy button (header Buy now, Continue to checkout, a plan's Choose, the phone
     bar) opens the PAY checkout — a trial started earlier must not keep the buyer in trial mode.
     Only "Start free trial" sets trial; the checkout's "Pay now instead" switches back. */
  const goPay = () => { co.setMode("pay"); window.setTimeout(goCheckout, 30); };
  /* R-1986 (Pardeep): each plan card keeps its OWN users count; the selected plan's card is the
     page's count. "Buy <plan>" takes that card's count into the checkout. */
  const [cardSeats, setCardSeats] = React.useState<Partial<Record<BuyPlan["id"], number>>>({});
  const seatsFor = (id: BuyPlan["id"]) => (id === planId ? seats : cardSeats[id] ?? seats);
  const onCardSeats = (id: BuyPlan["id"], n: number) => {
    if (id === planId) setSeats(n);
    else setCardSeats((m) => ({ ...m, [id]: clampSeats(n) }));
  };
  const choose = (id: BuyPlan["id"]) => {
    if (id !== planId) {
      const n = seatsFor(id);
      /* the plan left behind keeps the count it had */
      setCardSeats((m) => ({ ...m, [planId]: seats, [id]: undefined }));
      setSeats(n);
    }
    setPlanId(id);
    goPay();
  };
  const onNav = (id: string) => {
    if (id === "compare") { setCompareOpen(true); window.setTimeout(() => goTo("compare"), 30); return; }
    goTo(id);
  };
  const startTrial = () => {
    co.setMode("trial");
    if (plan.custom || plan.priceHidden) setPlanId("standard");
    window.setTimeout(goCheckout, 30);
  };

  /* R-1978: remember the ad this visit landed from (first touch, sessionStorage) — every order,
     trial and quote then sends it, whatever the address bar says later. */
  React.useEffect(() => { landingForForm(); }, []);

  /* R-1978: ?coupon=CODE — fill the box and check it once the basket has a price. */
  const couponTried = React.useRef(false);
  React.useEffect(() => {
    if (couponTried.current || !initialCoupon || !sum) return;
    couponTried.current = true;
    co.setCouponInput(initialCoupon);
    void co.applyCoupon(initialCoupon);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the price is known
  }, [initialCoupon, sum]);

  /* Arrived from a "Buy now" elsewhere (?buy=1): straight to checkout, once. */
  const arrived = React.useRef(false);
  React.useEffect(() => {
    if (arrived.current || !openBuy) return;
    arrived.current = true;
    window.setTimeout(goCheckout, 60);
  }, [openBuy]);

  const waMessage = plan.custom
    ? `Hi, I'd like a Google Workspace Enterprise quote for ${usersLabel(seats)}.`
    : `Hi, I'm looking at Google Workspace ${plan.name} for ${usersLabel(seats)}, ${billing}. Can you send a GST quote?`;

  const card = {
    plans, plan, onPick: setPlanId, seats, onSeats: setSeats, billing, onBilling: setBilling,
    monthlyOk, savePct, sum, promo: heroPromo,
    onContinue: goPay,
    onQuote: goPay,
  };
  const quoted = plan.custom || plan.priceHidden || !sum || seats > BUSINESS_MAX_USERS;
  const barTotal = quoted ? (plan.custom || seats > BUSINESS_MAX_USERS ? "Enterprise quote" : "GST quote") : rupee(co.totals?.total ?? 0);

  return (
    <div className="min-h-screen bg-paper text-ink pb-[76px] min-[820px]:pb-0">
      {isSimulation && <TestModeBar />}
      <SiteHeader brand={brand} contact={contact} onNav={onNav} onBuy={goPay} />
      {sitePromo && <SitePromoBanner promo={sitePromo} />}
      <main>
        <Hero card={card} onPlans={() => goTo("plans")} onTrial={startTrial} trialOk />
        <PlanCards
          plans={plans} selectedId={plan.id} seats={seats} billing={billing} onBilling={setBilling}
          monthlyOk={monthlyOk} savePct={savePct} onChoose={choose} contact={contact} seatsFor={seatsFor} onCardSeats={onCardSeats}
        />
        <CompareTable open={compareOpen} onToggle={() => setCompareOpen((o) => !o)} />
        <SamePrice plans={plans} plan={plan} billing={billing} brand={brand} />
        <WhyUs brand={brand}>
          <InvoicePreview plan={plan} seats={seats} billing={billing} sum={sum} promo={promo} co={co} brand={brand} />
        </WhyUs>
        <Checkout
          plan={plan} seats={seats} billing={billing} sum={sum} promo={promo} co={co}
          brand={brand} contact={contact} waMessage={waMessage}
          onlinePay={onlinePay} isSimulation={isSimulation}
          onChangePlan={() => goTo("plans")}
          onSeats={setSeats} onBilling={setBilling} monthlyOk={monthlyOk} savePct={savePct}
        />
        <AfterYouPay />
        <Faq brand={brand} />
        <SupportBand brand={brand} contact={contact} waMessage={waMessage} onQuote={goCheckout} />
      </main>
      <SiteFooter brand={brand} />
      <PhoneBar plan={plan} seats={seats} billing={billing} total={barTotal} inclGst={!quoted} onCheckout={goPay} />
    </div>
  );
}
