/**
 * Pricing — public marketing page.
 *
 * Honest positioning during beta: free for first 10 paying resellers,
 * tier structure shown for transparency about what's coming. Prices
 * are aspirational targets aligned with the 90-day plan (₹15K MRR at
 * 10 customers = ~₹1,500/customer/month average).
 *
 * No paywall switches enabled in product yet — tier names + features
 * here are forward-looking. Update PROJECT_TRACKER + this page together
 * when we launch real billing.
 */
import type { Metadata } from "next";
import { PublicTopBar, PublicFooter } from "../_components/public-shell";
import {
  PricingHero,
  BetaBanner,
  TierCards,
  Comparison,
  PricingFAQ,
  PricingCTA,
} from "../_components/pricing-sections";

export const metadata: Metadata = {
  title: "Pricing — ResellerOS",
  description:
    "Free during beta. Starter / Growth / Pro tiers launch once we hit ₹15K MRR. All features included today.",
};

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-paper">
      <PublicTopBar />
      <main>
        <PricingHero />
        <BetaBanner />
        <TierCards />
        <Comparison comparisonData={COMPARISON} />
        <PricingFAQ faqItems={FAQ_ITEMS} />
        <PricingCTA />
      </main>
      <PublicFooter />
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Data
   ─────────────────────────────────────────────────────────────── */

const COMPARISON = [
  {
    group: "Limits",
    rows: [
      { feature: "Users",     starter: "1",        growth: "Up to 5", pro: "Unlimited" },
      { feature: "Customers", starter: "Up to 50", growth: "Up to 500", pro: "Unlimited" },
      { feature: "Quotes / mo", starter: "Unlimited", growth: "Unlimited", pro: "Unlimited" },
    ],
  },
  {
    group: "Core CRM",
    rows: [
      { feature: "Leads + Deal pipeline",   starter: true, growth: true, pro: true },
      { feature: "Quote builder (5 tiers)", starter: true, growth: true, pro: true },
      { feature: "GST invoices (HSN 998313)", starter: true, growth: true, pro: true },
      { feature: "Customer portal",         starter: true, growth: true, pro: true },
      { feature: "Smart Views + Kanban",    starter: true, growth: true, pro: true },
    ],
  },
  {
    group: "Automation",
    rows: [
      { feature: "Renewal cadence (T-30 → T-0)", starter: false, growth: true, pro: true },
      { feature: "Auto-suspend with grace",      starter: false, growth: true, pro: true },
      { feature: "WhatsApp Business inbox",      starter: "Single line", growth: true, pro: true },
      { feature: "Razorpay live mode",           starter: false, growth: true, pro: true },
      { feature: "Setu Account Aggregator",      starter: false, growth: true, pro: true },
    ],
  },
  {
    group: "Reports",
    rows: [
      { feature: "P&L + Customer Aging",   starter: true, growth: true, pro: true },
      { feature: "MRR / ARR / Churn / LTV", starter: false, growth: true, pro: true },
      { feature: "TDS receivable + 26AS", starter: false, growth: true, pro: true },
      { feature: "Per-customer profitability", starter: false, growth: true, pro: true },
    ],
  },
  {
    group: "Distributor features",
    rows: [
      { feature: "Partner channel (distributor → reseller)", starter: false, growth: false, pro: true },
      { feature: "Cross-tenant invoice mirror", starter: false, growth: false, pro: true },
      { feature: "Partner catalog sync", starter: false, growth: false, pro: true },
    ],
  },
  {
    group: "Branding + Support",
    rows: [
      { feature: "White-label PDFs",          starter: false, growth: false, pro: true },
      { feature: "Custom portal domain",      starter: false, growth: false, pro: true },
      { feature: "Custom integrations",       starter: false, growth: false, pro: "Tally + Zoho Books" },
      { feature: "Support response time",     starter: "48 hours · email", growth: "12 hours · email + WhatsApp", pro: "4 hours · WhatsApp + Slack" },
      { feature: "Quarterly founder review",  starter: false, growth: false, pro: true },
    ],
  },
];

const FAQ_ITEMS = [
  {
    q: "When does the beta pricing end?",
    a: "When we hit 10 paying customers or 1 September 2026, whichever comes first. After that, beta tenants stay on a grandfathered discount for 12 months.",
  },
  {
    q: "Why is Starter only 1 user?",
    a: "Most solo resellers run their entire business themselves. If you have 2 people sharing one login, that&rsquo;s fine — but we built role-based access (Growth tier) for teams who need clean audit trails.",
  },
  {
    q: "Do you offer monthly billing?",
    a: "Yes, all tiers can be paid monthly or yearly. Yearly saves you 2 months. You can switch between monthly and yearly at any time.",
  },
  {
    q: "What payment methods do you accept?",
    a: "UPI, Net Banking, all major credit/debit cards, and corporate cheques (Pro tier). Payouts via Razorpay so your invoice is GST-compliant for ITC claim.",
  },
  {
    q: "Can I import data from Tally / Zoho Books / Excel?",
    a: "Yes. CSV import is available for customers, contacts, and leads on all tiers. Live Tally + Zoho Books sync is included on Pro tier; we&rsquo;ll quote bespoke for Starter / Growth if you need it.",
  },
  {
    q: "What happens if I cancel?",
    a: "You keep access until the end of the billing cycle, then your tenant goes read-only for 90 days (download anything you need). After that, data is permanently deleted per our DPDP Act 2023 retention policy.",
  },
  {
    q: "Do you have a free forever plan?",
    a: "No — and we won&rsquo;t. We&rsquo;d rather give every paying customer real support than juggle a free tier we can&rsquo;t serve well. 14-day trial covers most evaluation needs.",
  },
  {
    q: "Is my data secure?",
    a: "Postgres with row-level security (you only see your tenant&rsquo;s data). Daily backups. Hosted on Google Cloud Mumbai (asia-south1) for India data residency. DPDP Act 2023 compliant. See our privacy policy for details.",
  },
];
