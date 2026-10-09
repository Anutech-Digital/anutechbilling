/**
 * R-520 — every word on the ResellerOS homepage (reselleros.anutech.in), in ONE file.
 *
 * Short plain English. No invented prices: the only price shown is the published Beta tier
 * (₹0, OS_TIERS in ./reselleros.ts and the /pricing page); paid tiers are linked, not quoted.
 *
 * OWNER_TODO lists the copy that needs Pardeep's call. Until he answers, the page uses the
 * safe value written next to each item — nothing on the page contradicts another page.
 */
import { OS_TIERS } from "./reselleros";

export const OWNER_TODO = [
  {
    card: "R-463",
    question: "Which pricing line: 'Free during beta' or '14-day free trial'?",
    usingNow: "Free during beta (matches /pricing; the app has no 14-day cut-off today). /signup now reads the same line from this file.",
  },
  {
    card: "R-461",
    question: "Demo: a read-only sample account, or a video / screenshot tour?",
    usingNow: "No demo button (it used to open the login page). 'See features' scrolls down instead.",
  },
  {
    card: "R-520",
    question: "Hero headline and the three 'who it is for' lines — keep or rewrite?",
    usingNow: "The draft below, taken from the old /reselleros page's claims.",
  },
  {
    card: "R-520",
    question: "Real product screenshots for the homepage?",
    usingNow: "None — text only. The old page showed grey 'SCREENSHOT' boxes and a fake domain (resellersos.in).",
  },
] as const;

const BETA = OS_TIERS.find((t) => t.name === "Beta");

/** The ONE pricing line — hero, pricing block and /signup all read it (R-463). */
export const PRICING_LINE = "Free during beta · no card needed";

export const HOME = {
  title: "ResellerOS — software for Indian cloud and hosting resellers",
  description:
    "Customers, subscriptions, GST quotes and invoices, renewals and payments in one place. Built in India for Google Workspace, Microsoft 365, Zoho and hosting resellers.",
  eyebrow: "ResellerOS · by Anutech Digital",
  headline: "Run your reseller business from one place.",
  sub:
    "Customers, subscriptions, GST quotes and invoices, renewals and payments. Built for Indian Google Workspace, Microsoft 365, Zoho and hosting resellers.",
  ctaPrimary: "Start free trial",
  ctaLogin: "Log in",
  ctaFeatures: "See features",
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
  stepsTitle: "Start in three steps",
  steps: [
    { title: "Create your workspace", body: "Company details, GSTIN and invoice series. No card." },
    { title: "Import customers", body: "Customers and subscriptions from a CSV file." },
    { title: "Send your first quote", body: "Pick a customer and a plan. GST is worked out for you." },
  ],
  pricingTitle: "Pricing",
  pricingTier: BETA ? { name: BETA.name, price: BETA.price, note: BETA.note, lines: BETA.lines } : null,
  pricingMore: "Paid plans start later. See all plans",
  clientLoginLead: "Buy domains, hosting or email from Anutech?",
  clientLoginCta: "Customer login",
  companyLink: "Anutech Digital — company site",
} as const;
