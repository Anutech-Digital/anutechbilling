/**
 * Hosting landing — v2 content (conversion redesign, 2 Sep 2026).
 *
 * Built from the "Hosting Page Conversion Redesign" handoff, but with THREE
 * deliberate departures from the handoff, all on Pardeep's instruction that the
 * page must carry the app's REAL data — never the design's placeholders:
 *
 *   1. BANDWIDTH is 20 / 30 / 40 GB, the real DirectAdmin package limits
 *      (verified 2 Sep). The handoff said 100 / 200 / Unmetered; the server is
 *      the truth, so those are gone here and in the recommender copy.
 *   2. VERIFIED CLAIMS ONLY. "Google Premier Partner since 2014", the
 *      "99.99% uptime guarantee" line and any customer-count figure are removed
 *      until Anutech confirms them. Company, address and GSTIN stay (real).
 *   3. WEBSITE COUNT is "1" / "Multiple" — the approved wording — not the
 *      handoff's "Unlimited", which the DirectAdmin packages don't verify.
 *
 * PRICE stays single-source: it is read from LANDING_PLANS (hosting-landing.ts),
 * the same numbers the catalogue sync uses. `yearlyMo` = billed-yearly rate;
 * monthly billing is 2×; the yearly total is 12×.
 *
 * Testimonials are kept as-is (Pardeep, 2 Sep) — they already run on the live
 * page; they'll be swapped for real, signed-off references later.
 * The WhatsApp link is the site-wide one from site/lib/config (29 Sep 2026); set the
 * real number there, once, for every page.
 */
import { LANDING_PLANS } from "./hosting-landing";
import { SLA, WHATSAPP_URL } from "@/site/lib/config";

/* Re-exported so HostingLanding keeps its import. This file used to hold its own copy of
   the placeholder, so setting the real number in config.ts would have left /hosting
   pointing at the fake one. */
export { WHATSAPP_URL };
export const TRIAL_DAYS = 15;

export interface HostingTier {
  name: string;
  tag: string;
  fit: string;
  /** ₹/month, billed monthly. */
  monthly: number;
  /** ₹/month, billed yearly. */
  yearlyMo: number;
  /** ₹, one yearly payment. */
  yearlyTotal: number;
  storage: string;
  sites: string;
  bandwidth: string;
  outgrow: string;
  isPopular: boolean;
}

/** Per-plan specs the marketing page shows — merged onto the priced plans. */
const SPECS: Record<string, Omit<HostingTier, "name" | "monthly" | "yearlyMo" | "yearlyTotal" | "isPopular">> = {
  starter: {
    tag: "01 / STARTER",
    fit: "One business or portfolio website, modest traffic.",
    storage: "10 GB",
    sites: "1",
    bandwidth: "20 GB",
    outgrow: "You add a second website, or your media library pushes past 10 GB.",
  },
  standard: {
    tag: "02 / STANDARD",
    fit: "A few websites, forms, a small catalogue — the common case.",
    storage: "25 GB",
    sites: "Multiple",
    bandwidth: "30 GB",
    outgrow: "Traffic climbs past what 30 GB comfortably covers, or you want priority support.",
  },
  plus: {
    tag: "03 / PLUS",
    fit: "Busy WordPress or WooCommerce store that cannot go down.",
    storage: "50 GB",
    sites: "Multiple",
    bandwidth: "40 GB",
    outgrow: "You need a dedicated server or VPS — ask us and we'll say so.",
  },
};

/** The three tiers, price from LANDING_PLANS (single source), specs from SPECS. */
export const HOSTING_TIERS: readonly HostingTier[] = LANDING_PLANS.map((p) => ({
  name: p.name,
  monthly: Math.round(p.price * 2 * 100) / 100,
  yearlyMo: p.price,
  yearlyTotal: Math.round(p.price * 12 * 100) / 100,
  isPopular: p.isPopular,
  ...SPECS[p.planId],
}));

