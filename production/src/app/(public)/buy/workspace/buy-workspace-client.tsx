"use client";

/**
 * Buy Google Workspace — public landing page.
 * Ported from prototype/screens/buy-workspace-v2.jsx (1458 lines).
 *
 * Faithful to the prototype visual design:
 * - Multi-color "Google Workspace" inline logo (4-color G+o+o+g+l+e + grey Workspace)
 * - Premier Partner circular badge with golden glow ring
 * - Hero with floating Google app icons (Gmail, Drive, Meet, Calendar, Chat, Docs, Gemini)
 * - 3-tier pricing cards (Starter, Standard, Enterprise) with Indian CSP rates
 * - Comparison table — Productivity, AI, Security categories
 * - Trust signals + GST/IRP compliance notice
 * - Lead-capture enquiry form
 */

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { GST_STATE_BY_CODE } from "@/lib/utils";
import type { SitePromoRow, SitePromoBannerStyle } from "@/lib/supabase/database.types";

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
          <span className="text-[10px] uppercase tracking-wider font-semibold bg-paper/20 backdrop-blur px-2 py-0.5 rounded-full whitespace-nowrap">
            {promo.badge_text}
          </span>
        )}
        <span className="font-medium">{promo.headline}</span>
        {promo.subheadline && (
          <span className="opacity-90 hidden md:inline">· {promo.subheadline}</span>
        )}
        <span className="font-mono text-[11px] bg-paper text-ink px-2 py-0.5 rounded font-semibold whitespace-nowrap">
          {off}
        </span>
        {remaining && (
          <span className="inline-flex items-center gap-1 font-mono text-[11px] bg-ink/30 backdrop-blur px-2 py-0.5 rounded whitespace-nowrap">
            <span aria-hidden>⏱</span> {remaining}
          </span>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Pardeep / Excel Tech contact constants — used everywhere we link to
// WhatsApp or phone. Single source of truth.
// ──────────────────────────────────────────────────────────────────────
const PARDEEP_PHONE         = "9999930300";              // raw, for tel: + wa.me
const PARDEEP_PHONE_E164    = "919999930300";            // country code + number
const PARDEEP_PHONE_DISPLAY = "+91 99999 30300";         // shown to humans

function whatsappLink(message: string): string {
  return `https://wa.me/${PARDEEP_PHONE_E164}?text=${encodeURIComponent(message)}`;
}

// ──────────────────────────────────────────────────────────────────────
// Pricing math — calculates annual cost incl GST for visitor's seat count,
// AND the rupee saving vs buying from Google direct (Google charges full
// ₹1080/user — we have a 20% promo for first 20 users on Standard).
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
  const annual    = seats * baseRate * 12;
  const gst       = Math.round(annual * 0.18);
  const total     = annual + gst;
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
const GOOGLE_ICONS = {
  gmail:    "https://upload.wikimedia.org/wikipedia/commons/7/7e/Gmail_icon_%282020%29.svg",
  calendar: "https://upload.wikimedia.org/wikipedia/commons/a/a5/Google_Calendar_icon_%282020%29.svg",
  drive:    "https://upload.wikimedia.org/wikipedia/commons/1/12/Google_Drive_icon_%282020%29.svg",
  meet:     "https://upload.wikimedia.org/wikipedia/commons/9/9b/Google_Meet_icon_%282020%29.svg",
} as const;

/** Google Docs 2020 logo — inline SVG (Wikimedia URL was unreliable for this one). */
function DocsLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 47 65" xmlns="http://www.w3.org/2000/svg" className={className} aria-label="Google Docs">
      <path d="M29.375 0H4.4063C1.9836 0 0 1.9836 0 4.4063V60.5937C0 63.0164 1.9836 65 4.4063 65H42.5937C45.0164 65 47 63.0164 47 60.5937V17.625L36.7188 11.0156L29.375 0Z" fill="#4285F4"/>
      <path d="M30.6133 16.3367L47 32.7234V17.625L30.6133 16.3367Z" fill="#1967D2"/>
      <path d="M29.375 0V13.2188C29.375 15.6485 31.3461 17.625 33.7813 17.625H47L29.375 0Z" fill="#A1C2FA"/>
      <rect x="11.0156" y="34.6406" width="24.9688" height="2.4453" fill="#F1F3F4"/>
      <rect x="11.0156" y="40.9531" width="24.9688" height="2.4453" fill="#F1F3F4"/>
      <rect x="11.0156" y="47.2656" width="24.9688" height="2.4453" fill="#F1F3F4"/>
      <rect x="11.0156" y="53.5781" width="16.0625" height="2.4453" fill="#F1F3F4"/>
    </svg>
  );
}

type AppKey = keyof typeof GOOGLE_ICONS | "docs";
const INCLUDED_APPS: Array<{ key: AppKey; label: string }> = [
  { key: "gmail",    label: "Gmail"    },
  { key: "calendar", label: "Calendar" },
  { key: "drive",    label: "Drive"    },
  { key: "docs",     label: "Docs"     },
  { key: "meet",     label: "Meet"     },
];

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
    const annual  = item.prices?.annual?.msrp  ?? item.msrp;
    const monthly = item.prices?.monthly?.msrp ?? Math.round(annual * 1.25);
    return {
      id:           slug,
      catalogId:    item.id,
      name:         item.name.replace(/^Google Workspace\s*/i, "") || item.name,
      monthlyPrice: slug === "enterprise" ? null : monthly,
      annualPrice:  slug === "enterprise" ? null : annual,
      maxUsers:     slug === "enterprise" ? null : 300,
      isPopular:    preset.isPopular,
      cta:          slug === "enterprise" ? "Contact sales" : "Get a quote",
      introHeader:  preset.introHeader,
      features:     preset.features,
    };
  });
}

// NOTE: Business Base (₹99/user) is excluded — it's vendor-direct only,
// Premier Partners cannot resell it. Customers wanting Base must buy from Google directly.
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
    promoPrice:   864,
    promoLabel:   "20% off · first 20 users · 12 months",
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
// Comparison table
// ──────────────────────────────────────────────────────────────────────
type CompareCell = boolean | string;
interface CompareRow { feature: string; vals: [CompareCell, CompareCell, CompareCell]; }
interface CompareCategory { name: string; icon: string; rows: CompareRow[]; }

const COMPARE_CATEGORIES: CompareCategory[] = [
  {
    name: "Productivity and collaboration",
    icon: "mail",
    rows: [
      { feature: "Custom email for your business",                   vals: [true, true, true] },
      { feature: "Pooled storage per user",                          vals: ["30 GB", "2 TB", "5 TB"] },
      { feature: "Shared drives for teams",                          vals: [false, true, true] },
      { feature: "Video meetings · max participants",                vals: ["100", "150", "1,000"] },
      { feature: "Meeting recording saved to Drive",                 vals: [false, true, true] },
      { feature: "Noise cancellation",                               vals: [false, true, true] },
      { feature: "Livestreaming meetings",                           vals: [false, false, true] },
      { feature: "Appointment booking + Bookings",                   vals: [false, true, true] },
      { feature: "eSignature in Docs and PDFs",                      vals: [false, true, true] },
      { feature: "Vault retention + eDiscovery",                     vals: [false, false, true] },
    ],
  },
  {
    name: "AI · Gemini in Workspace",
    icon: "sparkles",
    rows: [
      { feature: "Gemini in Gmail · help me write + summarize",      vals: [true, true, true] },
      { feature: "Gemini in Docs · drafts and rewrites",             vals: [false, true, true] },
      { feature: "Gemini in Meet · auto notes + action items",       vals: [false, true, true] },
      { feature: "Gemini in Sheets · formulas + analysis",           vals: [false, true, true] },
      { feature: "Gemini in Slides · image generation",              vals: [false, true, true] },
      { feature: "Gemini app · standalone access",                   vals: ["Basic", "Expanded", "Expanded"] },
      { feature: "NotebookLM · AI research assistant",               vals: ["Basic", "Expanded", "Expanded"] },
      { feature: "AI Classification + sensitivity labels",           vals: [false, false, true] },
    ],
  },
  {
    name: "Security and management",
    icon: "shield",
    rows: [
      { feature: "2-step verification",                              vals: [true, true, true] },
      { feature: "Admin console + management controls",              vals: [true, true, true] },
      { feature: "Group-based policy controls",                      vals: [false, true, true] },
      { feature: "Endpoint management for mobile + desktop",         vals: ["Basic", "Advanced", "Enterprise"] },
      { feature: "S/MIME encryption for email",                      vals: [false, false, true] },
      { feature: "Data Loss Prevention (DLP)",                       vals: [false, false, true] },
      { feature: "Context-aware access",                             vals: [false, false, true] },
      { feature: "Cloud Identity Premium",                           vals: [false, false, true] },
    ],
  },
];

// ──────────────────────────────────────────────────────────────────────
// Customer social proof data
// PLACEHOLDER: replace with real customer logos + permission to display
// before public launch. For now, illustrative Indian SME names + cities.
// ──────────────────────────────────────────────────────────────────────
interface CustomerLogo { name: string; city: string; }
const CUSTOMER_LOGOS: CustomerLogo[] = [
  { name: "Mehta Exports",     city: "Surat"      },
  { name: "Acme Pvt Ltd",      city: "Pune"       },
  { name: "Sharma Logistics",  city: "Delhi NCR"  },
  { name: "Singhania & Co",    city: "Indore"     },
  { name: "Rao Engineering",   city: "Bengaluru"  },
  { name: "Patel Trading",     city: "Ahmedabad"  },
];

interface Testimonial {
  name:    string;
  role:    string;
  company: string;
  city:    string;
  seats:   number;
  quote:   string;
  metric:  string;
  initials: string;
}
const TESTIMONIALS: Testimonial[] = [
  {
    name:    "Rohit Mehta",
    role:    "Managing Director",
    company: "Mehta Exports",
    city:    "Surat",
    seats:   80,
    quote:   "Switched from Microsoft 365 in one weekend. Pardeep's team did the entire migration — zero downtime, zero confusion. Old emails, calendars, drive — everything came across.",
    metric:  "Saved ₹4.2L in year one",
    initials: "RM",
  },
  {
    name:    "Anita Rao",
    role:    "CFO",
    company: "Rao Engineering",
    city:    "Bengaluru",
    seats:   35,
    quote:   "Phone-pickup support actually picks up. That's rare in this industry. The GST invoice has proper HSN codes — our accountant approved on first try.",
    metric:  "Phone answered in under 30 sec",
    initials: "AR",
  },
  {
    name:    "Vikas Singhania",
    role:    "Owner",
    company: "Singhania & Co",
    city:    "Indore",
    seats:   12,
    quote:   "I paid Saturday evening. Monday morning my whole team was on Gmail with custom domain. No tickets, no waiting, no English-only docs. Just done.",
    metric:  "Live in 36 hours, weekend included",
    initials: "VS",
  },
];

// Gate the social-proof strip (logos + testimonials) OFF until real, permissioned
// customer content exists. The names/quotes/₹-savings above are illustrative
// placeholders — showing fabricated testimonials on a live checkout is a trust +
// compliance risk (and against our "honest, not flattery" rule). Flip to `true`
// once Pardeep supplies real, consented logos + testimonials.
const SHOW_SOCIAL_PROOF = false;

