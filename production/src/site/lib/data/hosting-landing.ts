/**
 * Hosting landing content — ported from the engine's own landing page
 * (app.anutech.in), which is the page Pardeep wants as THE hosting page inside
 * ResellerOS (2 Sep 2026: "bilkul yahi hona chahiye meri app me").
 *
 * Everything the page says lives here, in ONE file, so copy and prices are
 * changed in a single place rather than inside markup.
 *
 * ⚠️ PLACEHOLDER CONTENT, flagged deliberately:
 *   · TRUSTED_LOGOS are the engine's existing placeholder names — NOT real,
 *     signed-off customer references. (The placeholder TESTIMONIALS with stock
 *     portraits were removed on 27 Sep 2026; real reviews come from
 *     Marketing → Google reviews.) The rest of this site already labels such content ("Client
 *     names and figures are placeholders until the real case studies are signed
 *     off"). Replace them with real reviews, or drop the sections, before this
 *     page is promoted as the public face.
 *
 * PRICES: this table IS the hosting price (owner, 24 Sep 2026: hosting prices are
 * ResellerOS's). `price` is the per-month rate when billed YEARLY; billed monthly is
 * 2×. Checkout charges from it (lib/checkout/hosting-prices.ts), and the DMS panel
 * reads the same figures live from /api/public/hosting-prices (28 Sep 2026) — DMS
 * keeps no copy, so a change here reaches it within a minute. DMS's own Mongo
 * `hostingplans` prices are disregarded.
 */

import { SLA } from "../config";

export interface LandingPlan {
  planId: string;
  name: string;
  description: string;
  /** ₹/month when billed yearly. Monthly billing is 2× this. */
  price: number;
  currency: string;
  features: string[];
  highlightFeatures: string[];
  isPopular: boolean;
}

export const LANDING_PLANS: readonly LandingPlan[] = [
  {
    planId: "starter",
    name: "Starter",
    description: "Small business solution",
    price: 49.99,
    currency: "INR",
    features: [
      "10 GB SSD storage",
      "Unlimited Free SSL",
      "20 GB Bandwidth",
      "Host 1 Website",
      "Phone, WhatsApp & Email Support",
      "Uptime Monitored, Live Status Page",
      "Free Website Migration",
      "Backup",
    ],
    highlightFeatures: ["Host 1 Website"],
    isPopular: false,
  },
  {
    planId: "standard",
    name: "Standard",
    description: "Growing business sites",
    price: 125.0,
    currency: "INR",
    features: [
      "25 GB SSD storage",
      "Unlimited Free SSL",
      "30 GB Bandwidth",
      "Host Multiple Websites",
      "Phone, WhatsApp & Email Support",
      "Uptime Monitored, Live Status Page",
      "Free Website Migration",
      "Backup",
    ],
    highlightFeatures: ["Host Multiple Websites"],
    isPopular: true,
  },
  {
    planId: "plus",
    name: "Plus",
    description: "High scale sites",
    price: 187.2,
    currency: "INR",
    features: [
      "50 GB SSD storage",
      "Unlimited Free SSL",
      "40 GB Bandwidth",
      "Host Multiple Websites",
      "Phone, WhatsApp & Email Support",
      "Uptime Monitored, Live Status Page",
      "Free Website Migration",
      "Priority Support",
      "Advanced Security Features",
      "Backup",
    ],
    highlightFeatures: ["Host Multiple Websites"],
    isPopular: false,
  },
] as const;

/** ⚠️ Placeholder client names — see the file header. */
export const TRUSTED_LOGOS = ["travelizo", "Crafto.", "TechSolution", "Brilliant", "GrowMore Digital"] as const;

export const HOSTING_FEATURES = [
  { icon: "cloud",      title: "Google Cloud Infrastructure", body: "Enterprise-grade infrastructure for maximum speed, security & reliability.", tint: "bg-blue-50 text-blue-500" },
  { icon: "zap",        title: "Lightning Fast Performance",  body: "NVMe SSD storage, LiteSpeed servers and an optimized stack for ultra-fast websites.", tint: "bg-violet-50 text-violet-500" },
  { icon: "lock",       title: "Free SSL Certificate",        body: "Secure your website with a free SSL certificate + HTTPS activation.", tint: "bg-green-50 text-green-500" },
  { icon: "refresh",    title: "Daily Backups",               body: "Automatic daily backups keep your data safe and restorable.", tint: "bg-sky-50 text-sky-500" },
  { icon: "rocket",     title: "Free Website Migration",      body: "We'll move your website to Anutech for FREE. No technical hassle.", tint: "bg-rose-50 text-rose-500" },
  { icon: "headphones", title: "Real People, Real Support",   body: "Help on call, WhatsApp or email, Mon–Sat 10:00–19:00 IST, from people who know your account.", tint: "bg-orange-50 text-orange-500" },
] as const;

/** How a typical host compares, per row. */
export const HOSTING_COMPARISON: readonly { feature: string; typical: "yes" | "no" | "partial" }[] = [
  { feature: "Google Cloud Infrastructure", typical: "no" },
  { feature: "Free SSL Certificate",        typical: "yes" },
  { feature: "Free Website Migration",      typical: "partial" },
  { feature: "15-Day Free Trial",           typical: "no" },
  { feature: "Daily Backups",               typical: "yes" },
  { feature: "Live Uptime Status Page",     typical: "partial" },
  { feature: "Support From Real People",     typical: "no" },
  { feature: "No Hidden Fees",              typical: "no" },
] as const;

export const HOSTING_STEPS = [
  { num: 1, icon: "card",   title: "Create Your Account",  body: "Sign up in less than 60 seconds. No credit card required." },
  { num: 2, icon: "globe",  title: "Choose Domain",        body: "Register a new domain or connect your existing one." },
  { num: 3, icon: "server", title: "Build Your Website",   body: "Install WordPress or use one-click apps to build your site." },
  { num: 4, icon: "rocket", title: "Go Live & Upgrade",    body: "Launch your website. Upgrade anytime if you love our service!" },
] as const;

export const HOSTING_FAQS = [
  { question: "How does the 15-Day Free Trial work?", answer: "Start your trial with full access to all hosting features for 15 days — no credit card required. If you love it, upgrade to a paid plan anytime. If not, simply let it expire." },
  { question: "Do I need a credit card to start the trial?", answer: "No. You can start your 15-day free trial without entering any payment details. You only pay when you decide to continue after the trial." },
  { question: "Can I migrate my website to Anutech for free?", answer: `Yes! We offer free website migration on all plans. Our team moves your site over — ${SLA.migration} — with no technical hassle on your end.` },
  { question: "What happens after the 15-Day Trial?", answer: "When the trial ends you can convert to any paid plan to keep your website live. Your first invoice is generated only at that point — that is when your card / UPI mandate is charged for the first time." },
  { question: "Do you offer a money-back guarantee?", answer: "Yes, we offer a 30-day money-back guarantee on all yearly hosting plans. Monthly plans and domain registrations are not covered by this guarantee." },
  { question: "Can I upgrade or downgrade my plan anytime?", answer: "Absolutely. You can change your plan at any time from your dashboard, and we prorate the difference automatically." },
] as const;