/** Recommender result copy, keyed by the plan chosen (bandwidth = real figures). */
export const REC_WHY: Record<string, string> = {
  "Plus-sites":
    "More than five sites on one account wants the largest tier — Plus gives you 50 GB of storage and the most bandwidth headroom of the three, plus priority support.",
  "Plus-traffic":
    "At 50,000+ visits a month you want the top plan: 50 GB storage, the highest bandwidth, the priority support queue and the advanced security features. That's Plus.",
  Starter:
    "One website with modest traffic sits comfortably in 10 GB of storage and 20 GB of bandwidth. Start here — moving up later does not mean moving the site.",
  Standard:
    "Multiple websites or growing traffic means you want more room — 25 GB storage and 30 GB bandwidth. Standard is where most business customers land.",
};

/** Feature matrix — 99.99% uptime row removed (verified-only), bandwidth real. */
export const HOSTING_MATRIX: readonly { k: string; a: string; b: string; c: string }[] = [
  { k: "NVMe SSD storage", a: "10 GB", b: "25 GB", c: "50 GB" },
  { k: "Bandwidth", a: "20 GB", b: "30 GB", c: "40 GB" },
  { k: "Websites hosted", a: "1", b: "Multiple", c: "Multiple" },
  { k: "Unlimited free SSL", a: "Yes", b: "Yes", c: "Yes" },
  { k: "Automatic daily backups", a: "Yes", b: "Yes", c: "Yes" },
  { k: "Free website migration", a: "Yes", b: "Yes", c: "Yes" },
  { k: "Phone, WhatsApp & email support", a: "Yes", b: "Yes", c: "Yes" },
  { k: "Priority support queue", a: "—", b: "—", c: "Yes" },
  { k: "Advanced security features", a: "—", b: "—", c: "Yes" },
  { k: "30-day money-back (yearly)", a: "Yes", b: "Yes", c: "Yes" },
];

export const HOSTING_TIMELINE: readonly { d: string; t: string; b: string }[] = [
  { d: "DAY 1", t: "Account opens", b: "DirectAdmin access with the full plan. No card asked for, so nothing can be charged." },
  { d: "DAY 2–3", t: "We migrate, you review", b: "Send your current hosting details; our team copies the site over while your old host stays live." },
  { d: "BEFORE IT ENDS", t: "You hear from us", b: "Support checks in with what's left to do — the end date never arrives as a surprise." },
  { d: `DAY ${TRIAL_DAYS}`, t: "You decide", b: "Pick a plan and everything continues untouched, or let the account close. Both are one click." },
];

export const MIGRATION_NEED: readonly { n: string; t: string }[] = [
  { n: "01", t: "Your current hosting or cPanel login (or FTP details)" },
  { n: "02", t: "Access to your domain's DNS, or your registrar login" },
  { n: "03", t: "A time you're free for 10 minutes to check the copy" },
];

export const MIGRATION_WEDO: readonly string[] = [
  "Copy files, databases and email accounts across",
  "Set up unlimited free SSL and activate HTTPS",
  "Test the site on our servers before anything changes",
  "Switch DNS only after you approve — old host stays live till then",
];

export const HOSTING_WORRIES: readonly { q: string; a: string }[] = [
  { q: "Will my site go down during the move?", a: "No. The migrated copy is tested on our servers first and DNS is switched only after you approve it, so your live site keeps serving throughout." },
  { q: "Will it actually be faster?", a: "The platform is Google Cloud in Mumbai, with NVMe SSD storage. You have the whole trial to measure your own pages before paying anything." },
  { q: "What if support disappears after I pay?", a: `Support is on phone, WhatsApp and email, ${SLA.hours}, with a first reply ${SLA.firstReply}; Plus adds a priority queue. Test it during the trial — that is the point of the trial.` },
  { q: "What if I lose data?", a: "Automatic daily backups are included on every plan and are restorable. Ask support and they will walk a restore through with you." },
  { q: "Will the price jump at renewal?", a: "The renewal figure is printed on every plan card and matches the signup price. Yearly plans also carry a 30-day money-back guarantee." },
  { q: "Am I locked in?", a: "No lock-in: cancel any time, and your site is portable — download its files and databases from DirectAdmin whenever you like. We'd rather earn the renewal." },
];

