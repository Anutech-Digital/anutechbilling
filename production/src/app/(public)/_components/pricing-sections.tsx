"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import React from "react";

/* ───────────────────────────────────────────────────────────────
   Hero
   ─────────────────────────────────────────────────────────────── */

export function PricingHero() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute top-0 inset-x-0 h-[400px] bg-[radial-gradient(ellipse_at_top,rgba(254,215,170,0.3)_0%,transparent_70%)] pointer-events-none -z-10" />
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mx-auto max-w-3xl px-6 pt-16 pb-8 text-center sm:pt-20"
      >
        <Badge kind="info" dot className="mb-5 shadow-sm">
          Pricing
        </Badge>
        <h1 className="font-serif text-4xl leading-[1.1] tracking-tight sm:text-5xl">
          Simple pricing.
          <br className="hidden sm:block" />
          <span className="text-ink-3">Built for Indian SME budgets.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-ink-2 sm:text-lg">
          Three tiers, all in INR. No per-seat gotchas, no surprise renewals,
          no enterprise sales calls. What you see is what you pay.
        </p>
      </motion.div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────
   Beta banner
   ─────────────────────────────────────────────────────────────── */

export function BetaBanner() {
  return (
    <motion.section 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, delay: 0.2 }}
      className="mx-auto max-w-3xl px-6"
    >
      <div className="relative overflow-hidden rounded-xl border border-amber/30 bg-amber-soft/30 p-5 sm:p-6 shadow-sm">
        <div className="absolute top-0 right-0 h-32 w-32 bg-amber/20 blur-2xl rounded-full pointer-events-none" />
        <div className="relative z-10 flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber text-paper shadow-sm">
            <Icon name="sparkles" className="h-4 w-4" />
          </span>
          <div className="flex-1">
            <p className="mb-1 font-mono text-[11px] uppercase tracking-wider text-amber-ink font-semibold">
              Beta · until 2026-09-01 or 10 paying customers
            </p>
            <h2 className="mb-2 font-serif text-xl tracking-tight text-ink sm:text-2xl">
              Free for the first 10 resellers. Personally onboarded.
            </h2>
            <p className="text-sm leading-relaxed text-ink-2">
              All features below are unlocked. You decide when to start paying —
              once you&rsquo;ve invoiced your first customer through ResellerOS,
              we&rsquo;ll talk pricing. If the tool doesn&rsquo;t pay for itself
              in 30 days, you don&rsquo;t.
            </p>
          </div>
        </div>
      </div>
    </motion.section>
  );
}

/* ───────────────────────────────────────────────────────────────
   Tier cards
   ─────────────────────────────────────────────────────────────── */

const TIERS = [
  {
    name: "Starter",
    audience: "Solo reseller or small team",
    monthly: 999,
    yearly: 9_990,
    accent: "indigo",
    features: [
      "1 user",
      "Up to 50 customers",
      "Unlimited leads + quotes",
      "GST-compliant invoicing (HSN 998313)",
      "Customer portal (magic link)",
      "WhatsApp single-line inbox",
      "CSV bank statement import",
      "Email support · 48-hour response",
    ],
    cta: "Start free trial",
    href: "/signup",
  },
  {
    name: "Growth",
    audience: "Growing reseller, 2-10 employees",
    monthly: 2_499,
    yearly: 24_990,
    accent: "amber",
    badge: "Most popular",
    features: [
      "Up to 5 users with role-based access",
      "Up to 500 customers",
      "Renewal automation (T-30 / T-15 / T-7 / T-0)",
      "Razorpay live mode + auto-receipt",
      "WhatsApp Business inbox (Gupshup BSP)",
      "Advanced reports (MRR, churn, aging)",
      "TDS receivable + Form 26AS",
      "Setu Account Aggregator (live bank sync)",
      "Email + WhatsApp support · 12-hour response",
    ],
    cta: "Start free trial",
    href: "/signup",
  },
  {
    name: "Pro",
    audience: "Distributor or 10+ employee reseller",
    monthly: 6_999,
    yearly: 69_990,
    accent: "ink",
    features: [
      "Unlimited users",
      "Unlimited customers",
      "Partner channel (distributor → reseller)",
      "Cross-tenant invoice → vendor bill mirror",
      "Custom domain for customer portal",
      "White-label PDF (your logo, your colors)",
      "Custom integrations (Tally, Zoho Books)",
      "Dedicated WhatsApp + Slack support · 4-hour response",
      "Quarterly review with the founder",
    ],
    cta: "Talk to sales",
    href: "mailto:hello@resellersos.in?subject=ResellerOS%20Pro%20enquiry",
  },
] as const;

