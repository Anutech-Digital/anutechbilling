/**
 * R-520 — every word on the ResellerOS homepage (reselleros.anutech.in), in ONE file.
 *
 * Short plain English. No price figure on this page (R-524): "Free during beta" and a link to
 * /pricing, which keeps the plans (OS_TIERS in ./reselleros.ts).
 *
 * OWNER_DECISIONS records Pardeep's calls (R-524); OWNER_TODO is what is still open.
 */
import { OS_TIERS } from "./reselleros";

/**
 * Owner decisions (Pardeep, 9 Oct 2026 — R-524) on R-520's open questions. Kept here so the
 * next person sees why the page says what it says.
 */
export const OWNER_DECISIONS = [
  { card: "R-463", decided: "Free during beta. No 14-day-trial wording anywhere on the product site (homepage + /signup)." },
  { card: "R-461", decided: "'Try the demo' = a read-only sample workspace, no signup (lib/demo/demo-account.ts). Shown only when DEMO_ENABLED=1." },
  { card: "R-524", decided: "No price figure on the homepage. The /pricing page keeps the plans." },
  { card: "R-524", decided: "Real screenshots from the demo data — the manager captures them into public/site/screens/ (SCREENS below)." },
] as const;

/** Still open — nothing is waiting on the owner right now. */
export const OWNER_TODO: readonly { card: string; question: string; usingNow: string }[] = [];

/**
 * Screenshot slots. TODO(manager, R-524): capture each one from the demo workspace at 1440x900
 * and save it at public<src> (e.g. public/site/screens/dashboard.png). A slot whose file is not
 * there yet is simply not shown — no broken image, no grey "SCREENSHOT" box.
 */
export const SCREENS = [
  { src: "/site/screens/dashboard.png", alt: "ResellerOS dashboard: money to collect, renewals due this month and MRR at a glance" },
  { src: "/site/screens/renewals.png", alt: "Renewals list: subscriptions renewing in the next 30 days and their reminders" },
  { src: "/site/screens/quote.png", alt: "A GST quote with the CGST and SGST split, ready to send to the customer as a link" },
  { src: "/site/screens/invoices.png", alt: "Invoices list with paid, overdue and not-yet-due GST invoices" },
] as const;

const BETA = OS_TIERS.find((t) => t.name === "Beta");

/** The ONE pricing line — hero, pricing block and /signup all read it (R-463, R-524). */
export const PRICING_LINE = "Free during beta · no card needed";

export const HOME = {
  title: "ResellerOS — software for Indian cloud and hosting resellers",
  description:
    "Customers, subscriptions, GST quotes and invoices, renewals and payments in one place. Built in India for Google Workspace, Microsoft 365, Zoho and hosting resellers.",
  eyebrow: "ResellerOS · by Anutech Digital",
  headline: "Run your reseller business from one place.",
  sub:
    "Customers, subscriptions, GST quotes and invoices, renewals and payments. Built for Indian Google Workspace, Microsoft 365, Zoho and hosting resellers.",
  ctaPrimary: "Get started free",
  ctaLogin: "Log in",
  ctaFeatures: "See features",
  ctaDemo: "Try the demo",
  demoNote: "Read-only sample workspace · no signup",
  /** One line per ?demo=<reason> that /api/public/demo-session or the middleware sends back. */
  demoMessages: {
    off: "The demo is not open yet. Get started free instead — it takes a minute.",
    busy: "Too many demo starts from your network. Please try again in a few minutes.",
    unavailable: "The demo is not available right now. Please try again in a little while.",
    ended: "Your demo session has ended. You can open it again any time.",
  } as Record<string, string>,
  whoTitle: "Who it is for",
  who: [
    { title: "Google Workspace and Microsoft 365 resellers", body: "Seats, editions and yearly or monthly terms for every customer." },
    { title: "Zoho resellers", body: "The same subscriptions, quotes and renewals, side by side." },
    { title: "Hosting and domain resellers", body: "Yearly plans with renewal reminders and GST invoices." },
  ],
  featuresTitle: "What you get",
  features: [
    { title: "Subscriptions", body: "Every subscription, seat and commitment term in one list." },
    { title: "GST quotes", body: "Customers open, accept and pay a quote from a link — no login." },
    { title: "GST invoices", body: "HSN 998313, CGST + SGST or IGST split, invoice numbering done for you." },
    { title: "Renewals", body: "Reminders 30, 15 and 7 days before, and on the day." },
    { title: "Payments", body: "Razorpay payments and bank statement matching." },
    { title: "Reports", body: "MRR, renewals due and money to collect, at a glance." },
  ],
  screensTitle: "See it",
  stepsTitle: "Start in three steps",
  steps: [
    { title: "Create your workspace", body: "Company details, GSTIN and invoice series. No card." },
    { title: "Import customers", body: "Customers and subscriptions from a CSV file." },
    { title: "Send your first quote", body: "Pick a customer and a plan. GST is worked out for you." },
  ],
  pricingTitle: "Pricing",
  /* R-524: no price figure on the homepage — the plan's name, who it is for and what you get. */
  pricingTier: BETA ? { name: BETA.name, note: BETA.note, lines: BETA.lines } : null,
  pricingMore: "Paid plans come later. See all plans",
  clientLoginLead: "Buy domains, hosting or email from Anutech?",
  clientLoginCta: "Customer login",
  companyLink: "Anutech Digital — company site",
} as const;