/** Proof cards — PARTNERSHIP ("Premier Partner since 2014") removed until verified. */
export const HOSTING_PROOFS: readonly { k: string; v: string; a: string; href: string }[] = [
  { k: "UPTIME", v: "Live system status page, updated in real time", a: "Check status", href: "/status" },
  { k: "COMPANY", v: "Anutech Digital Pvt Ltd, Rohini, Delhi · GSTIN 07ABDCA0298H1ZP", a: "About the company", href: "/about" },
  { k: "TERMS", v: "Refund policy and terms published in plain language", a: "Read the refund policy", href: "/refund" },
];

export const HOSTING_GOOD_FIT: readonly string[] = [
  "Business, portfolio and brochure websites",
  "WordPress, WooCommerce and other one-click apps",
  "Moving off a slow or expensive shared host",
  "Teams who want a human on chat, ticket or phone",
  "Buyers who need a GST invoice on every payment",
];

export const HOSTING_BAD_FIT: readonly string[] = [
  "Heavy custom applications that need a dedicated server or VPS — ask us instead",
  "Anything used for spam, phishing or infringing downloads",
  "Bulk email sending from the hosting server",
  "A requirement for on-premise or a specific non-Google cloud",
];

export const HOSTING_CHANNELS: readonly { t: string; d: string; a: string; href: string }[] = [
  { t: "WhatsApp", d: "Fastest for one quick question before you buy", a: "Chat now", href: WHATSAPP_URL },
  { t: "Written quote", d: "Prices, GST split and renewal in writing", a: "Request a quote", href: "/quote" },
  { t: "Support", d: "Setup and migration questions, answered by a person", a: "Ask us", href: "/contact" },
  { t: "All prices", d: "Domains, email and add-ons, itemised", a: "Open the rate card", href: "/rates" },
];

export const HOSTING_FAQS_V2: readonly { q: string; a: string }[] = [
  { q: `How does the ${TRIAL_DAYS}-day free trial work?`, a: "The trial is on the Starter plan, monthly or yearly — Standard and Plus are bought, not trialled. You get a real Starter hosting account with full access to every feature — storage, unlimited free SSL, one-click WordPress and support. Nothing is throttled. Before the trial ends you choose a plan to keep everything as it is (moving up to Standard or Plus carries the site over), or simply let it close." },
  { q: "Do I need a credit card to start?", a: "No. The trial asks for no card, which is also why nothing can be auto-charged when it ends. You reach a payment page only when you decide to buy." },
  { q: "Can you move my existing website for free?", a: "Yes, free website migration is included on every plan and on the trial. Share your current hosting login and our team moves the site for you. Your old host keeps serving traffic until you have checked the copy and approved the switch." },
  { q: "What happens after the trial if I don't buy?", a: "The account closes and you are never charged, because we never held a card. If you want your files first, ask support and we'll help you take them." },
  { q: "Is the renewal price higher than the first-year price?", a: "No. Each plan card prints the renewal figure next to the price, and they are the same number. There is no introductory rate here." },
  { q: "Do you offer a money-back guarantee?", a: "Yes — a 30-day money-back guarantee on yearly plans, on top of the free trial. Refunds follow our published refund policy." },
  { q: "Can I upgrade or downgrade my plan later?", a: "Any time, from the client area, and support can do it for you. Because all three plans run on the same platform, changing plan does not mean rebuilding or moving the website." },
];

/**
 * "From ₹…/mo" wherever hosting is advertised (home card, menu, catalogue copy). Until
 * 2 Oct 2026 those said ₹159 from an old table while /hosting sold Starter at ₹49.99 — two
 * prices for one plan. Derived here so they cannot drift again.
 */
export const HOSTING_FROM_MO: string = `₹${Math.min(...HOSTING_TIERS.map((t) => t.yearlyMo))}`;