export function TierCards() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-20 relative">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3 lg:gap-6">
        {TIERS.map((t, i) => (
          <TierCard key={t.name} tier={t} index={i} />
        ))}
      </div>
      <p className="mt-6 text-center text-xs text-ink-3">
        All prices in ₹ (INR), exclusive of 18% GST. Yearly billing saves 2 months.
      </p>
    </section>
  );
}

function TierCard({ tier, index }: { tier: (typeof TIERS)[number]; index: number }) {
  const isPopular = "badge" in tier && tier.badge;
  const monthlyPrice = tier.monthly.toLocaleString("en-IN");
  const yearlyMonthly = Math.round(tier.yearly / 12).toLocaleString("en-IN");

  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 * index }}
      className={`group relative flex flex-col rounded-2xl bg-paper/90 backdrop-blur-xl p-6 sm:p-7 transition-all duration-300 hover:-translate-y-2 hover:shadow-xl ${
        isPopular
          ? "border-amber/50 shadow-[0_20px_40px_-15px_rgba(194,65,12,0.15)] ring-1 ring-amber/20 hover:shadow-[0_30px_60px_-15px_rgba(194,65,12,0.3)]"
          : "border border-hairline hover:border-ink-3/30"
      }`}
    >
      {isPopular && (
        <>
          <div className="absolute inset-0 rounded-2xl border-2 border-transparent bg-[linear-gradient(135deg,var(--amber-soft),transparent,var(--amber-soft))] [mask-image:linear-gradient(white,white)] [-webkit-mask-composite:destination-out] opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" style={{ maskComposite: "exclude" }} />
          <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-amber to-orange-500 px-4 py-1 font-mono text-[10px] uppercase tracking-wider text-paper shadow-md">
            {tier.badge}
          </span>
        </>
      )}

      <div className="mb-1 relative z-10">
        <h3 className="font-serif text-2xl tracking-tight text-ink">
          {tier.name}
        </h3>
        <p className="text-sm text-ink-3">{tier.audience}</p>
      </div>

      <div className="mt-5 relative z-10">
        <div className="flex items-baseline gap-1">
          <span className="font-serif text-4xl tracking-tight text-ink">
            ₹{monthlyPrice}
          </span>
          <span className="text-sm text-ink-3">/ month</span>
        </div>
        <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-ink-3 font-semibold">
          Or ₹{yearlyMonthly}/mo billed yearly · save 2 months
        </p>
      </div>

      <ul className="my-6 space-y-2.5 border-t border-hairline/60 pt-5 text-sm text-ink-2 relative z-10">
        {tier.features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <span className="mt-[5px] grid h-4 w-4 shrink-0 place-items-center rounded-full bg-emerald/10 text-emerald transition-colors group-hover:bg-emerald/20">
              <Icon name="check" className="h-3 w-3" />
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto relative z-10">
        <Button asChild variant={isPopular ? "primary" : "default"} className={`w-full ${isPopular ? "shadow-lg shadow-amber/20 group-hover:shadow-amber/40 transition-shadow" : "group-hover:bg-paper-2"}`} iconRight={isPopular ? "arrow_right" : undefined}>
          {tier.href.startsWith("mailto:") ? (
            <a href={tier.href}>{tier.cta}</a>
          ) : (
            <Link href={tier.href}>{tier.cta}</Link>
          )}
        </Button>
        <p className="mt-2 text-center text-[11px] text-ink-3">
          {tier.name === "Pro" ? "Reply within 24 hours" : "14-day trial · No credit card"}
        </p>
      </div>
    </motion.div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Comparison
   ─────────────────────────────────────────────────────────────── */

export function Comparison({ comparisonData }: { comparisonData: any }) {
  return (
    <section className="border-y border-hairline bg-paper-2/40 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom,rgba(254,215,170,0.05)_0,transparent_100%)] pointer-events-none" />
      <div className="mx-auto max-w-6xl px-6 py-16 sm:py-20 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="mb-10 text-center"
        >
          <Badge kind="success" size="sm" dot className="mb-3 shadow-sm">
            Full comparison
          </Badge>
          <h2 className="font-serif text-3xl tracking-tight sm:text-4xl">
            Every feature, side by side.
          </h2>
        </motion.div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse bg-paper/50 backdrop-blur-sm rounded-xl overflow-hidden shadow-sm border border-hairline/60">
            <thead>
              <tr className="border-b border-hairline bg-paper-2/50">
                <th className="py-4 pr-4 pl-4 text-left font-mono text-[10px] uppercase tracking-wider text-ink-3"></th>
                {["Starter", "Growth", "Pro"].map((name) => (
                  <th
                    key={name}
                    className="py-4 px-3 text-center font-serif text-lg text-ink"
                  >
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparisonData.map((group: any) => (
                <ComparisonGroup key={group.group} group={group} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function ComparisonGroup({
  group,
}: {
  group: any;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={4}
          className="pt-6 pb-2 pl-4 font-mono text-[10px] uppercase tracking-wider text-amber font-semibold bg-paper/40"
        >
          {group.group}
        </td>
      </tr>
      {group.rows.map((row: any) => (
        <tr key={row.feature} className="border-b border-hairline/40 hover:bg-paper-2/60 transition-colors">
          <td className="py-3 pr-4 pl-4 text-sm text-ink-2 font-medium">{row.feature}</td>
          <ComparisonCell value={row.starter} />
          <ComparisonCell value={row.growth} />
          <ComparisonCell value={row.pro} />
        </tr>
      ))}
    </>
  );
}

function ComparisonCell({ value }: { value: string | boolean }) {
  if (value === true) {
    return (
      <td className="px-3 py-3 text-center">
        <motion.span 
          initial={{ scale: 0 }}
          whileInView={{ scale: 1 }}
          viewport={{ once: true }}
          transition={{ type: "spring", stiffness: 400, damping: 10 }}
          className="inline-grid h-5 w-5 place-items-center rounded-full bg-emerald/10 text-emerald shadow-sm"
        >
          <Icon name="check" className="h-3.5 w-3.5" />
        </motion.span>
      </td>
    );
  }
  if (value === false) {
    return (
      <td className="px-3 py-3 text-center text-ink-3/40">—</td>
    );
  }
  return (
    <td className="px-3 py-3 text-center font-mono text-[11px] text-ink-2">
      {value}
    </td>
  );
}

/* ───────────────────────────────────────────────────────────────
   FAQ
   ─────────────────────────────────────────────────────────────── */

export function PricingFAQ({ faqItems }: { faqItems: any }) {
  return (
    <section className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
        className="mb-10 text-center"
      >
        <Badge kind="info" size="sm" dot className="mb-3 shadow-sm">
          Common questions
        </Badge>
        <h2 className="font-serif text-3xl tracking-tight sm:text-4xl">
          The honest answers.
        </h2>
      </motion.div>

      <div className="space-y-3">
        {faqItems.map((item: any, i: number) => (
          <motion.details
            key={item.q}
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.3, delay: i * 0.05 }}
            className="group rounded-lg border border-hairline/80 bg-paper px-5 py-4 shadow-sm hover:shadow-md transition-shadow [&_summary::-webkit-details-marker]:hidden"
          >
            <summary className="flex cursor-pointer items-start justify-between gap-4 font-serif text-base tracking-tight text-ink hover:text-amber-ink transition-colors">
              <span>{item.q}</span>
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-paper-2 group-open:bg-amber-soft group-open:text-amber-ink transition-colors">
                <Icon
                  name="chevron_down"
                  className="mt-0.5 h-3.5 w-3.5 text-ink-3 transition-transform duration-300 group-open:-rotate-180 group-open:text-amber-ink"
                />
              </span>
            </summary>
            {/* We use standard CSS animation for details open since Framer Motion doesn't work out of the box with <details> unless we rebuild an accordion component */}
            <div className="overflow-hidden animate-accordion-down">
              <p
                className="mt-4 text-sm leading-relaxed text-ink-2 pt-3 border-t border-hairline/40"
                dangerouslySetInnerHTML={{ __html: item.a }}
              />
            </div>
          </motion.details>
        ))}
      </div>

      <p className="mt-8 text-center text-sm text-ink-3">
        More questions?{" "}
        <a
          href="mailto:hello@resellersos.in"
          className="font-medium text-amber hover:text-amber-ink transition-colors"
        >
          hello@resellersos.in
        </a>{" "}
        — we reply within a day, usually faster.
      </p>
    </section>
  );
}

export function PricingCTA() {
  return (
    <section className="border-t border-hairline bg-paper-2/30 relative overflow-hidden">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-64 w-64 rounded-full bg-indigo/5 blur-3xl pointer-events-none" />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
        className="mx-auto max-w-3xl px-6 py-16 text-center sm:py-20 relative z-10"
      >
        <h2 className="mb-4 font-serif text-3xl leading-tight tracking-tight sm:text-4xl">
          Try it free for 14 days.
        </h2>
        <p className="mx-auto mb-7 max-w-xl text-base leading-relaxed text-ink-2">
          No credit card. No sales call. Bring your existing leads via CSV and run
          a GST-compliant invoice in under 10 minutes.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Button asChild variant="primary" iconRight="arrow_right" size="lg" className="shadow-lg shadow-amber/20 hover:shadow-amber/40 transition-shadow">
            <Link href="/signup">Start free trial</Link>
          </Button>
          <Button asChild variant="default" size="lg" className="hover:bg-paper-2">
            <Link href="/">Back to home</Link>
          </Button>
        </div>
      </motion.div>
    </section>
  );
}