// ──────────────────────────────────────────────────────────────────────
// Post-purchase timeline — removes ghosting fear
// ──────────────────────────────────────────────────────────────────────
interface TimelineStep { time: string; title: string; body: string; }
const POST_PURCHASE_TIMELINE: TimelineStep[] = [
  { time: "0 min",  title: "You pay via Razorpay",         body: "UPI, NEFT, card, net-banking — your choice."                                       },
  { time: "15 min", title: "GST invoice in your inbox",    body: "Plus a WhatsApp confirmation from your account manager."                          },
  { time: "2 hours", title: "Onboarding call scheduled",   body: "We call to confirm domain, MX records, and migration source."                     },
  { time: "Same day", title: "Domain verified",            body: "DNS configured, admin console handed over with your owner credentials."           },
  { time: "24 hours", title: "Team emails live",           body: "Custom @yourcompany.com working. Old mail still migrating in background."         },
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

/** Official Google G mark (4-color rounded G) used inside Premier Partner badge. */
function GoogleGMark({ size = 32 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-label="Google">
      <path fill={G.blue}   d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill={G.green}  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill={G.yellow} d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill={G.red}    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

/** Google Cloud "Sell · Premier Partner · Google Workspace" circular badge. */
function PremierPartnerBadge({ size = 140 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        boxShadow: "0 6px 16px rgba(0,0,0,0.06)",
      }}
      className="rounded-full border-[1.5px] border-[#9AA0A6] bg-white flex flex-col items-center justify-center p-2.5"
    >
      <GoogleGMark size={Math.round(size * 0.23)} />
      <div
        style={{ fontSize: size * 0.075, letterSpacing: "0.18em", color: G.grey }}
        className="uppercase font-medium mt-1"
      >
        Sell
      </div>
      <div
        style={{ fontSize: size * 0.16, lineHeight: 1.05, color: G.grey }}
        className="text-center font-medium mt-1.5 tracking-tight"
      >
        Premier<br />Partner
      </div>
      <div
        style={{ fontSize: size * 0.085, color: G.grey }}
        className="text-center font-normal mt-1.5"
      >
        Google Workspace
      </div>
    </div>
  );
}

/** Premier Partner badge wrapped in golden glow ring + tilted shadow (used in hero). */
function PremierBadgeShowcase() {
  return (
    <div className="relative flex items-center justify-center">
      {/* Golden radial glow behind badge */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: 200, height: 200,
          background: "radial-gradient(circle, rgba(251,188,4,0.28) 0%, rgba(251,188,4,0.10) 40%, transparent 70%)",
          filter: "blur(8px)",
        }}
      />
      {/* Badge with golden gradient ring */}
      <div
        className="relative rounded-full p-1"
        style={{
          background: "linear-gradient(135deg, #FBBC04 0%, #F59E0B 50%, #FBBC04 100%)",
          boxShadow: "0 18px 48px rgba(60,64,67,0.32), 0 6px 14px rgba(245,158,11,0.30)",
          transform: "rotate(4deg)",
        }}
      >
        <div className="bg-white rounded-full p-[3px]">
          <PremierPartnerBadge size={140} />
        </div>
      </div>
    </div>
  );
}

/**
 * FounderHero — the hero's right column. Pardeep's avatar + signed refund
 * promise + DOMINANT WhatsApp button with his real phone number. Replaces
 * the inbox-mock visual (which was decorative, not conversion-driving).
 *
 * Composition:
 *   [Premier badge — corner accent]
 *   ┌────────────────────────────────┐
 *   │  [Avatar 80×80]  Pardeep Sharma │
 *   │                   Founder · ...  │
 *   ├────────────────────────────────┤
 *   │  "If we don't go live in 24h,    │
 *   │   I refund the setup fee."       │
 *   │   — Pardeep                      │
 *   ├────────────────────────────────┤
 *   │  [▓▓▓▓ WhatsApp +91… ▓▓▓▓]    │
 *   │  or call +91 99999 30300         │
 *   └────────────────────────────────┘
 */
function FounderHero({ waMessage }: { waMessage: string }) {
  return (
    <div className="relative w-full max-w-[440px]">
      {/* Premier Partner badge — small corner accent, top-left */}
      <div className="absolute -top-5 -left-5 z-20">
        <div
          className="rounded-full p-1"
          style={{
            background: "linear-gradient(135deg, #FBBC04 0%, #F59E0B 50%, #FBBC04 100%)",
            boxShadow: "0 10px 24px rgba(60,64,67,0.25)",
            transform: "rotate(-5deg)",
          }}
        >
          <div className="bg-white rounded-full p-[2px]">
            <PremierPartnerBadge size={84} />
          </div>
        </div>
      </div>

      {/* Main card — white surface, generous padding, subtle border */}
      <div
        className="bg-white rounded-2xl border-2 border-amber/40 p-7"
        style={{ boxShadow: "0 30px 60px -15px rgba(60,64,67,0.20)" }}
      >
        {/* Avatar + identity */}
        <div className="flex items-center gap-4 mb-5 pt-2">
          <div
            className="w-20 h-20 rounded-full grid place-items-center font-serif text-3xl text-paper shadow-md flex-shrink-0"
            style={{ background: "linear-gradient(135deg, #1A1815 0%, #4A3B28 100%)" }}
            aria-hidden="true"
          >
            PS
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-serif text-xl text-ink leading-tight">Pardeep Sharma</div>
            <div className="text-sm text-ink-3 mt-0.5">Founder, Excel Technologies</div>
            <div className="text-[11px] text-amber-ink mt-1 font-medium">
              Google Premier Partner · since 2014
            </div>
          </div>
        </div>

        {/* Signed promise — the page's strongest conversion signal */}
        <blockquote className="font-serif text-base md:text-lg text-ink leading-snug mb-6 pl-4 border-l-4 border-amber">
          &ldquo;If we don&apos;t go live in 24 hours, I refund the setup fee personally.
          You&apos;ll have my WhatsApp from day one.&rdquo;
        </blockquote>

        {/* Dominant WhatsApp button — the page's primary action */}
        <a
          href={whatsappLink(waMessage)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2.5 w-full py-3.5 rounded-xl font-medium text-paper text-base transition-transform hover:scale-[1.02] mb-2.5"
          style={{ background: "#25D366", boxShadow: "0 10px 24px rgba(37,211,102,0.30)" }}
        >
          <Icon name="whatsapp" size={20} className="text-paper" />
          WhatsApp {PARDEEP_PHONE_DISPLAY}
        </a>

        {/* Tap-to-call fallback */}
        <a
          href={`tel:+${PARDEEP_PHONE_E164}`}
          className="flex items-center justify-center gap-2 w-full py-2 text-sm text-ink-3 hover:text-ink transition-colors"
        >
          <Icon name="phone" size={14} />
          or call {PARDEEP_PHONE_DISPLAY}
        </a>

        {/* Support hours micro-line */}
        <div className="text-[11px] text-ink-3 text-center mt-3 pt-3 border-t border-hairline">
          Live phone support · 9am–9pm IST · Mon–Sat · Hindi + English
        </div>
      </div>
    </div>
  );
}

/**
 * Hero visual — Google's marketing pattern: workspace photo + floating UI
 * cards overlaid (storage indicator, user list). Premier Partner badge sits
 * on the top-left corner of the photo as a credential stamp.
 *
 *   ┌─[★ Premier]──────────[Storage 384 GB]─┐
 *   │                                        │
 *   │     [Photo: team collaborating]       │
 *   │                                        │
 *   └──┬────────────────────────────────────┘
 *      │  [User 1] [User 2] [User 3]     │     ← user list overlap
 *      └─────────────────────────────────┘
 */
// "Google Workspace includes" — 16 product chips with real Google brand
// icons. Excel Tech is an authorised Google Premier Partner; partner brand
// guidelines permit display of Google product marks when reselling those
// products. Icon URLs point to public Wikimedia Commons assets (the same
// approach used in the prototype). Fallback letter chip is shown when an
// icon URL fails to load, so the section degrades gracefully.
interface WsApp {
  name:    string;
  letter:  string;
  color:   string;  // CSS color — fallback chip background
  tagline: string;
  iconUrl?: string;
}
const WORKSPACE_APPS: WsApp[] = [
  // Real Wikimedia-hosted Google icons (verified loading in browser).
  { name: "Gmail",     letter: "M",  color: "#EA4335", tagline: "Email",
    iconUrl: "https://upload.wikimedia.org/wikipedia/commons/7/7e/Gmail_icon_%282020%29.svg" },
  { name: "Drive",     letter: "D",  color: "#1FA463", tagline: "Storage",
    iconUrl: "https://upload.wikimedia.org/wikipedia/commons/1/12/Google_Drive_icon_%282020%29.svg" },
  { name: "Meet",      letter: "M",  color: "#00897B", tagline: "Video calls",
    iconUrl: "https://upload.wikimedia.org/wikipedia/commons/9/9b/Google_Meet_icon_%282020%29.svg" },
  { name: "Calendar",  letter: "31", color: "#4285F4", tagline: "Scheduling",
    iconUrl: "https://upload.wikimedia.org/wikipedia/commons/a/a5/Google_Calendar_icon_%282020%29.svg" },
  { name: "Sheets",    letter: "S",  color: "#34A853", tagline: "Spreadsheets",
    iconUrl: "https://upload.wikimedia.org/wikipedia/commons/a/ae/Google_Sheets_2020_Logo.svg" },
  // Inline / fallback chip — Gemini uses our inline sparkle SVG; the rest
  // use coloured letter chips because their Wikimedia URLs aren't reliable.
  // Pardeep can later self-host real SVGs in /public/icons/ for these.
  { name: "Chat",      letter: "C",  color: "#34A853", tagline: "Team messaging" },
  { name: "Gemini",    letter: "G",  color: "#9333EA", tagline: "AI assistant"   },
  { name: "Docs",      letter: "D",  color: "#4285F4", tagline: "Documents"      },
  { name: "Slides",    letter: "S",  color: "#F4B400", tagline: "Presentations"  },
  { name: "Vids",      letter: "V",  color: "#EA4335", tagline: "AI video"       },
  { name: "Keep",      letter: "K",  color: "#FBBC04", tagline: "Notes"          },
  { name: "Sites",     letter: "S",  color: "#5F6368", tagline: "Intranet pages" },
  { name: "Forms",     letter: "F",  color: "#673AB7", tagline: "Surveys"        },
  { name: "Tasks",     letter: "T",  color: "#1A73E8", tagline: "To-dos"         },
  { name: "NotebookLM",letter: "N",  color: "#1A73E8", tagline: "AI research"    },
  { name: "AppSheet",  letter: "A",  color: "#5E97F6", tagline: "No-code apps"   },
];

// Original inbox mock data — generic Indian B2B emails, NOT modelled on
// any vendor's email UI. Senders + subjects feel realistic to SME owners.
interface InboxRow {
  sender:  string;
  subject: string;
  preview: string;
  time:    string;
  hue:     number;
  initials: string;
  unread?: boolean;
  tag?:    { label: string; color: string };
}
const INBOX_PREVIEW: InboxRow[] = [
  {
    sender: "Rohit Kumar", initials: "RK", hue: 220,
    subject: "Q4 sales report — please review",
    preview: "Hi Priya, attaching the Q4 numbers. Up 18% from Q3...",
    time:    "10:24 AM",
    unread:  true,
    tag:     { label: "Team", color: "blue" },
  },
  {
    sender: "Anita Rao", initials: "AR", hue: 280,
    subject: "Tomorrow's 10am Meet — rescheduled",
    preview: "Moving to 11:30 IST. Same agenda — Razorpay integration walkthrough.",
    time:    "9:08 AM",
    unread:  true,
  },
  {
    sender: "GST IRP", initials: "GS", hue: 130,
    subject: "Invoice IRN generated — INV-2025-26-0142",
    preview: "Your IRN for invoice INV-2025-26-0142 was generated successfully.",
    time:    "Yesterday",
    tag:     { label: "Bills", color: "emerald" },
  },
  {
    sender: "Vikas Singhania", initials: "VS", hue: 25,
    subject: "Re: Workspace migration kickoff",
    preview: "Thanks for the call yesterday. Confirming we'll start migration Monday...",
    time:    "Yesterday",
  },
];

function HeroVisual() {
  return (
    // Outer wrapper has padding so the overlay cards have room to extend
    // beyond the inbox mock's edges without getting clipped.
    <div className="relative w-full max-w-[540px] pt-8 pr-2 pb-8 pl-8">
      {/* Main visual — stylized email inbox preview. Shows the product
          actually in use (custom-domain inbox with realistic Indian B2B
          emails) rather than a stock workspace photo. Original UI design. */}
      <div className="relative rounded-2xl overflow-hidden shadow-[0_30px_60px_-15px_rgba(0,0,0,0.25)] bg-white">
        {/* Window chrome — neutral macOS-style top bar */}
        <div className="px-4 py-2.5 border-b border-hairline bg-paper-2/40 flex items-center gap-3">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#FF5F57" }} />
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#FEBC2E" }} />
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#28C840" }} />
          </div>
          <div className="flex-1 text-center text-[11px] text-ink-3 font-mono truncate">
            mail.yourcompany.in · Inbox
          </div>
          <div className="w-10" />
        </div>

        {/* Inbox header — count + filter chips */}
        <div className="px-4 py-2.5 border-b border-hairline bg-paper-2/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-serif text-sm text-ink">Inbox</span>
            <span className="text-[10px] text-ink-3 font-medium px-1.5 py-0.5 rounded bg-paper-2">
              2 unread
            </span>
          </div>
          <div className="text-[10px] text-ink-3 font-mono">priya@yourcompany.in</div>
        </div>

        {/* Email rows */}
        <ul className="divide-y divide-hairline">
          {INBOX_PREVIEW.map((row, i) => (
            <li
              key={i}
              className={`px-4 py-3 flex items-start gap-3 ${row.unread ? "bg-white" : "bg-paper-2/20"}`}
            >
              {/* Unread dot */}
              <div className="pt-1.5 flex-shrink-0">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ background: row.unread ? "#C2410C" : "transparent" }}
                />
              </div>
              {/* Avatar */}
              <div
                className="w-8 h-8 rounded-full grid place-items-center text-[10px] font-medium text-white flex-shrink-0"
                style={{ background: `hsl(${row.hue}, 50%, 55%)` }}
              >
                {row.initials}
              </div>
              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-sm truncate ${row.unread ? "font-semibold text-ink" : "text-ink-2"}`}>
                    {row.sender}
                  </span>
                  <span className="text-[10px] text-ink-3 flex-shrink-0 font-mono">{row.time}</span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={`text-sm truncate ${row.unread ? "font-medium text-ink" : "text-ink-3"}`}>
                    {row.subject}
                  </span>
                  {row.tag && (
                    <span
                      className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold flex-shrink-0 ${
                        row.tag.color === "emerald" ? "bg-emerald-soft text-emerald" :
                        row.tag.color === "blue"    ? "bg-indigo-soft text-indigo-ink" :
                        "bg-paper-2 text-ink-3"
                      }`}
                    >
                      {row.tag.label}
                    </span>
                  )}
                </div>
                <div className="text-xs text-ink-3 truncate mt-0.5">{row.preview}</div>
              </div>
            </li>
          ))}
        </ul>

        {/* Bottom shimmer — implies "more emails below" without showing fake ones */}
        <div className="px-4 py-2 text-center bg-paper-2/30 border-t border-hairline">
          <span className="text-[10px] text-ink-3 font-mono">+ more in your inbox</span>
        </div>
      </div>

      {/* TOP-LEFT — Premier Partner badge (credential stamp, extends out) */}
      <div className="absolute top-0 left-0 z-20">
        <div
          className="rounded-full p-1"
          style={{
            background: "linear-gradient(135deg, #FBBC04 0%, #F59E0B 50%, #FBBC04 100%)",
            boxShadow: "0 14px 32px rgba(60,64,67,0.25), 0 4px 10px rgba(245,158,11,0.30)",
            transform: "rotate(-5deg)",
          }}
        >
          <div className="bg-white rounded-full p-[2px]">
            <PremierPartnerBadge size={96} />
          </div>
        </div>
      </div>

      {/* TOP-RIGHT — Custom email card (Workspace's #1 value prop, made
          prominent: bigger pad, larger email font, all-mono so it reads as
          a real address rather than copy). */}
      <div
        className="absolute top-0 right-0 z-20 bg-white rounded-xl px-5 py-4 flex items-center gap-3.5"
        style={{ boxShadow: "0 14px 32px rgba(60,64,67,0.18), 0 3px 8px rgba(60,64,67,0.10)" }}
      >
        <div
          className="w-11 h-11 rounded-xl grid place-items-center flex-shrink-0"
          style={{ background: "linear-gradient(135deg, #FCE8E6 0%, #FAD2CF 100%)" }}
        >
          {/* Generic envelope mark — drawn fresh, not a brand logo */}
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="6" width="18" height="13" rx="2" stroke="#EA4335" strokeWidth="2" />
            <path d="M3 8l9 6 9-6" stroke="#EA4335" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-ink-3 font-medium">
            Your custom email
          </div>
          <div className="text-base text-ink font-medium leading-tight mt-1 font-mono">
            priya@yourcompany.in
          </div>
          <div className="text-[10px] text-emerald font-medium mt-1 flex items-center gap-1">
            <Icon name="check" size={11} />
            Domain verified · live
          </div>
        </div>
      </div>

      {/* (Old team-users card removed — sender names in the inbox now show
          the team aspect, so the separate card became redundant.) */}
    </div>
  );
}

