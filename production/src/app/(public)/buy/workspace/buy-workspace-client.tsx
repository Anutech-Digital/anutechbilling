"use client";

/**
 * Buy Google Workspace — public page (/buy/workspace).
 *
 * R-1970 (26 Oct 2026): Pardeep's design v2 — header, hero + "Your price" card, plan cards
 * (Annual / Monthly), compare, why us, checkout, after-you-pay, FAQ, talk-to-us band, footer.
 * The sections are in _parts/; this file keeps the page state, the catalogue → tier merge and
 * the Buy now / quote / trial dialogs (the inline checkout replaces them in R-1971).
 * No website cart on this page (DECISIONS 4) — the site cart stays for domains and hosting.
 */

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { describeError } from "@/lib/errors/toast-error";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { GST_STATE_BY_CODE } from "@/lib/utils";
import { isPublicPriceHiddenTier } from "@/lib/catalog/public-price-policy";
import { GST_STATE_OPTIONS } from "@/lib/gst/gstin-state";
import { tierAnnualPrice, annualTotals } from "./tier-price";
import { workspaceGstLabel } from "./gst-heads";
import { postJson, NOT_REACHED } from "./post-json";
import { checkCoupon, recheckCoupon, type AppliedCoupon } from "./coupon-check";
import { buyNowSchema,buyerCompany, BUY_ANNUAL_NOTE, type BuyNowForm } from "./buy-now-schema";
import { normalizeGstinInput } from "@/site/lib/checkout-details";
import type { SitePromoRow, SitePromoBannerStyle } from "@/lib/supabase/database.types";
import { thanksUrl } from "./thanks/thanks-url";
import { saveWorkspacePayment } from "./thanks/payment-handoff";
import { fromRazorpayHandler } from "@/lib/checkout/confirm-payment";
import { BusyPanel } from "@/components/ui/busy-panel";
import { useTurnstile } from "@/components/shared/turnstile";
import {
  COMPANY, SLA, WHATSAPP_NUMBER, WHATSAPP_READY,
} from "@/site/lib/config";
import { WORKSPACE_TRIAL_DAYS } from "@/lib/trials/trial-days";
import { rupee } from "@/lib/utils";
import { toBuyPlans, planSum, monthlyOffered, annualSavingPct, clampSeats, usersLabel, type Billing, type BuyPlan } from "./_parts/plans";
import { buyContact, type BuyBrand } from "./_parts/brand";
import { goTo } from "./_parts/wordmark";
import { SiteHeader } from "./_parts/site-header";
import { Hero } from "./_parts/hero";
import { PlanCards, CompareTable } from "./_parts/plan-cards";
import { WhyUs, AfterYouPay, Faq, SupportBand, SiteFooter, TestModeBar } from "./_parts/info-sections";
import { CheckoutSection, checkoutNext } from "./_parts/checkout-section";

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
    : `₹${promo.discount_value.toLocaleString("en-IN")} off`;

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
// Contact — from the site config, one place for the whole site (owner,
// 29 Sep 2026). This page used to carry Pardeep's personal number. While
// the site's WhatsApp number is still the placeholder, WHATSAPP_READY is
// false and the WhatsApp / call buttons are hidden: the "Email me a GST
// quote" form and the support email remain, and a dead button on the
// page's main action would lose the enquiry.
// ──────────────────────────────────────────────────────────────────────