/**
 * (Older) Hero centerpiece — kept around for reference but no longer used.
 * Premier Partner badge with Google app icons radiating from it. Replaced by
 * `<HeroVisual />` after Pardeep requested a photo-based hero matching Google's
 * own landing page composition.
 */
function BadgeBurst() {
  // Polar positions for the 6 orbiting icons.
  // Angle measured from top (0°), clockwise. Each at 60° apart.
  // x = r·sin(θ), y = -r·cos(θ) — negate y because CSS top grows downward.
  const r = 160; // orbit radius (px)
  const orbits: Array<{
    angleDeg: number;
    size: number;
    iconUrl?: string;
    render?: React.ReactNode;
  }> = [
    { angleDeg:   0, size: 62, iconUrl: GOOGLE_ICONS.drive  },                              // top
    { angleDeg:  60, size: 56, iconUrl: GOOGLE_ICONS.meet   },                              // top-right
    { angleDeg: 120, size: 58, render: <GoogleDocsIcon size={34} />                       }, // bottom-right
    { angleDeg: 180, size: 62, render: <GeminiSpark size={38} />                          }, // bottom
    { angleDeg: 240, size: 58, render: <GoogleCalendarIcon size={34} />                   }, // bottom-left
    { angleDeg: 300, size: 64, iconUrl: GOOGLE_ICONS.gmail  },                              // top-left
  ];

  return (
    <div className="relative" style={{ width: 460, height: 460 }}>
      {/* Subtle radial glow framing the badge */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(circle at center, rgba(251,188,4,0.10) 0%, rgba(251,188,4,0.04) 30%, transparent 60%)",
        }}
      />

      {/* Faint dashed orbit guide — gives the "radiating" feel */}
      <div
        className="absolute pointer-events-none rounded-full border border-dashed border-amber/25"
        style={{
          width: r * 2,
          height: r * 2,
          top: `calc(50% - ${r}px)`,
          left: `calc(50% - ${r}px)`,
        }}
      />

      {/* Centre — Premier Partner badge */}
      <div
        className="absolute"
        style={{
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
        }}
      >
        <PremierBadgeShowcase />
      </div>

      {/* Orbiting Google app icons */}
      {orbits.map((o, i) => {
        const θ = (o.angleDeg * Math.PI) / 180;
        const x = r * Math.sin(θ);
        const y = -r * Math.cos(θ);
        return (
          <div
            key={i}
            className="absolute pointer-events-none rounded-full bg-white grid place-items-center"
            style={{
              top:  `calc(50% + ${y}px)`,
              left: `calc(50% + ${x}px)`,
              transform: "translate(-50%, -50%)",
              width: o.size,
              height: o.size,
              boxShadow:
                "0 12px 32px rgba(60,64,67,0.18), 0 2px 6px rgba(60,64,67,0.10)",
            }}
          >
            {o.render ? (
              o.render
            ) : o.iconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={o.iconUrl}
                alt=""
                width={Math.round(o.size * 0.58)}
                height={Math.round(o.size * 0.58)}
                style={{ display: "block" }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** A Google app icon inside a white circle with shadow — used for hero floats. */
function FloatingAppIcon({
  iconUrl, size, className, style, children,
}: {
  iconUrl?: string;
  size: number;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`absolute pointer-events-none rounded-full bg-white grid place-items-center ${className ?? ""}`}
      style={{
        width: size, height: size,
        boxShadow: "0 12px 32px rgba(60,64,67,0.18), 0 2px 6px rgba(60,64,67,0.10)",
        ...style,
      }}
    >
      {children ? (
        children
      ) : iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={iconUrl}
          alt=""
          width={Math.round(size * 0.58)}
          height={Math.round(size * 0.58)}
          style={{ display: "block" }}
        />
      ) : null}
    </div>
  );
}

/** Gemini sparkle icon (4-color gradient star). */
function GeminiSpark({ size = 36 }: { size?: number }) {
  const gradId = "gem-" + React.useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-label="Gemini">
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#4285F4" />
          <stop offset="35%"  stopColor="#9333EA" />
          <stop offset="70%"  stopColor="#EA4335" />
          <stop offset="100%" stopColor="#FBBC04" />
        </linearGradient>
      </defs>
      {/* Four-pointed sparkle — taller verticals, gentle horizontals */}
      <path
        fill={`url(#${gradId})`}
        d="M14 1.5 C 14.5 8 16 10.5 22.5 14 C 16 17 14.5 19 14 26.5 C 13.5 19 12 17 5.5 14 C 12 10.5 13.5 8 14 1.5 Z"
      />
    </svg>
  );
}

/** Inline Google Docs icon — blue document with "Docs" label band. */
function GoogleDocsIcon({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-label="Google Docs">
      <path d="M 18 6 Q 18 4 20 4 H 66 L 82 20 V 94 Q 82 96 80 96 H 20 Q 18 96 18 94 Z" fill="#4285F4" />
      <path d="M 66 4 V 20 H 82 Z" fill="#3730A3" />
      <rect x="28" y="32" width="22" height="3.5" rx="1.5" fill="#FFFFFF" />
      <rect x="28" y="42" width="44" height="3.5" rx="1.5" fill="#FFFFFF" />
      <rect x="28" y="52" width="44" height="3.5" rx="1.5" fill="#FFFFFF" />
      <rect x="28" y="62" width="44" height="3.5" rx="1.5" fill="#FFFFFF" />
    </svg>
  );
}

/** Inline Google Calendar icon — simple white block with blue header and "31". */
function GoogleCalendarIcon({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-label="Google Calendar">
      <rect x="10" y="14" width="80" height="78" rx="6" fill="#FFFFFF" />
      <rect x="10" y="14" width="80" height="20" rx="6" fill="#4285F4" />
      <rect x="10" y="20" width="80" height="14" fill="#4285F4" />
      <rect x="22" y="6" width="6" height="18" rx="2" fill="#1A73E8" />
      <rect x="72" y="6" width="6" height="18" rx="2" fill="#1A73E8" />
      <text x="50" y="74" fontSize="42" fontWeight="500" fill="#1A73E8" textAnchor="middle" fontFamily="system-ui, sans-serif">31</text>
    </svg>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────────
export function BuyWorkspaceClient({
  catalogItems = [],
  paymentMode = "simulation",
}: {
  /** Server-fetched, enabled Google Workspace SKUs from the reseller's Item
   *  Catalog. When empty, we fall back to the hardcoded FALLBACK_TIERS. */
  catalogItems?: CatalogItem[];
  /** "live"        : Razorpay configured, real money taken.
   *  "simulation"  : Razorpay missing but simulated checkout is allowed
   *                  (non-prod, or ALLOW_SIMULATED_CHECKOUT=1) — Buy-now posts
   *                  a fake payment so Pardeep can walk the full pipeline. A
   *                  clear TEST MODE banner keeps test buys unambiguous.
   *  "disabled"    : Razorpay missing in production — the online-buy CTA is
   *                  hidden entirely so a REAL customer never sees a "Simulate
   *                  payment" button. They're routed to "Get a GST quote". */
  paymentMode?: "live" | "simulation" | "disabled";
} = {}) {
  const isSimulation = paymentMode === "simulation";
  // Online instant-buy (Razorpay live OR simulated preview) — never in disabled.
  const onlineBuyEnabled = paymentMode !== "disabled";
  // Runtime tiers — sourced from the catalog when it has rows, otherwise from
  // the in-file FALLBACK_TIERS so the page never renders empty.
  const TIERS = React.useMemo<Tier[]>(
    () => (catalogItems.length > 0 ? buildTiers(catalogItems) : FALLBACK_TIERS),
    [catalogItems],
  );
  const [billing, setBilling] = React.useState<"monthly" | "annual">("annual");
  const [selectedTier, setSelectedTier] = React.useState<Tier | null>(null);
  // Separate state for the trial dialog — different flow, different form fields.
  const [trialDialogOpen, setTrialDialogOpen] = React.useState(false);
  // Razorpay direct-buy dialog — opens with the user's chosen tier, collects
  // company details, then launches the Razorpay Checkout widget. Different
  // from selectedTier (which opens the GST-quote enquiry form).
  const [buyNowTier, setBuyNowTier] = React.useState<Tier | null>(null);
  // Tier + seat count drive the live price calculator AND the WhatsApp /
  // form-submission flow. Visitor can pick any tier — calculator math, CTA
  // copy, and the auto-quote tier are all wired off this single state.
  // Default to the most popular tier (if catalog flagged one), else the
  // middle tier, else the first. Works for any catalog shape — 3 SKUs or 4.
  const defaultTierId =
    TIERS.find((t) => t.isPopular)?.id ?? TIERS[Math.floor(TIERS.length / 2)]?.id ?? "standard";
  const [selectedTierId, setSelectedTierId] = React.useState<string>(defaultTierId);
  const [seats, setSeats] = React.useState<number>(10);
  const selectedTierObj = TIERS.find((t) => t.id === selectedTierId) ?? TIERS[0];
  const calc = React.useMemo(() => calcForTier(selectedTierObj, seats), [selectedTierObj, seats]);

  // Site promo — currently-active auto-applied sale (from /online-promos).
  // Fetched per-tier/seat so eligibility filters work. Banner shown sticky
  // below header; discount auto-applied in the price preview + BuyNowDialog.
  const sitePromo = useActiveSitePromo(selectedTierObj.id, seats);
  const sitePromoDiscount = computeSitePromoDiscount(sitePromo, calc.annual);
  // Final visitor-facing total in the hero calculator — incorporates Google
  // promo (already in calc.annual) AND the site promo.
  const heroPostPromoSubtot = Math.max(0, calc.annual - sitePromoDiscount);
  const heroFinalGst        = Math.round(heroPostPromoSubtot * 0.18);
  const heroFinalTotal      = heroPostPromoSubtot + heroFinalGst;

  const waMessage = calc.isCustom
    ? `Hi Pardeep, I'm interested in Google Workspace Enterprise for ${seats} user${seats === 1 ? "" : "s"}. Can you send a custom quote?`
    : `Hi Pardeep, I'm interested in Google Workspace ${selectedTierObj.name} for ${seats} user${seats === 1 ? "" : "s"}. Can you send a GST quote?`;

  return (
    <div className="min-h-screen bg-paper">
      {/* ── Header ── */}
      <header className="border-b border-hairline bg-paper sticky top-0 z-40 backdrop-blur-sm bg-paper/95">
        <div className="max-w-[1240px] mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-ink text-paper rounded-md grid place-items-center font-serif text-lg flex-shrink-0">
              R
            </div>
            <div className="hidden sm:block">
              <div className="font-serif text-base leading-none">Excel Technologies</div>
              <div className="text-[10px] text-ink-3 mt-1">Cloud Reseller · India</div>
            </div>
          </div>
          {/* Tiny partner pill */}
          <div
            className="hidden md:inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-semibold border border-[#FBBF24]"
            style={{
              background: "linear-gradient(135deg, #1A1815 0%, #2D2418 100%)",
              color: "#FCD34D",
            }}
          >
            <span style={{ fontSize: 11 }}>★</span> Google Premier Partner
          </div>
          <Button asChild variant="primary" size="sm">
            <a href="#enquiry">Get started</a>
          </Button>
        </div>
      </header>

      {/* ── Online Promo banner ──
          Auto-applied site-wide sale. Managed from /online-promos. Sticky
          below header, gradient bar with headline + countdown + "savings"
          pill. The discount itself is applied inside the calculator + at
          checkout — banner is the visual hook. */}
      {sitePromo && (
        <SitePromoBanner promo={sitePromo} />
      )}

      {/* ── Simulation-mode banner ──
          Shown only when Razorpay isn't configured. The Buy-now button still
          works in this mode — it walks the full lead/quote/payment pipeline
          but skips the real Razorpay widget. This banner keeps test buys
          unambiguously labelled. */}
      {isSimulation && (
        <div
          className="border-b border-amber/30 text-center text-xs sm:text-sm"
          style={{
            background: "linear-gradient(90deg, #FEF3C7 0%, #FDE68A 50%, #FEF3C7 100%)",
            color: "#7C2D12",
          }}
        >
          <div className="max-w-[1240px] mx-auto px-4 py-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5">
            <span className="font-semibold inline-flex items-center gap-1.5">
              <span aria-hidden>🧪</span> TEST MODE
            </span>
            <span>
              Buy flow is simulated · no real payments are processed · perfect for previewing the pipeline.
            </span>
          </div>
        </div>
      )}

      {/* ── Hero ── */}
      <section
        className="relative overflow-hidden"
        style={{
          background:
            "radial-gradient(circle at 80% 30%, rgba(66,133,244,0.08) 0%, transparent 50%)," +
            "radial-gradient(circle at 20% 70%, rgba(234,67,53,0.05) 0%, transparent 50%)," +
            "linear-gradient(180deg, rgba(250,248,242,1) 0%, rgba(250,248,242,0.96) 100%)",
        }}
      >
        {/* Floating icons moved into the BadgeBurst (right column) so they
            radiate FROM the Premier Partner badge instead of scattering. */}

        <div className="relative max-w-[1240px] mx-auto px-6 py-16 lg:py-24 grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-12 items-center">
          {/* Left column — outcome headline + live seat calculator + dual CTA */}
          <div>
            <h1 className="font-serif text-4xl md:text-5xl lg:text-[54px] leading-[1.05] tracking-tight mb-5">
              Buy <GWInline />.
            </h1>

            <p className="text-base text-ink-3 leading-relaxed mb-7 max-w-xl">
              <b className="text-ink">Indian SMEs</b> trust us with their email.
              Google Premier Partner since 2014. GST invoice, Hindi support,
              <b className="text-ink"> one person who picks up the phone.</b>
            </p>

            {/* Live seat calculator — tier-aware. Visitor picks Starter /
                Standard / Enterprise; calculator + WhatsApp + form CTA all
                respond. Enterprise short-circuits to "talk to us". */}
            <div className="mb-5 p-5 rounded-2xl border border-hairline bg-paper-2/40">
              {/* Every plan includes — ultra-realistic Google brand marks
                  · sits just above the tier picker so visitor sees "these
                  apps are bundled with every plan" before choosing one */}
              <div className="mb-4 pb-4 border-b border-hairline/60">
                <p className="text-[10px] uppercase tracking-[0.18em] text-ink-3 font-semibold mb-2.5">
                  Every plan includes
                </p>
                <div className="flex items-center gap-3 sm:gap-4 flex-wrap">
                  {INCLUDED_APPS.map((app) => (
                    <div key={app.key} className="flex flex-col items-center gap-1 group">
                      <div className="w-6 h-6 sm:w-7 sm:h-7 grid place-items-center transition-transform group-hover:scale-110">
                        {app.key === "docs" ? (
                          <DocsLogo className="w-full h-full drop-shadow-sm" />
                        ) : (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={GOOGLE_ICONS[app.key]}
                            alt={`Google ${app.label}`}
                            width={28}
                            height={28}
                            loading="lazy"
                            className="w-full h-full object-contain drop-shadow-sm"
                          />
                        )}
                      </div>
                      <span className="text-[9px] font-medium text-ink-3 tracking-wide">{app.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Tier picker — segmented control */}
              <div className="mb-4">
                <label className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold block mb-2">
                  Which plan?
                </label>
                <div
                  className="grid gap-1.5 p-1 rounded-lg bg-paper border border-hairline"
                  style={{ gridTemplateColumns: `repeat(${TIERS.length}, minmax(0, 1fr))` }}
                >
                  {TIERS.map((t) => {
                    const id = t.id;
                    const isActive = selectedTierId === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setSelectedTierId(id)}
                        className={`px-2 py-2 rounded-md text-xs font-medium transition-colors ${
                          isActive
                            ? "bg-amber text-paper shadow-sm"
                            : "text-ink-3 hover:text-ink hover:bg-paper-2"
                        }`}
                      >
                        <div className="font-serif text-sm leading-tight">
                          {t.name.replace("Business ", "")}
                        </div>
                        <div className={`text-[10px] mt-0.5 ${isActive ? "text-paper/80" : "text-ink-3"}`}>
                          {t.annualPrice
                            ? `₹${(t.promoPrice ?? t.annualPrice).toLocaleString("en-IN")}/user · excl GST`
                            : "Custom"}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Seat picker — applies to all tiers */}
              <div className="flex items-center justify-between mb-3">
                <label htmlFor="seats" className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold">
                  For how many users?
                </label>
                <span className="text-[10px] text-ink-3 font-mono">{selectedTierObj.name} · annual</span>
              </div>
              <div className="flex items-center gap-3 mb-4">
                <button
                  type="button"
                  onClick={() => setSeats(Math.max(1, seats - 1))}
                  className="w-9 h-9 rounded-lg border border-hairline bg-paper hover:bg-paper-2 text-ink font-medium grid place-items-center transition-colors"
                  aria-label="Decrease seats"
                >
                  −
                </button>
                <input
                  id="seats"
                  type="number"
                  min={1}
                  max={10000}
                  value={seats}
                  onChange={(e) => setSeats(Math.max(1, Math.min(10000, parseInt(e.target.value) || 1)))}
                  className="w-20 text-center font-serif text-2xl bg-paper border border-hairline rounded-lg py-1.5 text-ink focus:outline-none focus:border-amber"
                />
                <button
                  type="button"
                  onClick={() => setSeats(Math.min(10000, seats + 1))}
                  className="w-9 h-9 rounded-lg border border-hairline bg-paper hover:bg-paper-2 text-ink font-medium grid place-items-center transition-colors"
                  aria-label="Increase seats"
                >
                  +
                </button>
                <span className="text-sm text-ink-3 ml-1">users</span>
              </div>

              {/* Price block — Enterprise gets "custom" message, others get math */}
              {calc.isCustom ? (
                <div>
                  <div className="font-serif text-2xl text-ink leading-tight">
                    Custom pricing
                  </div>
                  <div className="text-xs text-ink-3 mt-1.5 leading-relaxed">
                    Enterprise plans are quoted based on your security, compliance,
                    and support needs. Tell us your seat count — we&apos;ll send a tailored quote.
                  </div>
                </div>
              ) : (
                <div className="flex items-end justify-between gap-3 flex-wrap">
                  <div>
                    <div className="flex items-baseline gap-2">
                      {sitePromo && sitePromoDiscount > 0 ? (
                        <>
                          <span className="font-serif text-3xl md:text-4xl text-ink leading-none">
                            ₹{heroFinalTotal.toLocaleString("en-IN")}
                          </span>
                          <span className="font-mono text-sm text-ink-3 line-through">
                            ₹{calc.total.toLocaleString("en-IN")}
                          </span>
                        </>
                      ) : (
                        <span className="font-serif text-3xl md:text-4xl text-ink leading-none">
                          ₹{calc.total.toLocaleString("en-IN")}
                        </span>
                      )}
                      <span className="text-sm text-ink-3">/year incl 18% GST</span>
                    </div>
                    <div className="text-xs text-ink-3 mt-1.5">
                      Effective ₹{(seats > 0
                        ? Math.round((sitePromo && sitePromoDiscount > 0 ? heroFinalTotal : calc.total) / (seats * 12))
                        : 0).toLocaleString("en-IN")}/user/month · incl GST · single annual invoice
                    </div>
                    {sitePromo && sitePromoDiscount > 0 && (
                      <div className="text-sm text-amber-ink font-medium mt-2 inline-flex items-center gap-1.5">
                        <Icon name="zap" size={14} />
                        {sitePromo.headline.length > 50 ? `${sitePromo.discount_type === "percent" ? sitePromo.discount_value + "% off" : "₹" + sitePromo.discount_value + " off"} auto-applied` : sitePromo.headline} · saving ₹{Math.round(sitePromoDiscount * 1.18).toLocaleString("en-IN")}
                      </div>
                    )}
                    {calc.savings > 0 && (
                      <div className="text-sm text-emerald font-medium mt-2 inline-flex items-center gap-1.5">
                        <Icon name="check" size={14} />
                        You save ₹{calc.savings.toLocaleString("en-IN")} vs Google direct
                      </div>
                    )}
                  </div>

                  {/* Buy now button — fills the empty right side of the calculator */}
                  {selectedTierObj.annualPrice != null && onlineBuyEnabled && (
                    <button
                      type="button"
                      onClick={() => setBuyNowTier(selectedTierObj)}
                      className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-all bg-amber text-paper hover:bg-amber/90 active:bg-amber/80 shadow-md hover:shadow-lg h-10 px-5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2"
                    >
                      <Icon name="zap" size={14} />
                      Buy now
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Dual CTA — WhatsApp first (primary, Indian SMEs' fastest path),
                form second. Both pre-fill the seat count so no information is lost. */}
            <div className="flex flex-col sm:flex-row gap-3 mb-3">
              <a
                href={whatsappLink(waMessage)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 px-6 h-12 rounded-lg font-medium text-paper transition-transform hover:scale-[1.02] text-base"
                style={{ background: "#25D366", boxShadow: "0 8px 20px rgba(37,211,102,0.30)" }}
              >
                <Icon name="whatsapp" size={20} className="text-paper" />
                WhatsApp Pardeep — quote in 10 min
              </a>
              <Button
                variant="default"
                size="lg"
                onClick={() => setSelectedTier(selectedTierObj)}
              >
                Email me a GST quote
              </Button>
            </div>

            {/* Tertiary trial CTA — small, low-commit. "No card needed" is the
                key SME hesitation killer; the 14-day promise is industry-standard. */}
            <div className="mb-4">
              <button
                type="button"
                onClick={() => setTrialDialogOpen(true)}
                className="inline-flex items-center gap-1.5 text-sm text-ink hover:text-amber transition-colors underline underline-offset-4 decoration-dotted"
              >
                <Icon name="rocket" size={14} className="text-amber" />
                Or start a 14-day free trial
                <span className="text-ink-3 text-xs">(no credit card needed)</span>
              </button>
            </div>

            {/* GST + payment trust strip — pulled up from trust badges (Indian SME #1 concern) */}
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 items-center text-xs text-ink-2">
              <span className="inline-flex items-center gap-1.5">
                <Icon name="check" size={13} className="text-emerald" />
                GST invoice with HSN
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Icon name="check" size={13} className="text-emerald" />
                Razorpay · UPI · NEFT
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Icon name="check" size={13} className="text-emerald" />
                Migration done for you
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Icon name="check" size={13} className="text-emerald" />
                Cancel anytime
              </span>
            </div>
          </div>

          {/* Right column — Pardeep founder card with signed refund promise
              and DOMINANT WhatsApp CTA. Indian SMEs buy from people, not
              brands — putting his face + number + commitment above the fold
              collapses the trust-building journey. */}
          <div className="flex justify-center items-center mt-4 lg:mt-0 lg:pl-6 lg:pr-2">
            <FounderHero waMessage={waMessage} />
          </div>
        </div>
      </section>

      {/* ── Excel vs Google direct — moved up to section #2 (right after hero)
            because "why not just buy from Google?" is the SINGLE biggest
            objection an Indian SME visitor brings to this page. Answer it
            before showing apps, logos, or pricing. ── */}
      <section className="bg-paper-2/40 border-y border-hairline py-16 md:py-20">
        <div className="max-w-[1080px] mx-auto px-6">
          <div className="text-center mb-10">
            <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-3 mb-3">
              Same price · more service
            </div>
            <h2 className="font-serif text-3xl md:text-4xl tracking-tight mb-3">
              Both cost ₹1,080. Only one comes with{" "}
              <span className="text-amber">a person who picks up your call.</span>
            </h2>
            <p className="text-base text-ink-3 max-w-2xl mx-auto leading-relaxed">
              Excel Tech and Google direct have the same MRP. The difference
              is what&apos;s wrapped around the price.
            </p>
          </div>

          <Card className="overflow-hidden">
            <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-hairline">
              {/* Excel column — the recommended one */}
              <div className="p-6 md:p-8 bg-amber-soft/20">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider font-semibold text-amber-ink mb-1">
                      Recommended
                    </div>
                    <h3 className="font-serif text-xl text-ink">Excel Technologies</h3>
                  </div>
                  <div className="font-serif text-2xl text-ink">₹1,080</div>
                </div>
                <ul className="space-y-2.5">
                  <CompareBullet positive>Hand-held migration from M365/Zoho (zero downtime)</CompareBullet>
                  <CompareBullet positive>Hindi + English phone support, 9am–9pm IST</CompareBullet>
                  <CompareBullet positive>Dedicated account manager (one human, not a ticket queue)</CompareBullet>
                  <CompareBullet positive>GST invoice with HSN code (CGST + SGST or IGST)</CompareBullet>
                  <CompareBullet positive>Razorpay · UPI · NEFT · card · net-banking</CompareBullet>
                  <CompareBullet positive>Same-day domain verification + DNS setup</CompareBullet>
                  <CompareBullet positive>Annual upfront with single invoice</CompareBullet>
                  <CompareBullet positive>Direct Google escalation via Premier Partner status</CompareBullet>
                </ul>
              </div>

              {/* Google direct column */}
              <div className="p-6 md:p-8">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-3 mb-1">
                      Self-serve only
                    </div>
                    <h3 className="font-serif text-xl text-ink-3">Google direct</h3>
                  </div>
                  <div className="font-serif text-2xl text-ink-3">₹1,080</div>
                </div>
                <ul className="space-y-2.5">
                  <CompareBullet>DIY migration (you handle CSV exports, MX records)</CompareBullet>
                  <CompareBullet>Email-only support · bot-first chat</CompareBullet>
                  <CompareBullet>No named account manager — every ticket starts fresh</CompareBullet>
                  <CompareBullet positive>GST invoice (basic, no HSN guidance)</CompareBullet>
                  <CompareBullet>Credit card only · no UPI · no NEFT</CompareBullet>
                  <CompareBullet>DNS docs in English only (you read &amp; configure)</CompareBullet>
                  <CompareBullet>Monthly billing default · annual via admin console</CompareBullet>
                  <CompareBullet>Standard Google support tier</CompareBullet>
                </ul>
              </div>
            </div>
          </Card>
        </div>
      </section>

      {/* ── Customer logo strip + testimonials — gated until real content exists ── */}
      {SHOW_SOCIAL_PROOF && (
        <>
          <section className="border-y border-hairline bg-paper-2/30 py-10">
            <div className="max-w-[1240px] mx-auto px-6">
              <p className="text-center text-xs uppercase tracking-[0.14em] text-ink-3 mb-6 font-medium">
                Trusted by Indian businesses — from 5-person studios to 200-person factories
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6 items-center">
                {CUSTOMER_LOGOS.map((c) => (
                  <LogoChip key={c.name} name={c.name} city={c.city} />
                ))}
              </div>
            </div>
          </section>

          <section className="max-w-[1240px] mx-auto px-6 py-16 md:py-20">
            <div className="text-center mb-12">
              <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-3 mb-3">
                Real customers · real outcomes
              </div>
              <h2 className="font-serif text-3xl md:text-4xl tracking-tight">
                How others switched
              </h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {TESTIMONIALS.map((t) => (
                <TestimonialCard key={t.name} testimonial={t} />
              ))}
            </div>
          </section>
        </>
      )}

      {/* ── Pricing section ── */}
      <section id="pricing" className="max-w-[1240px] mx-auto px-6 py-16 md:py-20">
        <div className="text-center mb-12">
          <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-3 mb-3">
            Plans &amp; pricing
          </div>
          <h2 className="font-serif text-3xl md:text-4xl tracking-tight mb-3">
            Same Google Workspace, priced in ₹
          </h2>
          <p className="text-base text-ink-3 max-w-2xl mx-auto leading-relaxed">
            Annual upfront preferred — single invoice, 12 months of service, no
            month-to-month payment chase. GST split (CGST + SGST or IGST) on every invoice.
          </p>
        </div>

        {/* Billing toggle */}
        <div className="flex justify-center mb-10">
          <div className="inline-flex p-1 rounded-lg bg-paper-2 border border-hairline">
            <button
              onClick={() => setBilling("monthly")}
              className={`px-5 py-2 rounded-md text-sm font-medium transition-colors ${
                billing === "monthly" ? "bg-paper shadow-sm text-ink" : "text-ink-3"
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setBilling("annual")}
              className={`px-5 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
                billing === "annual" ? "bg-paper shadow-sm text-ink" : "text-ink-3"
              }`}
            >
              Annual
              <span className="text-[10px] bg-amber-soft text-amber-ink px-1.5 py-0.5 rounded font-semibold">
                Save 20%
              </span>
            </button>
          </div>
        </div>

        {/* Pricing grid — one column per enabled SKU in the Item Catalog.
            Adapts from 3 to 4 cards depending on what Pardeep has switched on. */}
        <div className={`grid grid-cols-1 md:grid-cols-2 ${
          TIERS.length >= 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"
        } gap-6`}>
          {TIERS.map((tier) => (
            <PricingCard
              key={tier.id}
              tier={tier}
              billing={billing}
              onSelect={() => setSelectedTier(tier)}
              // Buy now shows in both live and simulation modes; Enterprise
              // (no fixed annualPrice) always uses the quote path.
              onBuyNow={
                tier.annualPrice != null && onlineBuyEnabled ? () => setBuyNowTier(tier) : undefined
              }
            />
          ))}
        </div>
      </section>

      {/* ── How it works — 3 steps ── */}
      <section className="max-w-[1240px] mx-auto px-6 py-16 md:py-20">
        <div className="text-center mb-12">
          <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-3 mb-3">
            How it works
          </div>
          <h2 className="font-serif text-3xl md:text-4xl tracking-tight mb-3">
            From signup to mailbox in one day
          </h2>
          <p className="text-base text-ink-3 max-w-2xl mx-auto leading-relaxed">
            No CSV uploads, no week-long support tickets, no DNS guesswork.
            We handle the technical side; you just answer the phone.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <HowItWorksStep
            number={1}
            title="Pick a plan & seats"
            body="Request a custom quote in 30 seconds, or buy directly via Razorpay if you know what you need."
          />
          <HowItWorksStep
            number={2}
            title="Pay with GST invoice"
            body="UPI, NEFT, card, or net-banking. Annual upfront preferred — single invoice with CGST/SGST or IGST split."
          />
          <HowItWorksStep
            number={3}
            title="Live in 24 hours"
            body="DNS verification, MX records, mailbox provisioning, and migration from your old provider — all hands-on by us."
          />
        </div>
      </section>

      {/* Removed (conversion-design audit, 2026-05-25):
          - 25-row comparison table — caused analysis paralysis, pushed
            buyers past the pricing they'd already decided on.
          - 4-icon trust badges row — every claim is already stated in the
            hero strip + Excel-vs-Google block + post-purchase timeline.
          - Standalone founder promise band — same content now sits ABOVE
            THE FOLD in the hero (FounderHero), so a second band 11 sections
            down was redundant. */}

      {/* ── Post-purchase timeline — removes ghosting fear ── */}
      <section className="max-w-[1080px] mx-auto px-6 py-16 md:py-20">
        <div className="text-center mb-12">
          <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-3 mb-3">
            What happens after you pay
          </div>
          <h2 className="font-serif text-3xl md:text-4xl tracking-tight mb-3">
            No ghosting. Here&apos;s the exact timeline.
          </h2>
          <p className="text-base text-ink-3 max-w-2xl mx-auto leading-relaxed">
            Indian SMEs ask this every time. Fair question. Here&apos;s what we promise.
          </p>
        </div>

        <ol className="relative space-y-6 md:space-y-0 md:grid md:grid-cols-5 md:gap-0">
          {POST_PURCHASE_TIMELINE.map((step, idx) => (
            <li key={step.title} className="relative md:px-3">
              {/* Connecting line between steps (desktop) */}
              {idx < POST_PURCHASE_TIMELINE.length - 1 && (
                <div className="hidden md:block absolute top-5 left-[calc(50%+22px)] right-[-22px] h-px bg-amber/40" />
              )}
              {/* Number circle */}
              <div className="flex items-center md:justify-center gap-3 md:flex-col md:gap-2 mb-2">
                <div className="w-10 h-10 rounded-full bg-amber text-paper grid place-items-center font-serif text-sm shadow-sm flex-shrink-0 relative z-10">
                  {idx + 1}
                </div>
                <div className="text-xs font-mono uppercase tracking-wider text-amber-ink">
                  {step.time}
                </div>
              </div>
              <div className="md:text-center pl-13 md:pl-0">
                <div className="font-medium text-ink text-sm mb-1">{step.title}</div>
                <div className="text-xs text-ink-3 leading-relaxed">{step.body}</div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ── FAQ ── */}
      <section className="bg-paper-2/40 border-y border-hairline py-16">
        <div className="max-w-[820px] mx-auto px-6">
          <div className="text-center mb-10">
            <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-3 mb-3">
              FAQ
            </div>
            <h2 className="font-serif text-3xl md:text-4xl tracking-tight">
              Quick answers
            </h2>
          </div>
          <div className="space-y-3">
            <FaqItem
              q="Is the pricing same as Google direct?"
              a="Yes — we charge the same MRP that Google publishes for India (₹270/user/month for Starter annual). The difference is what's bundled around the price: hands-on migration, dedicated account manager, Hindi support, GST invoice, and Razorpay payments. Google direct gives you a credit-card-based portal and email-only support."
            />
            <FaqItem
              q="Can I get a GST invoice?"
              a="Yes. Every invoice is a proper Tax Invoice (CGST §31 compliant) with a CGST + SGST split for intra-state customers and IGST for inter-state — as a GST PDF you can use for your ITC claims. Google's own bills don't itemise GST the way Indian businesses need."
            />
            <FaqItem
              q="What if I'm switching from Microsoft 365 / Zoho?"
              a="We do the migration for you — emails, contacts, calendars, drive files. Free of cost for plans of 5+ users. Most migrations finish in 24-48 hours with zero downtime."
            />
            <FaqItem
              q="Annual or monthly — what's better?"
              a="Annual upfront saves 17% over monthly billing AND keeps the relationship simple — one invoice, one year, one payment cycle. Most Indian SMEs prefer this. Monthly is available if cashflow is tight."
            />
            <FaqItem
              q="What if I want to cancel?"
              a="Cancel anytime from your admin console. Annual plans get pro-rata refunds (minus 30-day notice). Monthly plans stop at the end of the current billing cycle. No questions, no exit fees."
            />
            <FaqItem
              q="Do you support Google Workspace Migrate tool?"
              a="Yes — that tool is bundled in Business Standard and Enterprise plans. Useful if you're moving from a self-hosted IMAP server or another cloud provider. We help you configure it."
            />
          </div>
        </div>
      </section>

      {/* ── Enquiry anchor ── */}
      <section id="enquiry" className="max-w-[800px] mx-auto px-6 py-16">
        <Card className="p-8 text-center">
          <h2 className="font-serif text-3xl mb-3">Ready to switch?</h2>
          <p className="text-base text-ink-3 mb-6 leading-relaxed">
            Tell us how many users and we'll send a GST quote within an hour.
          </p>
          <Button
            variant="primary"
            size="lg"
            iconRight="arrow_right"
            onClick={() => setSelectedTier(TIERS[1])}
          >
            Get a custom quote
          </Button>
        </Card>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-hairline py-10 pb-24 md:pb-10">
        <div className="max-w-[1240px] mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 bg-ink text-paper rounded grid place-items-center font-serif text-sm">
              R
            </div>
            <div className="font-serif text-sm">Excel Technologies Pvt Ltd</div>
          </div>
          <div className="text-xs text-ink-3 font-mono">
            Made in India · GSTIN registered · Google Premier Partner
          </div>
        </div>
      </footer>

      {/* ── Sticky WhatsApp chip — always accessible "talk to a human" path.
            Uses the same calculator seat count in its message so the chip is
            never out-of-sync with what the visitor is looking at. ── */}
      <a
        href={whatsappLink(waMessage)}
        target="_blank"
        rel="noopener noreferrer"
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 px-4 py-3 rounded-full shadow-lg text-paper font-medium text-sm transition-transform hover:scale-105"
        style={{ background: "#25D366" }}
        aria-label="Chat with Pardeep on WhatsApp"
      >
        <Icon name="whatsapp" size={18} className="text-paper" />
        <span className="hidden sm:inline">Chat with Pardeep</span>
      </a>

      {/* ── Enquiry dialog ──
          Bound to the hero calculator: `seats` flows from the same state
          that drives the live price math, so when the visitor sets 100
          users in the calc and clicks "Email me a GST quote", the form
          opens with 100 already filled in. */}
      {selectedTier && (
        <EnquiryDialog
          tier={selectedTier}
          billing={billing}
          initialSeats={seats}
          onClose={() => setSelectedTier(null)}
        />
      )}

      {/* ── Trial dialog ── separate flow with a domain field; lands at
          stage='trial' instead of 'new'. Free; no auto-quote. */}
      {trialDialogOpen && (
        <TrialDialog
          tier={selectedTierObj}
          initialSeats={seats}
          onClose={() => setTrialDialogOpen(false)}
        />
      )}

      {/* ── Razorpay direct-buy dialog ── collects company details, creates
          a draft quote on the server, then launches Razorpay Checkout JS.
          On success the webhook flips quote → paid and creates the
          customer/subscription. The dialog ships a self-contained calculator
          so the visitor can change tier/seats without going back to the page.*/}
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
// Pricing card
// ──────────────────────────────────────────────────────────────────────
function PricingCard({
  tier, billing, onSelect, onBuyNow,
}: {
  tier: Tier;
  billing: "monthly" | "annual";
  onSelect:  () => void;
  /** Optional — when present and tier has a price, an instant "Buy now"
   *  primary CTA is shown above the "Get a quote" secondary CTA. Enterprise
   *  tier (no price) hides this regardless. */
  onBuyNow?: () => void;
}) {
  const price = billing === "monthly" ? tier.monthlyPrice : tier.annualPrice;
  const promo = billing === "annual" ? tier.promoPrice : null;

  // For the Standard card, calculate the rupee saving — the page's ONLY real
  // differentiator vs Google direct (both charge the same ₹1080 MRP).
  const savingPerUserPerYear =
    promo && price ? (price - promo) * 12 : 0;

  return (
    <Card className={`relative flex flex-col ${
      tier.isPopular
        ? "border-amber border-2 shadow-xl ring-4 ring-amber-soft/40"
        : ""
    }`}>
      {/* Standard tier gets a bold red ribbon — the 20% promo is the page's
          single decisive lever, so the badge has to fight for attention. */}
      {tier.isPopular && billing === "annual" && (
        <div className="absolute -top-4 left-1/2 -translate-x-1/2 z-10">
          <div
            className="px-4 py-1.5 text-paper text-[11px] font-bold uppercase tracking-wider rounded-md shadow-md"
            style={{ background: "linear-gradient(135deg, #DC2626 0%, #B91C1C 100%)" }}
          >
            20% OFF · First 20 users · 12 months
          </div>
        </div>
      )}
      {tier.isPopular && billing !== "annual" && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <div className="px-3 py-1 bg-amber text-paper text-xs font-semibold rounded-full shadow-sm">
            ★ Most Popular
          </div>
        </div>
      )}

      <div className="p-6 pb-4">
        <h3 className="font-serif text-2xl mb-1">{tier.name}</h3>

        {price !== null ? (
          <div className="mb-4">
            {promo ? (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="font-serif text-5xl text-ink leading-none">
                    ₹{promo.toLocaleString("en-IN")}
                  </span>
                  <span className="text-base text-ink-3 line-through">
                    ₹{price.toLocaleString("en-IN")}
                  </span>
                </div>
                <div className="text-xs text-ink-3 mt-1">
                  per user per month · billed annually
                </div>
                {/* Big rupee savings — converts "20% off" into a number people feel */}
                {savingPerUserPerYear > 0 && (
                  <div
                    className="mt-3 px-3 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-1.5"
                    style={{ background: "#FEE2E2", color: "#991B1B" }}
                  >
                    <Icon name="trending_down" size={14} />
                    Save ₹{savingPerUserPerYear.toLocaleString("en-IN")}/user/year
                  </div>
                )}
              </>
            ) : (
              <>
                <span className="font-serif text-5xl text-ink leading-none">
                  ₹{price.toLocaleString("en-IN")}
                </span>
                <div className="text-xs text-ink-3 mt-1">
                  per user per month · {billing === "annual" ? "billed annually" : "billed monthly"}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="mb-4">
            <div className="font-serif text-3xl text-ink">Let&apos;s talk</div>
            <div className="text-xs text-ink-3 mt-1">Custom pricing for 300+ users</div>
          </div>
        )}

        {tier.maxUsers && (
          <div className="text-[11px] text-ink-3 mb-4">Up to {tier.maxUsers} users</div>
        )}

        {/* Urgency line — quote validity, NOT manipulative countdown */}
        {tier.isPopular && billing === "annual" && (
          <div className="text-[11px] text-ink-3 mb-3 italic">
            Quote valid 7 days · lock this rate for 12 months
          </div>
        )}

        {/* Dual CTA stack for buyable tiers: Razorpay instant-buy primary +
            "Get a quote" secondary (for visitors who want Pardeep-touch
            before paying — GST review, custom seats, PO process). Enterprise
            shows the single "Contact sales" CTA. */}
        {onBuyNow && price !== null ? (
          <div className="space-y-2">
            <Button
              variant="primary"
              className="w-full justify-center"
              onClick={onBuyNow}
            >
              <Icon name="zap" size={14} className="mr-1.5" />
              Buy now — pay online
            </Button>
            <Button
              variant="default"
              className="w-full justify-center"
              onClick={onSelect}
            >
              Or get a GST quote first
            </Button>
          </div>
        ) : (
          <Button
            variant={tier.isPopular ? "primary" : "default"}
            className="w-full justify-center"
            onClick={onSelect}
          >
            {tier.cta}
          </Button>
        )}
      </div>

      <div className="px-6 py-5 border-t border-hairline flex-1 bg-paper-2/30">
        <div className="text-xs font-semibold text-ink mb-3 uppercase tracking-wide">
          {tier.introHeader}
        </div>
        <ul className="space-y-2.5">
          {tier.features.map((feat) => (
            <li key={feat} className="flex items-start gap-2 text-sm text-ink-2 leading-relaxed">
              <Icon name="check" size={14} className="text-emerald flex-shrink-0 mt-0.5" />
              <span>{feat}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Comparison cell renderer
// ──────────────────────────────────────────────────────────────────────
function CompareCellRender({ value }: { value: CompareCell }) {
  if (value === true) {
    return <Icon name="check" size={16} className="text-emerald mx-auto" />;
  }
  if (value === false) {
    return <span className="text-ink-3/40 text-base">—</span>;
  }
  return <span className="text-xs font-mono text-ink-2">{value}</span>;
}

// ──────────────────────────────────────────────────────────────────────
// Trust item
// ──────────────────────────────────────────────────────────────────────
function TrustItem({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div>
      <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-amber-soft grid place-items-center">
        <Icon name={icon} size={22} className="text-amber-ink" />
      </div>
      <div className="font-medium text-ink mb-1 text-sm">{title}</div>
      <div className="text-xs text-ink-3 leading-relaxed">{body}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Workspace app chip — real Google product icon when the hosted URL loads,
// gracefully falling back to a colored letter chip on 404 / network error.
// Partner brand permission applies to the icons we display.
// ──────────────────────────────────────────────────────────────────────
function AppChip({ app }: { app: WsApp }) {
  const [imgFailed, setImgFailed] = React.useState(false);
  const showImage   = app.iconUrl && !imgFailed;
  const showGemini  = !showImage && app.name === "Gemini";
  const showFallback = !showImage && !showGemini;

  return (
    <div className="flex flex-col items-center text-center group">
      {showImage && (
        <div className="w-12 h-12 mb-2 grid place-items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={app.iconUrl}
            alt=""
            width={44}
            height={44}
            onError={() => setImgFailed(true)}
            className="transition-transform group-hover:scale-110"
            style={{ display: "block" }}
          />
        </div>
      )}
      {showGemini && (
        <div className="w-12 h-12 mb-2 grid place-items-center transition-transform group-hover:scale-110">
          <GeminiSpark size={40} />
        </div>
      )}
      {showFallback && (
        <div
          className="w-12 h-12 rounded-2xl grid place-items-center font-medium text-white text-base shadow-sm group-hover:shadow-md transition-shadow mb-2"
          style={{ background: app.color }}
          aria-hidden="true"
        >
          {app.letter}
        </div>
      )}
      <div className="text-xs font-medium text-ink leading-tight">{app.name}</div>
      <div className="text-[10px] text-ink-3 mt-0.5 leading-tight">{app.tagline}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Customer logo chip — text-based brand "logo" with city tag.
// PLACEHOLDER: in production, swap for actual SVG logos in /public/logos/
// ──────────────────────────────────────────────────────────────────────
function LogoChip({ name, city }: { name: string; city: string }) {
  return (
    <div className="text-center">
      <div className="font-serif text-base md:text-lg text-ink leading-tight">{name}</div>
      <div className="text-[10px] uppercase tracking-wider text-ink-3 mt-1">{city}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Testimonial card — avatar + quote + metric badge
// ──────────────────────────────────────────────────────────────────────
function TestimonialCard({ testimonial: t }: { testimonial: Testimonial }) {
  return (
    <Card className="p-6 flex flex-col h-full">
      {/* Metric badge — the bold outcome number */}
      <div className="inline-flex items-center self-start gap-1.5 px-3 py-1 mb-4 rounded-full bg-emerald-soft text-emerald text-xs font-semibold">
        <Icon name="trending_up" size={13} />
        <span>{t.metric}</span>
      </div>

      {/* Quote */}
      <blockquote className="text-sm text-ink-2 leading-relaxed mb-5 flex-1">
        &ldquo;{t.quote}&rdquo;
      </blockquote>

      {/* Attribution */}
      <div className="flex items-center gap-3 pt-4 border-t border-hairline">
        <div className="w-10 h-10 rounded-full bg-amber-soft grid place-items-center font-serif text-base text-amber-ink flex-shrink-0">
          {t.initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-ink text-sm leading-tight">{t.name}</div>
          <div className="text-[11px] text-ink-3 mt-0.5">{t.role}, {t.company}</div>
          <div className="text-[10px] text-ink-3 mt-0.5">{t.city} · {t.seats} users</div>
        </div>
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Compare bullet — check or dash
// ──────────────────────────────────────────────────────────────────────
function CompareBullet({ positive, children }: { positive?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm leading-relaxed">
      {positive ? (
        <Icon name="check" size={14} className="text-emerald flex-shrink-0 mt-0.5" />
      ) : (
        <Icon name="x" size={14} className="text-ink-3/50 flex-shrink-0 mt-0.5" />
      )}
      <span className={positive ? "text-ink-2" : "text-ink-3"}>{children}</span>
    </li>
  );
}

// ──────────────────────────────────────────────────────────────────────
// How it works step — large numbered circle + title + body
// ──────────────────────────────────────────────────────────────────────
function HowItWorksStep({
  number, title, body,
}: { number: number; title: string; body: string }) {
  return (
    <Card className="p-6">
      <div className="w-12 h-12 mb-4 rounded-full bg-amber text-paper grid place-items-center font-serif text-2xl shadow-sm">
        {number}
      </div>
      <h3 className="font-serif text-xl mb-2">{title}</h3>
      <p className="text-sm text-ink-3 leading-relaxed">{body}</p>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────
// FAQ item — native <details>/<summary> for built-in accordion behavior
// ──────────────────────────────────────────────────────────────────────
function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <details className="group bg-paper border border-hairline rounded-lg overflow-hidden">
      <summary className="cursor-pointer list-none px-5 py-4 flex items-center justify-between gap-4 hover:bg-paper-2/40 transition-colors">
        <span className="font-medium text-ink text-[15px]">{q}</span>
        <Icon
          name="chevron_down"
          size={18}
          className="text-ink-3 transition-transform group-open:rotate-180 flex-shrink-0"
        />
      </summary>
      <div className="px-5 pb-5 text-sm text-ink-3 leading-relaxed">{a}</div>
    </details>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Enquiry dialog
// ──────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────
// Trial dialog — separate flow from the GST-quote enquiry.
// Lands at stage='trial' (qualified intent), free 14-day access, requires
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

  async function onSubmit(values: TrialForm) {
    const res = await fetch("/api/public/trial/workspace", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(values),
    });
    const json = await res.json() as { success?: boolean; error?: string };
    if (!res.ok || json.error) {
      toast.error(json.error ?? "Could not start trial. Please try again.");
      return;
    }
    toast.success("Trial requested! Pardeep will WhatsApp you within 4 hours.");
    onClose();
  }

  return (
    <div
      className="fixed inset-0 bg-ink/50 z-50 grid place-items-center p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <Card
        className="max-w-md w-full max-h-[90vh] overflow-y-auto border-2 border-emerald/30"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-emerald mb-1 font-semibold inline-flex items-center gap-1.5">
                <Icon name="rocket" size={11} />
                14-day free trial · no card needed
              </div>
              <h2 className="font-serif text-2xl leading-tight">
                Try <GWInline /> free
              </h2>
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
            <b className="text-ink">Within 4 hours:</b> Pardeep WhatsApps you to verify
            domain. <br />
            <b className="text-ink">Within 24 hours:</b> Your team is on Workspace.
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
              <p className="text-[10px] text-ink-3 mt-1">
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

            <Button
              type="submit"
              variant="primary"
              className="w-full justify-center"
              style={{ background: "#10B981", borderColor: "#059669" }}
              loading={isSubmitting}
            >
              Start my 14-day trial
            </Button>

            <p className="text-[11px] text-ink-3 text-center leading-relaxed">
              No credit card upfront. No auto-charge. Cancel anytime in 14 days.
            </p>
          </form>
        </div>
      </Card>
    </div>
  );
}

function EnquiryDialog({
  tier, billing, initialSeats, onClose,
}: {
  tier: Tier;
  billing: "monthly" | "annual";
  initialSeats: number;
  onClose: () => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EnquiryForm>({
    resolver: zodResolver(enquirySchema),
    defaultValues: { tierId: tier.id, billing, seats: initialSeats },
  });

  async function onSubmit(values: EnquiryForm) {
    // Derive the human-readable state name from the GST code so the lead (and the
    // customer it converts into) carries both — state_code drives IGST vs CGST+SGST.
    const stateCode = values.stateCode || undefined;
    const state     = stateCode ? `${GST_STATE_BY_CODE[stateCode]} (${stateCode})` : undefined;
    const res = await fetch("/api/public/enquiry/workspace", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ...values, stateCode, state }),
    });
    const json = await res.json() as { success?: boolean; error?: string };
    if (!res.ok || json.error) {
      toast.error(json.error ?? "Could not submit enquiry. Please try again.");
      return;
    }
    toast.success("Got it! We'll call you within 30 minutes.");
    onClose();
  }

  return (
    <div
      className="fixed inset-0 bg-ink/50 z-50 grid place-items-center p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <Card
        className="max-w-md w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-ink-3 mb-1 font-semibold">
                Quote request
              </div>
              <h2 className="font-serif text-2xl leading-tight">
                <GWInline />
              </h2>
              <p className="text-sm text-ink-3 mt-1">
                <span className="font-medium">{tier.name}</span> · {billing}
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

            <Button
              type="submit"
              variant="primary"
              className="w-full justify-center"
              loading={isSubmitting}
            >
              Send enquiry
            </Button>

            <p className="text-[11px] text-ink-3 text-center leading-relaxed">
              We'll call within 30 minutes (Mon–Sat, 9am–7pm IST). No spam.
            </p>
          </form>
        </div>
      </Card>
    </div>
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
const buyNowSchema = z.object({
  fullName:    z.string().min(2, "Your name"),
  companyName: z.string().min(2, "Company name"),
  email:       z.string().email("Valid work email"),
  phone:       z.string().min(10, "10-digit phone"),
  seats:       z.coerce.number().int().min(1).max(10000),
  domain:      z.string().min(3, "Your business domain (e.g. acme.in)"),
  tierId:      z.string(),
  gstin:       z.string().optional(),
  couponCode:  z.string().optional(),
});
type BuyNowForm = z.infer<typeof buyNowSchema>;

/**
 * Coupon validation state — owned by the dialog. Updated each time the
 * visitor hits "Apply". The successful shape carries the server-computed
 * pre-GST rupee discount so we can re-render the price breakdown.
 */
interface AppliedCoupon {
  code:           string;
  discount:       number;       // pre-GST rupees off
  discount_type:  "percent" | "flat";
  discount_value: number;
  description?:   string | null;
}

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

  // Coupon state — owned locally, cleared if visitor edits tier/seats
  // (server re-validates anyway, but we don't want a stale "applied" pill
  //  showing when the underlying basis has changed).
  const [couponInput,    setCouponInput]    = React.useState("");
  const [couponApplied,  setCouponApplied]  = React.useState<AppliedCoupon | null>(null);
  const [couponError,    setCouponError]    = React.useState<string | null>(null);
  const [validatingCoupon, setValidatingCoupon] = React.useState(false);

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

  // When tier or seats change, clear any applied coupon. The discount math
  // depends on gross_amount, so a stale apply could mislead the visitor.
  React.useEffect(() => {
    if (couponApplied) {
      setCouponApplied(null);
      setCouponError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierId, seats]);

  async function applyCoupon() {
    const code = couponInput.trim().toUpperCase();
    if (code.length < 2) {
      setCouponError("Enter a code first");
      return;
    }
    setValidatingCoupon(true);
    setCouponError(null);
    try {
      const res = await fetch("/api/public/coupons/validate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          tier:         tier.id,
          seats,
          gross_amount: postSitePromoSubtot,  // stacks BELOW site promo
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        const friendly: Record<string, string> = {
          invalid_code:        "That code doesn't exist",
          inactive:            "This coupon is no longer active",
          expired:             "This coupon has expired",
          not_started:         "This coupon isn't active yet",
          maxed_out:           "This coupon has reached its usage limit",
          wrong_tier:          json.required_tier ? `Code is only for the ${json.required_tier} tier` : "Code doesn't apply to this tier",
          min_seats_not_met:   `Needs at least ${json.min_seats ?? "more"} seats`,
          max_seats_exceeded:  `Code only works up to ${json.max_seats ?? "fewer"} seats`,
          bad_request:         json.message ?? "Invalid request",
          server_error:        "Server error — try again",
        };
        setCouponError(friendly[json.reason as string] ?? "Could not apply this code");
        setCouponApplied(null);
        return;
      }
      setCouponApplied({
        code:           json.code,
        discount:       json.discount,
        discount_type:  json.discount_type,
        discount_value: json.discount_value,
        description:    json.description,
      });
      setCouponError(null);
    } catch {
      setCouponError("Network error — try again");
    } finally {
      setValidatingCoupon(false);
    }
  }

  function removeCoupon() {
    setCouponApplied(null);
    setCouponInput("");
    setCouponError(null);
  }

  const {
    register,
    handleSubmit,
    setValue,
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
      tierId,
      seats,
      simulate:   isSimulation,
      couponCode: couponApplied?.code ?? undefined,
    };

    const res = await fetch("/api/public/checkout/workspace", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    const json: CheckoutApiResponse = await res.json();
    if (!res.ok || json.error) {
      toast.error(json.error ?? "Could not start checkout. Please try again.");
      return;
    }

    // ── Simulation: the server has already marked the quote paid, created
    //    the customer, sent test emails. Redirect to the thanks page so the
    //    visitor gets the full confirmation experience.
    if (isSimulation || json.simulated) {
      const qid = json.quoteId ?? "";
      window.location.href = `/buy/workspace/thanks?order=${encodeURIComponent(qid)}&sim=1`;
      return;
    }

    // ── Live: open the Razorpay Checkout widget with the server's order.
    if (!json.orderId || !json.razorpayKeyId || !json.amount) {
      toast.error("Server response missing payment details. Please retry.");
      return;
    }

    let RazorpayCtor: RazorpayCtor;
    try {
      RazorpayCtor = await loadRazorpayCheckout();
    } catch (err) {
      const m = err instanceof Error ? err.message : "Could not load payment widget";
      toast.error(`${m}. Please check your internet connection.`);
      return;
    }

    const rzp = new RazorpayCtor({
      key:         json.razorpayKeyId,
      amount:      json.amount,
      currency:    json.currency ?? "INR",
      name:        "Excel Technologies",
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
      theme: { color: "#C2410C" },
      handler: () => {
        // Razorpay captured the payment client-side. The webhook will do the
        // real database work; we just take the visitor to the confirmation
        // page so they see a clear next-steps timeline + support link.
        const qid = json.quoteId ?? "";
        window.location.href = `/buy/workspace/thanks?order=${encodeURIComponent(qid)}`;
      },
      modal: {
        ondismiss: () => {
          toast.message("Payment cancelled. We've saved your quote — Pardeep will follow up.");
        },
        escape: true,
      },
    });
    rzp.on("payment.failed", (resp) => {
      toast.error(`Payment failed: ${resp.error?.description ?? "Please retry or use WhatsApp."}`);
    });
    rzp.open();
  }

  // Quick-pick seat presets — covers the most common SME orders without
  // making the visitor mash +/− 25 times.
  const SEAT_PRESETS = [5, 10, 25, 50, 100, 250];

  return (
    <div
      className="fixed inset-0 bg-ink/50 z-50 grid place-items-start lg:place-items-center p-2 sm:p-4 backdrop-blur-sm overflow-y-auto"
      onClick={onClose}
    >
      <Card
        className="max-w-4xl w-full my-4 lg:my-0 border-2 border-amber/30 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky header — survives the long form scroll on mobile */}
        <div className="sticky top-0 z-10 bg-paper border-b border-hairline px-5 sm:px-6 py-4 flex items-start justify-between rounded-t-xl">
          <div>
            {isSimulation ? (
              <div className="text-[10px] uppercase tracking-wider mb-1 font-semibold inline-flex items-center gap-1.5"
                   style={{ color: "#7C2D12" }}>
                <span aria-hidden>🧪</span> Test mode · simulated payment · no real money
              </div>
            ) : (
              <div className="text-[10px] uppercase tracking-wider text-amber-ink mb-1 font-semibold inline-flex items-center gap-1.5">
                <Icon name="zap" size={11} />
                Instant checkout · UPI / Card / NetBanking
              </div>
            )}
            <h2 className="font-serif text-2xl leading-tight">
              Buy <GWInline />
            </h2>
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
                <label className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold block mb-2">
                  1 · Choose your plan
                </label>
                <div
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
                        <div className={`text-[10px] mt-0.5 ${active ? "text-paper/85" : "text-ink-3"}`}>
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
              <label className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold block mb-2">
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
                      className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
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
              <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-3">
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
                  <span>+ GST 18% (CGST 9% + SGST 9%)</span>
                  <span className="font-mono whitespace-nowrap">
                    ₹{(anyDiscount ? recomputedGst : calc.gst).toLocaleString("en-IN")}
                  </span>
                </div>
                <div className="border-t-2 border-ink mt-1 pt-2 flex items-baseline justify-between gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Total to pay</span>
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
              <label className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold block mb-1.5 inline-flex items-center gap-1.5">
                <Icon name="rupee" size={11} /> Have a coupon code?
              </label>
              {couponApplied ? (
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-soft border border-amber/30 text-amber-ink text-xs font-semibold">
                      <Icon name="check_circle" size={11} />
                      <span className="font-mono">{couponApplied.code}</span> applied
                    </span>
                    <span className="text-[11px] text-ink-3">
                      Saving ₹{couponPreGstOff.toLocaleString("en-IN")} pre-GST
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={removeCoupon}
                    className="text-[11px] text-ink-3 hover:text-rose underline-offset-2 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-stretch gap-2">
                    <input
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
                    <p className="text-[11px] text-rose mt-1.5 inline-flex items-center gap-1">
                      <Icon name="alert" size={11} /> {couponError}
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Trust strip */}
            <div className="text-[11px] text-ink-3 flex flex-wrap gap-x-3 gap-y-1.5">
              <span className="inline-flex items-center gap-1">
                <Icon name="check" size={11} className="text-emerald" /> GST tax invoice
              </span>
              <span className="inline-flex items-center gap-1">
                <Icon name="check" size={11} className="text-emerald" /> Cancel anytime
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
              <Input id="buy-fullName" placeholder="e.g. Rajesh Kumar"
                error={errors.fullName?.message} {...register("fullName")} />
            </FormField>

            <FormField label="Company" required htmlFor="buy-companyName">
              <Input id="buy-companyName" placeholder="e.g. Acme Pvt Ltd"
                error={errors.companyName?.message} {...register("companyName")} />
            </FormField>

            <FormField label="Your business domain" required htmlFor="buy-domain">
              <Input id="buy-domain" placeholder="e.g. acme.in"
                error={errors.domain?.message} {...register("domain")} />
              <p className="text-[10px] text-ink-3 mt-1">
                We&apos;ll provision Workspace on this domain. You must own it (DNS access).
              </p>
            </FormField>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label="Work email" required htmlFor="buy-email">
                <Input id="buy-email" type="email" placeholder="e.g. rajesh@acme.in"
                  error={errors.email?.message} {...register("email")} />
              </FormField>
              <FormField label="Phone (WhatsApp)" required htmlFor="buy-phone">
                <Input id="buy-phone" type="tel" placeholder="e.g. +91 98765 43210"
                  error={errors.phone?.message} {...register("phone")} />
              </FormField>
            </div>

            <FormField label="GSTIN (optional)" htmlFor="buy-gstin">
              <Input id="buy-gstin" placeholder="e.g. 27ABCDE1234F1Z5" {...register("gstin")} />
              <p className="text-[10px] text-ink-3 mt-1">
                Add your GSTIN to claim input tax credit. Skip if not GST-registered.
              </p>
            </FormField>

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

            <p className="text-[11px] text-ink-3 text-center leading-relaxed">
              {isSimulation ? (
                <>
                  <b>Test mode</b> · Razorpay isn&apos;t configured yet.<br />
                  Submission creates a real quote + customer + payment row tagged
                  <code className="font-mono"> [SIMULATION]</code> so you can preview the pipeline.
                </>
              ) : (
                <>
                  Powered by Razorpay · UPI · Cards · NetBanking · EMI<br />
                  GST tax invoice emailed within 24 hours of payment.
                </>
              )}
            </p>
          </div>
        </form>
      </Card>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Retained-for-reference symbols. These components/data were used by
// earlier hero iterations (inbox mock, badge sunburst, 16-app chip grid,
// 25-row comparison table, 4-icon trust badges). The current conversion-
// optimised hero replaced them; we keep the source in-file so the design
// evolution is visible. The `void` reads below satisfy TS6133
// (noUnusedLocals) without affecting runtime.
// ──────────────────────────────────────────────────────────────────────
void PARDEEP_PHONE;
void COMPARE_CATEGORIES;
void WORKSPACE_APPS;
void HeroVisual;
void BadgeBurst;
void FloatingAppIcon;
void CompareCellRender;
void TrustItem;
void AppChip;