function whatsappLink(message: string): string {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

/**
 * R-1137: a failed step on this public page — the server's sentence (raw DB text is
 * translated by describeError), why nothing happened, and a button to reach us.
 */
function buyFail(apiError: string | undefined, fallback: string, why: string): void {
  const d = describeError(apiError ? { message: apiError } : null, fallback);
  toast.error(d.message, {
    description: `${why} ${d.translated && d.description ? d.description : "Try again, or contact us and we'll finish it for you."}`,
    action: WHATSAPP_READY
      ? { label: "WhatsApp us", onClick: () => { window.open(whatsappLink(`Hi, I got "${d.message}" on the Google Workspace buy page.`), "_blank", "noopener,noreferrer"); } }
      : { label: "Email us", onClick: () => { window.location.href = `mailto:${COMPANY.supportEmail}?subject=${encodeURIComponent("Help with Google Workspace purchase")}`; } },
    duration: 10_000,
  });
}

/**
 * R-1110: our server was not reached (offline, timeout, a proxy's HTML 502). Say so, say what
 * did NOT happen, and offer the same step again — the form keeps everything typed.
 */
function notReached(nothingDone: string, retry: () => void): void {
  toast.error(NOT_REACHED, {
    description: `${nothingDone} Check your internet connection and try again.`,
    action: { label: "Try again", onClick: retry },
    duration: 15_000,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Pricing math — calculates annual cost incl GST for visitor's seat count,
// AND the rupee saving when a tier carries a real promo price. R-157 (5 Oct 2026): the
// hardcoded 20%-off promo for the first twenty users on Standard was removed — no such offer existed
// and the page charged the full rate anyway. Real sales come from Online Promos (site_promos).
// ──────────────────────────────────────────────────────────────────────
interface PriceCalc {
  annual:    number;   // pre-GST annual subscription
  gst:       number;   // 18%
  total:     number;   // annual + gst
  savings:   number;   // vs Google direct full-price (₹0 if no promo)
  perUserPm: number;   // effective ₹/user/month incl GST
  isCustom:  boolean;  // true for Enterprise — no calculator math
}

/**
 * Tier-agnostic price calculator. Uses the catalog's annual MSRP for the
 * selected tier — works for Starter, Standard, Plus, Enterprise, or any
 * future tier Pardeep adds. Enterprise (annualPrice = null) short-circuits
 * to "custom pricing".
 */
function calcForTier(tier: Tier, seats: number): PriceCalc {
  if (tier.annualPrice == null) {
    return { annual: 0, gst: 0, total: 0, savings: 0, perUserPm: 0, isCustom: true };
  }

  // Promo override (Standard's first-20 discount) when the tier carries one.
  const baseRate  = tier.promoPrice ?? tier.annualPrice;
  const { annual, gst, total } = annualTotals(seats, baseRate);   // R-276: the server's sum
  const perUserPm = seats > 0 ? Math.round(total / (seats * 12)) : 0;

  // Savings = (regular rate − promo rate) × seats × 12 × 1.18, if promo applies.
  let savings = 0;
  if (tier.promoPrice && tier.annualPrice > tier.promoPrice) {
    const savingsBase = seats * (tier.annualPrice - tier.promoPrice) * 12;
    savings = Math.round(savingsBase * 1.18);
  }

  return { annual, gst, total, savings, perUserPm, isCustom: false };
}

// ──────────────────────────────────────────────────────────────────────
// Google brand colors (hardcoded — these are the official Google palette)
// ──────────────────────────────────────────────────────────────────────
const G = {
  blue:   "#4285F4",
  red:    "#EA4335",
  yellow: "#FBBC04",
  green:  "#34A853",
  grey:   "#5F6368",
  ink:    "#1A1815",
  meet:   "#00897B",
} as const;

// Real Google product icon URLs — hosted on Wikimedia Commons (public assets).
// Official 2020-redesign brand marks. Used in the hero "Every plan includes" strip.
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
// Enquiry form schema
// ──────────────────────────────────────────────────────────────────────
const enquirySchema = z.object({
  fullName:    z.string().min(2, "Your name"),
  companyName: z.string().min(2, "Company name"),
  email:       z.string().email("Valid work email"),
  phone:       z.string().min(10, "10-digit phone"),
  seats:       z.coerce.number().int().min(1, "At least 1 seat").max(10000),
  tierId:      z.string(),
  billing:     z.enum(["monthly", "annual"]),
  message:     z.string().optional(),
  stateCode:   z.string().optional(), // GST place-of-supply (drives IGST vs CGST+SGST)
});
type EnquiryForm = z.infer<typeof enquirySchema>;

// ──────────────────────────────────────────────────────────────────────
// Inline components — ported from prototype
// ──────────────────────────────────────────────────────────────────────

/** Multi-color "Google Workspace" inline logotype. Inherits font size from parent. */
function GWInline() {
  return (
    <span className="whitespace-nowrap">
      <span style={{ color: G.blue }}>G</span>
      <span style={{ color: G.red }}>o</span>
      <span style={{ color: G.yellow }}>o</span>
      <span style={{ color: G.blue }}>g</span>
      <span style={{ color: G.green }}>l</span>
      <span style={{ color: G.red }}>e</span>{" "}
      <span style={{ color: G.grey, fontWeight: 400 }}>Workspace</span>
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────
// R-1970 (26 Oct 2026, Pardeep's design v2): the page itself. The sections live in _parts/;
// this body keeps the one state they all read (plan, users, billing) and the dialogs that
// still take the payment / quote / trial until the inline checkout (R-1971). No cart here.
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
}: {
  /** R-120: edition and seats chosen on the home card (lib/checkout/buy-link.ts). */
  initialTierId?: string;
  initialSeats?: number;
  /** Open the payment dialog on arrival — the card's "Buy now" meant buy, not browse. */
  openBuy?: boolean;
  /** Server-fetched, enabled Google Workspace SKUs from the reseller's Item
   *  Catalog. When empty, we fall back to the hardcoded FALLBACK_TIERS. */
  catalogItems?: CatalogItem[];
  /** "live": Razorpay configured, real money taken. "simulation": no Razorpay but a
   *  simulated checkout is allowed (non-prod) — TEST MODE bar. "disabled": production before
   *  Razorpay go-live — no online pay; every buy path is a GST quote. */
  paymentMode?: "live" | "simulation" | "disabled";
  /** R-1970: the website tenant's name, logo, GSTIN, address, phone (page.tsx). */
  brand?: BuyBrand | null;
} = {}) {
  const isSimulation = paymentMode === "simulation";
  const onlineBuyEnabled = paymentMode !== "disabled";
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

  /* The tier the dialogs take (they still speak Tier). Enterprise has no catalogue row. */
  const tierFor = (id: BuyPlan["id"]): Tier =>
    TIERS.find((t) => t.id === id) ?? FALLBACK_TIERS.find((t) => t.id === id) ?? TIERS[0];
  const [quoteTier, setQuoteTier] = React.useState<Tier | null>(null);
  const [trialOpen, setTrialOpen] = React.useState(false);
  const [buyNowTier, setBuyNowTier] = React.useState<Tier | null>(null);

  /* Site promo (Online Promos) — the server applies it to an annual order; shown on annual only. */
  const sitePromo = useActiveSitePromo(plan.id, seats);
  const promoOff = billing === "annual" && sum ? computeSitePromoDiscount(sitePromo, sum.subtotal) : 0;
  const promo = sum && promoOff > 0 && sitePromo ? (() => {
    const subtotal = Math.max(0, sum.subtotal - promoOff);
    const gst = Math.round(subtotal * 0.18);
    return { label: `${sitePromo.headline} · you save ${rupee(Math.round(promoOff * 1.18))}`, subtotal, gst, total: subtotal + gst, was: sum.subtotal };
  })() : null;

  const next = checkoutNext(plan, seats, billing, onlineBuyEnabled);
  const goCheckout = () => goTo("checkout");
  const quote = () => setQuoteTier(tierFor(next === "quote-enterprise" ? "enterprise" : plan.id));
  const pick = (id: BuyPlan["id"]) => setPlanId(id);
  const choose = (id: BuyPlan["id"]) => { setPlanId(id); window.setTimeout(goCheckout, 30); };
  const onNav = (id: string) => {
    if (id === "compare") { setCompareOpen(true); window.setTimeout(() => goTo("compare"), 30); return; }
    goTo(id);
  };

  /* Arrived from a "Buy now" elsewhere (?buy=1): open the payment dialog once on that edition —
     only when this page can take the payment; otherwise the quote form (R-157, no dead end). */
  const openedFromCard = React.useRef(false);
  React.useEffect(() => {
    if (openedFromCard.current || !openBuy) return;
    openedFromCard.current = true;
    const t = tierFor(planId);
    if (paymentMode === "disabled" || t.annualPrice == null) { setQuoteTier(t); return; }
    setBuyNowTier(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, [openBuy]);

  const waMessage = plan.custom
    ? `Hi, I'd like a Google Workspace Enterprise quote for ${usersLabel(seats)}.`
    : `Hi, I'm looking at Google Workspace ${plan.name} for ${usersLabel(seats)}, ${billing}. Can you send a GST quote?`;

  const card = {
    plans, plan, onPick: pick, seats, onSeats: setSeats, billing, onBilling: setBilling,
    monthlyOk, savePct, sum, promo,
    onContinue: goCheckout,
    onQuote: quote,
  };

  return (
    <div className="min-h-screen bg-paper text-ink">
      {isSimulation && <TestModeBar />}
      <SiteHeader brand={brand} contact={contact} onNav={onNav} onBuy={goCheckout} />
      {sitePromo && <SitePromoBanner promo={sitePromo} />}
      <main>
        <Hero card={card} onPlans={() => goTo("plans")} onTrial={() => setTrialOpen(true)} trialOk />
        <PlanCards
          plans={plans} selectedId={plan.id} seats={seats} billing={billing} onBilling={setBilling}
          monthlyOk={monthlyOk} savePct={savePct}
          onChoose={(id) => {
            const p = plans.find((x) => x.id === id);
            if (p && (p.custom || p.priceHidden)) { setPlanId(id); setQuoteTier(tierFor(id)); return; }
            choose(id);
          }}
        />
        <CompareTable open={compareOpen} onToggle={() => setCompareOpen((o) => !o)} />
        <WhyUs brand={brand} />
        <CheckoutSection
          plan={plan} seats={seats} billing={billing} sum={sum} promo={promo} next={next}
          onPay={() => setBuyNowTier(tierFor(plan.id))}
          onQuote={quote}
          onTrial={() => setTrialOpen(true)}
          trialOk
        />
        <AfterYouPay />
        <Faq brand={brand} />
        <SupportBand brand={brand} contact={contact} waMessage={waMessage} onQuote={quote} />
      </main>
      <SiteFooter brand={brand} />

      {quoteTier && (
        <EnquiryDialog
          tier={quoteTier}
          billing={billing}
          initialSeats={seats}
          paymentSoon={!onlineBuyEnabled}
          onClose={() => setQuoteTier(null)}
        />
      )}
      {trialOpen && (
        <TrialDialog tier={tierFor(plan.custom ? "standard" : plan.id)} initialSeats={seats} onClose={() => setTrialOpen(false)} />
      )}
      {buyNowTier && (
        <BuyNowDialog
          initialTier={buyNowTier}
          initialSeats={seats}
          allTiers={TIERS}
          isSimulation={isSimulation}
          sitePromo={sitePromo}
          onClose={() => setBuyNowTier(null)}
        />
      )}
    </div>
  );
}


// ──────────────────────────────────────────────────────────────────────
// Trial dialog — separate flow from the GST-quote enquiry.
// Lands at stage='trial' (qualified intent), free WORKSPACE_TRIAL_DAYS access, requires
// the customer's domain so we can provision in Google Reseller Console.
// ──────────────────────────────────────────────────────────────────────
const trialFormSchema = z.object({
  fullName:    z.string().min(2, "Your name"),
  companyName: z.string().min(2, "Company name"),
  email:       z.string().email("Valid work email"),
  phone:       z.string().min(10, "10-digit phone"),
  seats:       z.coerce.number().int().min(1).max(300),
  domain:      z.string().min(3, "Your business domain (e.g. acme.in)"),
  tierId:      z.string(),
  message:     z.string().optional(),
});
type TrialForm = z.infer<typeof trialFormSchema>;

function TrialDialog({
  tier, initialSeats, onClose,
}: {
  tier: Tier;
  initialSeats: number;
  onClose: () => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<TrialForm>({
    resolver: zodResolver(trialFormSchema),
    defaultValues: {
      tierId: tier.id,
      seats:  Math.min(initialSeats, 50),  // trials usually smaller — cap default at 50
    },
  });

  const ts = useTurnstile(); // R-737
  async function onSubmit(values: TrialForm) {
    const r = await postJson<{ success: boolean; error: string }>("/api/public/trial/workspace", values, ts.headers);
    if (!r.reached) {
      ts.reset();
      notReached("Your trial was not requested.", () => { void handleSubmit(onSubmit)(); });
      return;
    }
    const json = r.json;
    if (!r.ok || json.error) {
      ts.reset();
      buyFail(json.error, "Could not start the trial.", "Your trial was not requested yet.");
      return;
    }
    /* R-1116: the company answers, not one named person — and only promise WhatsApp when the
       site's WhatsApp number is live (WHATSAPP_READY). */
    toast.success(`Trial requested! Our team will ${WHATSAPP_READY ? "WhatsApp" : "call or email"} you ${SLA.firstReply}.`);
    onClose();
  }

  return (
    /* R-023: on ui/dialog (Radix) — focus stays inside, Esc closes, focus returns to the
       button that opened it. The hand-made overlay let Tab walk out into the page behind. */
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        hideClose
        resizable={false}
        aria-describedby={undefined}
        className="gap-0 p-0 md:p-0 md:!w-[min(28rem,calc(100vw-2rem))] border-2 border-emerald/30"
      >
        <div className="p-6">
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="text-3xs uppercase tracking-wider text-emerald mb-1 font-semibold inline-flex items-center gap-1.5">
                <Icon name="rocket" size={11} />
                {WORKSPACE_TRIAL_DAYS}-day free trial · no card needed
              </div>
              <DialogTitle className="font-serif text-2xl leading-tight">
                Try <GWInline /> free
              </DialogTitle>
              <p className="text-sm text-ink-3 mt-1">
                <span className="font-medium">{tier.name}</span> · {initialSeats} {initialSeats === 1 ? "user" : "users"}
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-ink-3 hover:text-ink transition-colors"
              aria-label="Close"
            >
              <Icon name="x" size={20} />
            </button>
          </div>

          {/* Trial promise band */}
          <div className="mb-5 p-3 rounded-lg bg-emerald-soft/40 border border-emerald/20 text-xs text-ink-2 leading-relaxed">
            <b className="text-ink">First call:</b> Our team {WHATSAPP_READY ? "WhatsApps" : "calls or emails"} you {SLA.firstReply} to verify
            domain. <br />
            <b className="text-ink">Live:</b> Your team is on Workspace {SLA.workspaceLive}.
            <br />
            <b className="text-ink">Day 12:</b> We check in re: convert / extend / cancel.
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <input type="hidden" {...register("tierId")} />

            <FormField label="Your name" required htmlFor="trial-fullName">
              <Input id="trial-fullName" placeholder="e.g. Rajesh Kumar" error={errors.fullName?.message} {...register("fullName")} />
            </FormField>

            <FormField label="Company" required htmlFor="trial-companyName">
              <Input id="trial-companyName" placeholder="e.g. Acme Pvt Ltd" error={errors.companyName?.message} {...register("companyName")} />
            </FormField>

            <FormField label="Your business domain" required htmlFor="trial-domain">
              <Input id="trial-domain" placeholder="e.g. acme.in" error={errors.domain?.message} {...register("domain")} />
              <p className="text-3xs text-ink-3 mt-1">
                We&apos;ll provision Workspace on this domain. You must own it (DNS access).
              </p>
            </FormField>

            <FormField label="Work email" required htmlFor="trial-email">
              <Input id="trial-email" type="email" placeholder="e.g. rajesh@acme.in" error={errors.email?.message} {...register("email")} />
            </FormField>

            <FormField label="Phone (we'll WhatsApp you)" required htmlFor="trial-phone">
              <Input id="trial-phone" type="tel" placeholder="e.g. +91 98765 43210" error={errors.phone?.message} {...register("phone")} />
            </FormField>

            <FormField label="How many users to start with?" required htmlFor="trial-seats">
              <Input id="trial-seats" type="number" min={1} max={300} error={errors.seats?.message} {...register("seats")} />
            </FormField>

            <FormField label="Anything else? (optional)" htmlFor="trial-message">
              <Input id="trial-message" placeholder="Migration from M365, urgent..." {...register("message")} />
            </FormField>

            <BusyPanel active={isSubmitting} title="Starting your Google Workspace trial" steps={["Saving your trial request", "Letting our team know, so we can set it up"]} />
            {ts.widget}
            <Button
              type="submit"
              variant="primary"
              className="w-full justify-center"
              style={{ background: "#10B981", borderColor: "#059669" }}
              loading={isSubmitting}
            >
              Start my {WORKSPACE_TRIAL_DAYS}-day trial
            </Button>

            <p className="text-2xs text-ink-3 text-center leading-relaxed">
              No credit card upfront. No auto-charge. Cancel anytime in {WORKSPACE_TRIAL_DAYS} days.
            </p>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EnquiryDialog({
  tier, billing, initialSeats, onClose, paymentSoon = false,
}: {
  tier: Tier;
  billing: "monthly" | "annual";
  initialSeats: number;
  onClose: () => void;
  /** R-1966: online payment is off on this site (before Razorpay go-live) — say so, with the way to buy today. */
  paymentSoon?: boolean;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EnquiryForm>({
    resolver: zodResolver(enquirySchema),
    defaultValues: { tierId: tier.id, billing, seats: initialSeats },
  });
  const ts = useTurnstile(); // R-020

  async function onSubmit(values: EnquiryForm) {
    // Derive the human-readable state name from the GST code so the lead (and the
    // customer it converts into) carries both — state_code drives IGST vs CGST+SGST.
    const stateCode = values.stateCode || undefined;
    const state     = stateCode ? `${GST_STATE_BY_CODE[stateCode]} (${stateCode})` : undefined;
    const r = await postJson<{ success: boolean; error: string }>("/api/public/enquiry/workspace", { ...values, stateCode, state }, ts.headers);
    if (!r.reached) {
      ts.reset();
      notReached("We did not receive your enquiry.", () => { void handleSubmit(onSubmit)(); });
      return;
    }
    const json = r.json;
    if (!r.ok || json.error) {
      ts.reset();
      buyFail(json.error, "Could not send your enquiry.", "We did not receive it yet.");
      return;
    }
    toast.success(`Got it! We'll call you ${SLA.firstReply}.`);
    onClose();
  }

  return (
    /* R-023: ui/dialog — focus trap, Esc, focus return (see TrialDialog). */
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        hideClose
        resizable={false}
        aria-describedby={undefined}
        className="gap-0 p-0 md:p-0 md:!w-[min(28rem,calc(100vw-2rem))]"
      >
        <div className="p-6">
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="text-3xs uppercase tracking-wider text-ink-3 mb-1 font-semibold">
                Quote request
              </div>
              <DialogTitle className="font-serif text-2xl leading-tight">
                <GWInline />
              </DialogTitle>
              <p className="text-sm text-ink-3 mt-1">
                <span className="font-medium">{tier.name}</span> · {billing}
              </p>
              {paymentSoon && (
                <p role="note" className="text-sm text-ink-2 mt-3 rounded-md bg-amber-soft/40 border border-amber/30 px-3 py-2">
                  Online payment opens soon. Send your details and we&apos;ll email your GST quote {SLA.quote}.
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-ink-3 hover:text-ink transition-colors"
              aria-label="Close"
            >
              <Icon name="x" size={20} />
            </button>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <input type="hidden" {...register("tierId")} />
            <input type="hidden" {...register("billing")} />

            <FormField label="Your name" required htmlFor="fullName">
              <Input id="fullName" placeholder="e.g. Rajesh Kumar" error={errors.fullName?.message} {...register("fullName")} />
            </FormField>

            <FormField label="Company" required htmlFor="companyName">
              <Input id="companyName" placeholder="e.g. Acme Pvt Ltd" error={errors.companyName?.message} {...register("companyName")} />
            </FormField>

            <FormField label="Work email" required htmlFor="email">
              <Input id="email" type="email" placeholder="e.g. rajesh@acme.in" error={errors.email?.message} {...register("email")} />
            </FormField>

            <FormField label="Phone" required htmlFor="phone">
              <Input id="phone" type="tel" placeholder="e.g. +91 98765 43210" error={errors.phone?.message} {...register("phone")} />
            </FormField>

            <FormField label="Your state (for GST invoice)" htmlFor="stateCode">
              <select
                id="stateCode"
                {...register("stateCode")}
                className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
              >
                <option value="">Select your state (optional)</option>
                {Object.entries(GST_STATE_BY_CODE)
                  .sort((a, b) => a[1].localeCompare(b[1]))
                  .map(([code, name]) => (
                    <option key={code} value={code}>{name} ({code})</option>
                  ))}
              </select>
            </FormField>

            <FormField label="How many users?" required htmlFor="seats">
              <Input id="seats" type="number" min={1} max={10000} error={errors.seats?.message} {...register("seats")} />
            </FormField>

            <FormField label="Anything else? (optional)" htmlFor="message">
              <Input id="message" placeholder="Migration from Microsoft 365, need help..." {...register("message")} />
            </FormField>

            <BusyPanel active={isSubmitting} title="Sending your enquiry" steps={["Sending your details to our team", "Preparing a GST quote for you"]} />
            {ts.widget}
            <Button
              type="submit"
              variant="primary"
              className="w-full justify-center"
              loading={isSubmitting}
            >
              Send enquiry
            </Button>

            <p className="text-2xs text-ink-3 text-center leading-relaxed">
              We'll call {SLA.firstReply} ({SLA.hours}). No spam.
            </p>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Razorpay Checkout JS — minimal typing for the global widget. The script
// is loaded on-demand the first time the BuyNow dialog opens.
// ──────────────────────────────────────────────────────────────────────
interface RazorpayCheckoutResponse {
  razorpay_payment_id: string;
  razorpay_order_id:   string;
  razorpay_signature:  string;
}
interface RazorpayCheckoutOptions {
  key:          string;
  amount:       number;      // paise
  currency:     string;
  name:         string;
  description?: string;
  order_id:     string;
  handler?:     (resp: RazorpayCheckoutResponse) => void;
  prefill?:     { name?: string; email?: string; contact?: string };
  notes?:       Record<string, string>;
  theme?:       { color?: string };
  modal?:       { ondismiss?: () => void; escape?: boolean };
}
interface RazorpayCheckoutInstance {
  open: () => void;
  on:   (event: "payment.failed", handler: (resp: { error: { description?: string } }) => void) => void;
}
type RazorpayCtor = new (options: RazorpayCheckoutOptions) => RazorpayCheckoutInstance;
declare global {
  interface Window {
    Razorpay?: RazorpayCtor;
  }
}

const RAZORPAY_CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

/** Lazy-load Razorpay Checkout JS. Resolves when window.Razorpay is ready. */
function loadRazorpayCheckout(): Promise<RazorpayCtor> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("Razorpay Checkout requires a browser"));
      return;
    }
    if (window.Razorpay) {
      resolve(window.Razorpay);
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_CHECKOUT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => {
        if (window.Razorpay) resolve(window.Razorpay);
        else reject(new Error("Razorpay loaded but global is missing"));
      });
      existing.addEventListener("error", () => reject(new Error("Razorpay script failed to load")));
      return;
    }
    const s   = document.createElement("script");
    s.src     = RAZORPAY_CHECKOUT_SRC;
    s.async   = true;
    s.onload  = () => {
      if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error("Razorpay loaded but global is missing"));
    };
    s.onerror = () => reject(new Error("Razorpay script failed to load"));
    document.body.appendChild(s);
  });
}

// ──────────────────────────────────────────────────────────────────────
// Buy now dialog — direct-buy via Razorpay
//   1. Visitor fills mini-form (name, company, email, phone, domain, GSTIN?)
//   2. We POST → /api/public/checkout/workspace which creates a lead + quote
//      + Razorpay Order and returns { orderId, razorpayKeyId, amount, ... }
//   3. We open the Razorpay Checkout widget pre-filled with their details
//   4. On success → success toast (webhook handles the DB flip + emails)
//   5. On failure / dismiss → error toast, can retry
// ──────────────────────────────────────────────────────────────────────
// Schema lives in ./buy-now-schema (R-226: tested on its own).

/* Coupon validation (AppliedCoupon, checkCoupon, recheckCoupon) lives in ./coupon-check (R-1630). */

interface CheckoutApiResponse {
  success?:        boolean;
  error?:          string;
  /** True when the server ran in simulation mode (Razorpay missing). When
   *  true, the client skips opening the Razorpay widget — the payment is
   *  already recorded server-side. */
  simulated?:      boolean;
  message?:        string;
  orderId?:        string;
  amount?:         number;   // paise
  currency?:       string;
  razorpayKeyId?:  string;
  quoteId?:        string;
  /** The quote's secret token. The thanks page shows the order only with it (S11). */
  publicToken?:    string;
  leadId?:         string;
  customerName?:   string;
  tierName?:       string;
  seats?:          number;
  totalRupees?:    number;
}

function BuyNowDialog({
  initialTier, initialSeats, allTiers, isSimulation = false, sitePromo = null, onClose,
}: {
  initialTier: Tier;
  initialSeats: number;
  /** Full tier list from the parent — so the visitor can switch tier inside
   *  the dialog without backing out. Enterprise (no fixed price) is filtered
   *  out internally; it always uses the GST-quote path. */
  allTiers: Tier[];
  /** True when Razorpay isn't configured. Skips loading + opening the
   *  Razorpay widget and instead POSTs `simulate:true` so the server walks
   *  the full lead/quote/record_payment pipeline without taking real money.*/
  isSimulation?: boolean;
  /** Active site-promo (online sale) — auto-applied. The server re-validates
   *  and re-applies independently at checkout time, but mirroring the math
   *  here keeps the visible total honest. */
  sitePromo?: SitePromoRow | null;
  onClose: () => void;
}) {
  // Only show tiers with a fixed annual price — Enterprise needs a custom
  // quote, so it can't go through Razorpay checkout.
  const buyableTiers = React.useMemo(
    () => allTiers.filter((t) => t.annualPrice != null),
    [allTiers],
  );

  // Local state — tier and seats live in the dialog so the calculator can
  // update in real-time as the visitor experiments. RHF mirrors them via
  // hidden inputs at submit time.
  const [tierId, setTierId] = React.useState<string>(initialTier.id);
  const tier = buyableTiers.find((t) => t.id === tierId) ?? initialTier;

  const [seats, setSeats] = React.useState<number>(Math.max(1, initialSeats));
  const calc = React.useMemo(() => calcForTier(tier, seats), [tier, seats]);

  // Coupon state — owned locally, re-checked if visitor edits tier/seats
  // (R-1630; server re-validates at checkout anyway).
  const [couponInput,    setCouponInput]    = React.useState("");
  const [couponApplied,  setCouponApplied]  = React.useState<AppliedCoupon | null>(null);
  const [couponError,    setCouponError]    = React.useState<string | null>(null);
  const [validatingCoupon, setValidatingCoupon] = React.useState(false);
  /* R-023: true while Razorpay's window is open — the dialog steps aside (see the return). */
  const [rzpOpen, setRzpOpen] = React.useState(false);
  const ts = useTurnstile(); // R-737: the checkout POST carries the bot-check token

  // Pre-promo subtotal + discount line — needed for the breakdown card.
  // (calc.annual is the post-promo pre-GST subtotal, calc.savings is the
  //  savings × 1.18 — but we want the pre-GST discount value for the line.)
  const annualPrice  = tier.annualPrice ?? 0;
  const promoPrice   = tier.promoPrice  ?? null;
  const grossSubtot  = seats * annualPrice * 12;
  const promoDiscPre = promoPrice ? seats * (annualPrice - promoPrice) * 12 : 0;
  const monthlyRate  = promoPrice ?? annualPrice;

  // Stacking order (mirror server-side):
  //   calc.annual  = pre-GST subtotal AFTER Google promo
  //   − sitePromoOff (auto-applied online sale)
  //   − couponPreGstOff (visitor-entered code)
  //   = postPromoSubtot
  //   + 18% GST recomputed on the final discounted subtotal
  const sitePromoOff =
    sitePromo && calc.annual > 0
      ? Math.min(
          sitePromo.discount_type === "percent"
            ? Math.round(calc.annual * sitePromo.discount_value / 100)
            : sitePromo.discount_value,
          calc.annual,
        )
      : 0;
  const postSitePromoSubtot = Math.max(0, calc.annual - sitePromoOff);
  const couponPreGstOff   = couponApplied ? Math.min(couponApplied.discount, postSitePromoSubtot) : 0;
  const postCouponSubtot  = Math.max(0, postSitePromoSubtot - couponPreGstOff);
  const recomputedGst     = Math.round(postCouponSubtot * 0.18);
  const finalTotal        = postCouponSubtot + recomputedGst;
  const anyDiscount       = sitePromoOff > 0 || couponPreGstOff > 0;
  const totalToPay        = anyDiscount ? finalTotal : calc.total;

  /* R-1630: when tier or seats change, check the applied code again for the new basket
     (the discount depends on gross_amount). Still valid → it stays with the new discount;
     not valid → removed, and the error line under the code box says why. It used to be
     cleared silently, so the discount vanished from the total with no word.
     Waits 400 ms so clicking "+" five times asks once; a newer change wins (seq). */
  const recheckSeq = React.useRef(0);
  React.useEffect(() => {
    if (!couponApplied) return;
    const seq = ++recheckSeq.current;
    const t = setTimeout(async () => {
      setValidatingCoupon(true);
      const next = await recheckCoupon(couponApplied, {
        code: couponApplied.code, tier: tier.id, seats, gross_amount: postSitePromoSubtot,
      });
      if (seq !== recheckSeq.current) return;
      setCouponApplied(next.applied);
      setCouponError(next.error);
      if (!next.applied) setCouponInput(couponApplied.code); // the code stays in the box to re-apply
      setValidatingCoupon(false);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierId, seats]);

  async function applyCoupon() {
    const code = couponInput.trim().toUpperCase();
    if (code.length < 2) {
      setCouponError("Enter a code first");
      return;
    }
    recheckSeq.current++; // an explicit Apply overrides a pending re-check
    setValidatingCoupon(true);
    setCouponError(null);
    try {
      const r = await checkCoupon({
        code,
        tier:         tier.id,
        seats,
        gross_amount: postSitePromoSubtot,  // stacks BELOW site promo
      });
      if (!r.ok) {
        setCouponError(r.message);
        setCouponApplied(null);
        return;
      }
      setCouponApplied(r.coupon);
      setCouponError(null);
    } catch {
      setCouponError("Network error — try again");
    } finally {
      setValidatingCoupon(false);
    }
  }

  function removeCoupon() {
    recheckSeq.current++; // a pending re-check must not put it back
    setValidatingCoupon(false);
    setCouponApplied(null);
    setCouponInput("");
    setCouponError(null);
  }

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<BuyNowForm>({
    resolver: zodResolver(buyNowSchema),
    defaultValues: {
      tierId: initialTier.id,
      seats:  Math.max(1, initialSeats),
    },
  });

  // Keep RHF in sync with the calculator state — hidden inputs only render
  // the value, they don't react to setState, so we push values explicitly.
  React.useEffect(() => { setValue("tierId", tierId); }, [tierId, setValue]);
  React.useEffect(() => { setValue("seats",  seats);  }, [seats,  setValue]);

  function decSeats() { setSeats((s) => Math.max(1,     s - 1)); }
  function incSeats() { setSeats((s) => Math.min(10000, s + 1)); }

  async function onSubmit(values: BuyNowForm) {
    // Use the calculator state (not the form's stale copy) — the visitor
    // might have changed tier/seats after the form first rendered. In sim
    // mode we also push `simulate:true` so the server records the payment
    // directly instead of creating a Razorpay Order.
    const payload = {
      ...values,
      companyName: buyerCompany(values),   // R-232: optional; blank → buyer name
      tierId,
      seats,
      simulate:   isSimulation,
      couponCode: couponApplied?.code ?? undefined,
    };

    const r = await postJson<CheckoutApiResponse>("/api/public/checkout/workspace", payload, ts.headers);
    ts.reset(); // R-737: a token works once — the next try (or a retry after Razorpay) needs a fresh one
    if (!r.reached) {
      notReached("No money was taken.", () => { void handleSubmit(onSubmit)(); });
      return;
    }
    const json = r.json;
    if (!r.ok || json.error) {
      buyFail(json.error, "Could not start checkout.", "No money was taken.");
      return;
    }

    // ── Simulation: the server has already marked the quote paid, created
    //    the customer, sent test emails. Redirect to the thanks page so the
    //    visitor gets the full confirmation experience.
    if (isSimulation || json.simulated) {
      window.location.href = thanksUrl(json.quoteId, json.publicToken, true);
      return;
    }

    // ── Live: open the Razorpay Checkout widget with the server's order.
    if (!json.orderId || !json.razorpayKeyId || !json.amount) {
      buyFail(undefined, "Could not open the payment window.", "No money was taken — our server did not send the payment details.");
      return;
    }

    let RazorpayCtor: RazorpayCtor;
    try {
      RazorpayCtor = await loadRazorpayCheckout();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[buy-workspace] Razorpay load failed", err);
      buyFail(undefined, "Could not load the payment window.", "No money was taken. Check your internet connection and press Pay again.");
      return;
    }

    const rzp = new RazorpayCtor({
      key:         json.razorpayKeyId,
      amount:      json.amount,
      currency:    json.currency ?? "INR",
      name:        "ANUTECH DIGITAL PVT LTD",
      description: `Google Workspace ${json.tierName ?? tier.name} · ${json.seats ?? seats} users (annual)`,
      order_id:    json.orderId,
      prefill: {
        name:    values.fullName,
        email:   values.email,
        contact: values.phone,
      },
      notes: {
        quoteId: json.quoteId ?? "",
        leadId:  json.leadId  ?? "",
        domain:  values.domain,
      },
      /* R-1116: the storefront blue — the same value as site.css --primary and the /checkout
         Razorpay window (Razorpay takes a hex, not a CSS variable). Was orange #C2410C. */
      theme: { color: "#1668E3" },
      handler: (resp) => {
        // R-1625: Razorpay hands the browser {order, payment, signature}. Keep them for THIS
        // order; the thanks page asks our server to confirm the payment (the R-1596 verify path,
        // idempotent with the webhook) instead of waiting on the webhook and saying "not found".
        saveWorkspacePayment(json.quoteId, fromRazorpayHandler(resp));
        window.location.href = thanksUrl(json.quoteId, json.publicToken, false);
      },
      modal: {
        ondismiss: () => {
          setRzpOpen(false);
          toast.message("Payment cancelled. We've saved your quote — our team will follow up.");
        },
        escape: true,
      },
    });
    rzp.on("payment.failed", (resp) => {
      buyFail(undefined, `Payment failed${resp.error?.description ? `: ${resp.error.description}` : "."}`, "No money was taken.");
    });
    setRzpOpen(true);
    rzp.open();
  }

  // Quick-pick seat presets — covers the most common SME orders without
  // making the visitor mash +/− 25 times.
  const SEAT_PRESETS = [5, 10, 25, 50, 100, 250];

  return (
    /* R-023: ui/dialog — focus trap, Esc, focus return. While Razorpay's own window is up
       this dialog steps aside (rzpOpen): a Radix modal blocks pointer events and focus
       outside itself, and Razorpay's window lives outside it — the visitor could not have
       typed a UPI id. Form values survive (react-hook-form keeps them; tier, seats and
       coupon are this component's state), so dismissing Razorpay brings the form back filled. */
    <Dialog open={!rzpOpen} onOpenChange={(o) => { if (!o && !rzpOpen) onClose(); }}>
      <DialogContent
        hideClose
        resizable={false}
        aria-describedby={undefined}
        className="gap-0 p-0 md:p-0 md:!max-w-4xl md:!w-[min(56rem,calc(100vw-2rem))] border-2 border-amber/30 shadow-2xl"
      >
        {/* Sticky header — survives the long form scroll on mobile */}
        <div className="sticky top-0 z-10 bg-paper border-b border-hairline px-5 sm:px-6 py-4 flex items-start justify-between rounded-t-xl">
          <div>
            {isSimulation ? (
              <div className="text-3xs uppercase tracking-wider mb-1 font-semibold inline-flex items-center gap-1.5"
                   style={{ color: "#7C2D12" }}>
                <span aria-hidden>🧪</span> Test mode · simulated payment · no real money
              </div>
            ) : (
              <div className="text-3xs uppercase tracking-wider text-amber-ink mb-1 font-semibold inline-flex items-center gap-1.5">
                <Icon name="zap" size={11} />
                Instant checkout · UPI / Card / NetBanking
              </div>
            )}
            <DialogTitle className="font-serif text-2xl leading-tight">
              Buy <GWInline />
            </DialogTitle>
            <p className="text-xs text-ink-3 mt-0.5">
              {isSimulation
                ? "Walks the full pipeline (lead → quote → customer + emails) without taking real money."
                : "Configure your plan on the left, fill your details on the right."}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-ink-3 hover:text-ink transition-colors mt-1"
            aria-label="Close"
          >
            <Icon name="x" size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="grid grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
          {/* ═══════════════════════════════════════════════════════════════
              LEFT  — Calculator: tier picker + seat stepper + price breakdown
              ═══════════════════════════════════════════════════════════════ */}
          <div className="p-5 sm:p-6 lg:border-r border-hairline bg-paper-2/30 space-y-5">

            {/* Tier picker */}
            {buyableTiers.length > 1 && (
              <div>
                <p id="buy-plan-label" className="text-2xs uppercase tracking-wider text-ink-3 font-semibold block mb-2">
                  1 · Choose your plan
                </p>
                <div
                  role="group"
                  aria-labelledby="buy-plan-label"
                  className="grid gap-1.5 p-1 rounded-lg bg-paper border border-hairline"
                  style={{ gridTemplateColumns: `repeat(${buyableTiers.length}, minmax(0, 1fr))` }}
                >
                  {buyableTiers.map((t) => {
                    const active = tierId === t.id;
                    const pricePm = t.promoPrice ?? t.annualPrice ?? 0;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setTierId(t.id)}
                        className={`px-2 py-2.5 rounded-md text-xs font-medium transition-colors ${
                          active
                            ? "bg-amber text-paper shadow-sm"
                            : "text-ink-3 hover:text-ink hover:bg-paper-2"
                        }`}
                      >
                        <div className="font-serif text-sm leading-tight">
                          {t.name.replace(/^Business\s+/i, "")}
                        </div>
                        <div className={`text-3xs mt-0.5 ${active ? "text-paper/85" : "text-ink-3"}`}>
                          ₹{pricePm.toLocaleString("en-IN")}/user/mo
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Seat stepper */}
            <div>
              <label htmlFor="buy-seats" className="text-2xs uppercase tracking-wider text-ink-3 font-semibold block mb-2">
                {buyableTiers.length > 1 ? "2 · " : ""}How many users?
              </label>

              <div className="flex items-stretch gap-2">
                <button
                  type="button"
                  onClick={decSeats}
                  aria-label="Decrease users"
                  className="w-14 h-14 rounded-lg border border-hairline bg-paper hover:bg-paper-2 grid place-items-center text-2xl font-serif text-ink transition-colors active:scale-95 disabled:opacity-40"
                  disabled={seats <= 1}
                >
                  −
                </button>
                <input
                  id="buy-seats"
                  type="number"
                  min={1}
                  max={10000}
                  value={seats}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (e.target.value === "") { setSeats(1); return; }
                    if (Number.isFinite(n)) setSeats(Math.min(10000, Math.max(1, Math.round(n))));
                  }}
                  className="flex-1 text-center font-serif text-3xl bg-paper border border-hairline rounded-lg text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                  aria-label="Number of users"
                />
                <button
                  type="button"
                  onClick={incSeats}
                  aria-label="Increase users"
                  className="w-14 h-14 rounded-lg border border-hairline bg-paper hover:bg-paper-2 grid place-items-center transition-colors active:scale-95"
                >
                  <Icon name="plus" size={18} />
                </button>
              </div>

              {/* Quick-pick chips */}
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {SEAT_PRESETS.map((n) => {
                  const active = seats === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setSeats(n)}
                      className={`text-2xs px-2.5 py-1 rounded-full border transition-colors ${
                        active
                          ? "border-amber bg-amber-soft text-amber-ink font-semibold"
                          : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2"
                      }`}
                    >
                      {n} users
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Price breakdown card */}
            <div className="p-4 rounded-xl bg-paper border border-hairline">
              <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-3">
                Price breakdown
              </div>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="text-ink-2">
                    {seats} {seats === 1 ? "user" : "users"} × ₹{annualPrice.toLocaleString("en-IN")}/mo × 12 mo
                  </span>
                  <span className="font-mono text-ink whitespace-nowrap">
                    ₹{grossSubtot.toLocaleString("en-IN")}
                  </span>
                </div>
                {promoDiscPre > 0 && (
                  <div className="flex justify-between gap-2 text-emerald">
                    <span>
                      Promo discount ({Math.round((promoDiscPre / grossSubtot) * 100)}% off · ₹{monthlyRate.toLocaleString("en-IN")}/mo)
                    </span>
                    <span className="font-mono whitespace-nowrap">
                      − ₹{promoDiscPre.toLocaleString("en-IN")}
                    </span>
                  </div>
                )}
                <div className="border-t border-hairline pt-1.5 flex justify-between gap-2 text-ink-2">
                  <span>Subtotal (pre-GST)</span>
                  <span className="font-mono whitespace-nowrap">₹{calc.annual.toLocaleString("en-IN")}</span>
                </div>
                {sitePromo && sitePromoOff > 0 && (
                  <div className="flex justify-between gap-2 text-amber-ink">
                    <span className="inline-flex items-center gap-1">
                      <Icon name="zap" size={11} />
                      {sitePromo.discount_type === "percent"
                        ? `Online sale (${sitePromo.discount_value}% off)`
                        : `Online sale (₹${sitePromo.discount_value} off)`}
                    </span>
                    <span className="font-mono whitespace-nowrap">
                      − ₹{sitePromoOff.toLocaleString("en-IN")}
                    </span>
                  </div>
                )}
                {couponApplied && couponPreGstOff > 0 && (
                  <div className="flex justify-between gap-2 text-amber-ink">
                    <span>
                      Coupon <span className="font-mono">{couponApplied.code}</span>
                      {couponApplied.discount_type === "percent"
                        ? ` (${couponApplied.discount_value}% off)`
                        : ""}
                    </span>
                    <span className="font-mono whitespace-nowrap">
                      − ₹{couponPreGstOff.toLocaleString("en-IN")}
                    </span>
                  </div>
                )}
                <div className="flex justify-between gap-2 text-ink-2">
                  {/* R-1109: the head follows the place of supply — IGST outside Delhi. */}
                  <span>+ {workspaceGstLabel({ stateCode: watch("stateCode"), gstin: watch("gstin") })}</span>
                  <span className="font-mono whitespace-nowrap">
                    ₹{(anyDiscount ? recomputedGst : calc.gst).toLocaleString("en-IN")}
                  </span>
                </div>
                <div className="border-t-2 border-ink mt-1 pt-2 flex items-baseline justify-between gap-2">
                  <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Total to pay</span>
                  <span className="font-serif text-2xl text-ink whitespace-nowrap">
                    ₹{totalToPay.toLocaleString("en-IN")}
                  </span>
                </div>
              </div>

              {calc.savings > 0 && (
                <div className="mt-3 px-3 py-2 rounded-lg bg-emerald-soft/40 border border-emerald/20 text-xs text-ink-2 inline-flex items-center gap-1.5">
                  <Icon name="trending_up" size={12} className="text-emerald" />
                  You save <b className="text-emerald">₹{calc.savings.toLocaleString("en-IN")}</b> vs Google direct
                </div>
              )}
            </div>

            {/* Coupon code — separate from the Google promo, applied pre-GST.
                Validation hits /api/public/coupons/validate (dry-run); actual
                redemption only happens at checkout. */}
            <div className="p-3 rounded-xl border border-dashed border-hairline bg-paper/60">
              <label htmlFor="buy-coupon" className="text-2xs uppercase tracking-wider text-ink-3 font-semibold block mb-1.5 inline-flex items-center gap-1.5">
                <Icon name="rupee" size={11} /> Have a coupon code?
              </label>
              {couponApplied ? (
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-soft border border-amber/30 text-amber-ink text-xs font-semibold">
                      <Icon name="check_circle" size={11} />
                      <span className="font-mono">{couponApplied.code}</span> applied
                    </span>
                    <span className="text-2xs text-ink-3">
                      Saving ₹{couponPreGstOff.toLocaleString("en-IN")} pre-GST
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={removeCoupon}
                    className="text-2xs text-ink-3 hover:text-rose underline-offset-2 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-stretch gap-2">
                    <input
                      id="buy-coupon"
                      type="text"
                      value={couponInput}
                      onChange={(e) => {
                        setCouponInput(e.target.value.toUpperCase());
                        if (couponError) setCouponError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          applyCoupon();
                        }
                      }}
                      placeholder="e.g. SAVE10"
                      maxLength={50}
                      className="flex-1 bg-paper border border-hairline rounded-md px-3 py-2 text-sm font-mono uppercase placeholder:text-ink-4 placeholder:normal-case focus:outline-none focus:ring-2 focus:ring-amber/40"
                    />
                    <button
                      type="button"
                      onClick={applyCoupon}
                      disabled={validatingCoupon || couponInput.trim().length < 2}
                      className="px-4 rounded-md bg-ink text-paper text-sm font-medium hover:bg-ink/90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {validatingCoupon ? "Checking…" : "Apply"}
                    </button>
                  </div>
                  {couponError && (
                    <p className="text-2xs text-rose mt-1.5 inline-flex items-center gap-1">
                      <Icon name="alert" size={11} /> {couponError}
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Trust strip */}
            <div className="text-2xs text-ink-3 flex flex-wrap gap-x-3 gap-y-1.5">
              <span className="inline-flex items-center gap-1">
                <Icon name="check" size={11} className="text-emerald" /> GST tax invoice
              </span>
              <span className="inline-flex items-center gap-1">
                <Icon name="check" size={11} className="text-emerald" /> Add users any time
              </span>
              <span className="inline-flex items-center gap-1">
                <Icon name="check" size={11} className="text-emerald" /> Migration help included
              </span>
            </div>
          </div>

          {/* ═══════════════════════════════════════════════════════════════
              RIGHT — Contact form + big Pay button
              ═══════════════════════════════════════════════════════════════ */}
          <div className="p-5 sm:p-6 space-y-4">
            <div>
              <h3 className="font-serif text-lg leading-tight mb-0.5">
                {buyableTiers.length > 1 ? "3 · " : ""}Your details
              </h3>
              <p className="text-xs text-ink-3">
                For the GST tax invoice + Workspace admin access.
              </p>
            </div>

            <input type="hidden" {...register("tierId")} />
            <input type="hidden" {...register("seats")} />

            <FormField label="Your name" required htmlFor="buy-fullName">
              <Input id="buy-fullName" placeholder="e.g. Rajesh Kumar" autoComplete="name"
                error={errors.fullName?.message} {...register("fullName")} />
            </FormField>

            <FormField label="Company (optional)" htmlFor="buy-companyName">
              <Input id="buy-companyName" placeholder="e.g. Acme Pvt Ltd" autoComplete="organization"
                error={errors.companyName?.message} {...register("companyName")} />
            </FormField>

            <FormField label="Your business domain" required htmlFor="buy-domain">
              <Input id="buy-domain" placeholder="e.g. acme.in"
                error={errors.domain?.message} {...register("domain")} />
              <p className="text-3xs text-ink-3 mt-1">
                We&apos;ll provision Workspace on this domain. You must own it (DNS access).
              </p>
            </FormField>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label="Work email" required htmlFor="buy-email">
                <Input id="buy-email" type="email" placeholder="e.g. rajesh@acme.in" autoComplete="email" inputMode="email"
                  error={errors.email?.message} {...register("email")} />
              </FormField>
              <FormField label="Phone (WhatsApp)" required htmlFor="buy-phone">
                <Input id="buy-phone" type="tel" placeholder="e.g. +91 98765 43210" autoComplete="tel" inputMode="tel"
                  error={errors.phone?.message} {...register("phone")} />
              </FormField>
            </div>

            <FormField label="GSTIN (optional)" htmlFor="buy-gstin">
              <Input
                id="buy-gstin"
                placeholder="e.g. 27ABCDE1234F1Z5"
                maxLength={15}
                autoCapitalize="characters"
                className="uppercase font-mono"
                aria-invalid={!!errors.gstin || undefined}
                aria-describedby={errors.gstin ? "buy-gstin-error" : undefined}
                {...register("gstin", { setValueAs: (v: string) => normalizeGstinInput(v ?? "") })}
              />
              {errors.gstin?.message && <p id="buy-gstin-error" role="alert" className="text-xs text-rose mt-1">{errors.gstin.message}</p>}
              <p className="text-3xs text-ink-3 mt-1">
                Add your GSTIN to claim input tax credit. Skip if not GST-registered.
              </p>
            </FormField>

            {/* R-173 (6 Oct 2026): this form had no state at all, so every buyer without a
                GSTIN became a customer whose GST invoice was refused ("no state on record").
                Required unless a valid GSTIN gives the state. */}
            <FormField label="Your state (for the GST invoice)" required htmlFor="buy-state">
              <select
                id="buy-state"
                aria-invalid={!!errors.stateCode}
                {...register("stateCode")}
                className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
              >
                <option value="">Select your state</option>
                {GST_STATE_OPTIONS.map((o) => (
                  <option key={o.code} value={o.code}>{o.name}</option>
                ))}
              </select>
              {errors.stateCode?.message && <p className="text-xs text-rose mt-1">{errors.stateCode.message}</p>}
            </FormField>

            {/* R-226: annual licence, no mid-term cancel — said before Pay, and the terms /
                refund box must be ticked (schema blocks submit, so Razorpay never opens). */}
            <p className="text-xs text-ink-2 rounded-md border border-hairline bg-paper-2 px-3 py-2">
              {BUY_ANNUAL_NOTE}
            </p>
            <div className="flex items-start gap-2.5">
              <input
                id="buy-agree-terms"
                type="checkbox"
                aria-invalid={!!errors.agreeTerms || undefined}
                aria-describedby={errors.agreeTerms ? "buy-agree-terms-error" : undefined}
                {...register("agreeTerms")}
                className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-amber"
              />
              <label htmlFor="buy-agree-terms" className="text-xs text-ink-2 cursor-pointer leading-relaxed">
                I have read the{" "}
                <a href="/terms-and-conditions" target="_blank" rel="noopener" className="font-semibold text-amber-ink underline">terms and conditions</a>{" "}
                and the{" "}
                <a href="/refund" target="_blank" rel="noopener" className="font-semibold text-amber-ink underline">refund policy</a>.
              </label>
            </div>
            {errors.agreeTerms?.message && (
              <p id="buy-agree-terms-error" role="alert" className="text-xs text-rose -mt-2">{errors.agreeTerms.message}</p>
            )}

            <BusyPanel active={isSubmitting} title="Preparing your secure payment" steps={["Re-checking the price on our server", "Creating your order", "Opening the Razorpay payment window"]} />
            {ts.widget}
            <Button
              type="submit"
              variant="primary"
              className="w-full justify-center text-base h-12"
              loading={isSubmitting}
            >
              <Icon name="zap" size={15} className="mr-1.5" />
              {isSimulation
                ? `Simulate payment · ₹${totalToPay.toLocaleString("en-IN")}`
                : `Pay ₹${totalToPay.toLocaleString("en-IN")} securely`}
            </Button>

            <p className="text-2xs text-ink-3 text-center leading-relaxed">
              {isSimulation ? (
                <>
                  <b>Test mode</b> · Razorpay isn&apos;t configured yet.<br />
                  Submission creates a real quote + customer + payment row tagged
                  <code className="font-mono"> [SIMULATION]</code> so you can preview the pipeline.
                </>
              ) : (
                <>
                  Powered by Razorpay · UPI · Cards · NetBanking · EMI<br />
                  Your GST tax invoice comes with the payment confirmation email.
                </>
              )}
            </p>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
