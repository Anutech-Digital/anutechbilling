"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import React from "react";

/* ───────────────────────────────────────────────────────────────
   Hero — headline + product mockup
   ─────────────────────────────────────────────────────────────── */

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Soft warm radial backdrop — subtle amber wash with slow pulse */}
      <motion.div
        animate={{ opacity: [0.4, 0.7, 0.4], scale: [1, 1.05, 1] }}
        transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[640px]"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 0%, rgba(254, 215, 170, 0.6) 0%, rgba(250, 250, 249, 0) 70%)",
        }}
      />
      {/* Abstract floating elements in background */}
      <div className="absolute top-20 left-10 h-32 w-32 rounded-full bg-indigo/5 blur-3xl animate-float-1 pointer-events-none" />
      <div className="absolute top-40 right-20 h-48 w-48 rounded-full bg-amber/10 blur-3xl animate-float-2 pointer-events-none" />

      <div className="mx-auto max-w-6xl px-6 pt-12 pb-6 sm:pt-20">
        {/* Headline column */}
        <div className="mx-auto max-w-3xl text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <Badge kind="info" dot className="mb-5 shadow-sm">
              For Indian cloud resellers
            </Badge>
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="font-serif text-4xl leading-[1.05] tracking-tight sm:text-6xl"
          >
            One OS for your reseller business.
            <br className="hidden sm:block" />
            <span className="text-ink-3">No more juggling seven tools.</span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-ink-2 sm:text-lg"
          >
            ResellerOS handles leads, quotes, GST invoices, renewals, banking,
            and customer portal — purpose-built for Google Workspace, Microsoft 365,
            and Zoho resellers in India.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="mt-7 flex flex-wrap justify-center gap-3"
          >
            <Button asChild variant="primary" iconRight="arrow_right" size="lg" className="shadow-lg shadow-amber/20 hover:shadow-amber/40 transition-shadow">
              <Link href="/signup">Start free trial</Link>
            </Button>
            <Button asChild variant="default" size="lg" className="hover:bg-paper-2 transition-colors">
              <Link href="/login">Sign in</Link>
            </Button>
          </motion.div>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.6 }}
            className="mt-4 text-xs text-ink-3"
          >
            14-day trial · No credit card · ₹0 to get started
          </motion.p>
        </div>

        {/* Product mockup */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.4, ease: "easeOut" }}
          className="mx-auto mt-14 max-w-5xl group perspective-1000"
        >
          <div className="transition-transform duration-700 ease-out group-hover:rotate-x-2 group-hover:scale-[1.01]">
            <BrowserFrame title="resellersos.in · Dashboard">
              <DashboardMockup />
            </BrowserFrame>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────
   Trust ribbon
   ─────────────────────────────────────────────────────────────── */

export function TrustRibbon() {
  return (
    <section className="border-y border-hairline bg-paper-2/60 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-7 gap-y-2 px-6 py-5 font-mono text-[11px] uppercase tracking-wider text-ink-3">
        <span className="text-amber-ink font-semibold">★ Google Premier Partner · since 2014</span>
        <Dot />
        <span>🇮🇳 Built in Mumbai</span>
        <Dot />
        <span>GST + HSN 998313</span>
        <Dot />
        <span>DPDP Act 2023 ready</span>
        <Dot />
        <span>Hosted on Google Cloud Mumbai</span>
        <Dot />
        <span>Razorpay payouts</span>
      </div>
    </section>
  );
}

function Dot() {
  return <span aria-hidden className="hidden sm:inline text-ink-3/40">●</span>;
}

/* ───────────────────────────────────────────────────────────────
   Pain section — "If this sounds familiar"
   ─────────────────────────────────────────────────────────────── */

export function PainSection() {
  const pains = [
    {
      icon: "inbox",
      title: "Lead chaos",
      body: "Spreadsheet for leads. WhatsApp for follow-ups. Memory for what was said.",
    },
    {
      icon: "receipt",
      title: "Quote → invoice friction",
      body: "Tally or Zoho Books for invoices. Re-typing customer details every quote.",
    },
    {
      icon: "link",
      title: "Bank + renewal slips",
      body: "Bank reconciliation on paper. Renewal reminders that get missed.",
    },
    {
      icon: "alert",
      title: "GST quarterly crisis",
      body: "Filings done at the eleventh hour. Margins that stay fuzzy.",
    },
  ] as const;

  return (
    <section className="mx-auto max-w-5xl px-6 py-20 sm:py-24">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.5 }}
        className="mx-auto mb-12 max-w-2xl text-center"
      >
        <Badge kind="warning" size="sm" dot className="mb-3">
          If this sounds familiar
        </Badge>
        <h2 className="font-serif text-3xl leading-tight tracking-tight sm:text-4xl">
          You&rsquo;re running a reseller business
          <br className="hidden sm:block" /> across seven apps.
        </h2>
      </motion.div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {pains.map((p, i) => (
          <motion.div
            key={p.title}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ duration: 0.4, delay: i * 0.1 }}
            className="group relative overflow-hidden rounded-xl border border-hairline bg-paper/80 p-5 backdrop-blur-sm transition-all hover:border-rose/30 hover:shadow-md hover:-translate-y-0.5"
          >
            <div className="mb-3 flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-md bg-rose/10 text-rose transition-colors group-hover:bg-rose/20">
                <Icon name={p.icon as never} className="h-4 w-4" />
              </span>
              <h3 className="font-serif text-base tracking-tight">{p.title}</h3>
            </div>
            <p className="text-sm leading-relaxed text-ink-2">{p.body}</p>
            {/* Decorative rose accent line */}
            <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-rose/50 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
          </motion.div>
        ))}
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────
   Module showcase
   ─────────────────────────────────────────────────────────────── */

export function ModuleShowcase() {
  return (
    <section className="border-y border-hairline bg-paper-2/40 relative overflow-hidden">
      {/* Background soft glow */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(254,215,170,0.1)_0,transparent_100%)] pointer-events-none" />
      
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="mx-auto mb-14 max-w-2xl text-center"
        >
          <Badge kind="success" size="sm" dot className="mb-3 shadow-sm">
            What&rsquo;s inside
          </Badge>
          <h2 className="font-serif text-3xl leading-tight tracking-tight sm:text-4xl">
            17 modules. One database.
            <br className="hidden sm:block" /> Built to talk to each other.
          </h2>
          <p className="mt-3 text-base leading-relaxed text-ink-2">
            A lead becomes a quote becomes an invoice becomes a subscription
            becomes a renewal — with zero re-typing.
          </p>
        </motion.div>

        {/* Detailed alternating rows */}
        <div className="space-y-16 sm:space-y-24">
          <ModuleRow
            badge="01 · Pipeline"
            title="From inbox to ₹ won, in one view."
            body="A unified pipeline replaces your spreadsheets. Smart Views chip the right deals to the top. Today Strip surfaces what needs follow-up before lunch."
            features={[
              "Lead → Deal split for sales workflow",
              "Kanban + list + smart filters",
              "Inline call / email / WhatsApp",
            ]}
            mockup={<KanbanMockup />}
          />
          <ModuleRow
            reverse
            badge="02 · Quotes"
            title="GST-compliant quotes in 90 seconds."
            body="5 commitment types × 2 pricing tiers, per-line discounts, prospect mode. CGST/SGST split is calculated, not handcrafted. Send as PDF + WhatsApp + email — auto-tracked."
            features={[
              "CGST §31 compliant numbering",
              "Multi-tier price catalog with wholesale",
              "Send + audit log + accept page",
            ]}
            mockup={<QuoteBuilderMockup />}
          />
          <ModuleRow
            badge="03 · Renewals"
            title="Renewals on autopilot, with grace."
            body="T-30, T-15, T-7, T-0 cadence. Reminder emails. Auto-suspend with grace window. Renewal quote drafted on day one — operator just clicks send."
            features={[
              "Auto-generated renewal quotes",
              "Configurable grace period per tenant",
              "Daily cron, idempotent + safe",
            ]}
            mockup={<RenewalTimelineMockup />}
          />
          <ModuleRow
            reverse
            badge="04 · Banking"
            title="Bank reconciliation that knows what 'Razorpay-2026-05' means."
            body="CSV import for HDFC, ICICI, SBI, Axis, Kotak, IndusInd, Yes Bank. Auto-match suggestions with confidence pills. Setu Account Aggregator ready for live fetch."
            features={[
              "7 bank parsers, period-suffix safe",
              "Exact / high / low match suggestions",
              "Manual reconcile escape hatch",
            ]}
            mockup={<BankingMockup />}
          />
        </div>

        {/* Compact grid for remaining modules */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="mt-20"
        >
          <p className="mb-6 text-center font-mono text-[11px] uppercase tracking-wider text-ink-3">
            Plus 8 more modules
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <CompactModule icon="cart"          title="Razorpay + buy pages"   body="Public checkout, coupons, site promos." />
            <CompactModule icon="chart"         title="Accounting layer"        body="P&L, aging, MRR/ARR/Churn/LTV." />
            <CompactModule icon="rupee"         title="TDS receivable"          body="Form 16A upload, 26AS reconcile." />
            <CompactModule icon="users"         title="Customer portal"         body="Magic-link, invoices, tickets." />
            <CompactModule icon="whatsapp"      title="WhatsApp + email"        body="Gupshup BSP, Resend, PDF send." />
            <CompactModule icon="package"       title="Procurement"             body="POs, PO ↔ bill matching." />
            <CompactModule icon="award"         title="Partner channel"         body="Distributor ↔ reseller sync." />
            <CompactModule icon="check_circle"  title="GSTIN verification"      body="Sandbox.co.in + auto-fill." />
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function ModuleRow({
  badge,
  title,
  body,
  features,
  mockup,
  reverse = false,
}: {
  badge: string;
  title: string;
  body: string;
  features: string[];
  mockup: React.ReactNode;
  reverse?: boolean;
}) {
  return (
    <div className={`grid items-center gap-10 lg:grid-cols-2 lg:gap-16 ${reverse ? "lg:[&>*:first-child]:order-2" : ""}`}>
      {/* Copy column */}
      <motion.div
        initial={{ opacity: 0, x: reverse ? 30 : -30 }}
        whileInView={{ opacity: 1, x: 0 }}
        viewport={{ once: true, margin: "-50px" }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <p className="mb-3 font-mono text-[11px] uppercase tracking-wider text-amber font-semibold">
          {badge}
        </p>
        <h3 className="mb-3 font-serif text-2xl leading-tight tracking-tight sm:text-3xl">
          {title}
        </h3>
        <p className="mb-5 text-base leading-relaxed text-ink-2">{body}</p>
        <ul className="space-y-2">
          {features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-sm text-ink-2">
              <span className="mt-[5px] grid h-4 w-4 shrink-0 place-items-center rounded-full bg-emerald/10 text-emerald">
                <Icon name="check" className="h-3 w-3" />
              </span>
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </motion.div>
      {/* Mockup column */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true, margin: "-50px" }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="group perspective-1000"
      >
        <div className="transition-all duration-500 ease-out group-hover:rotate-y-2 group-hover:shadow-xl rounded-xl">
          {mockup}
        </div>
      </motion.div>
    </div>
  );
}

function CompactModule({
  icon,
  title,
  body,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  title: string;
  body: string;
}) {
  return (
    <div className="group rounded-lg border border-hairline bg-paper/70 p-4 backdrop-blur-sm transition-all duration-300 hover:border-amber/40 hover:shadow-md hover:-translate-y-1">
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-amber-soft text-amber-ink transition-transform duration-300 group-hover:scale-110">
          <Icon name={icon} className="h-3.5 w-3.5" />
        </span>
        <h4 className="font-serif text-sm tracking-tight">{title}</h4>
      </div>
      <p className="text-xs leading-relaxed text-ink-3">{body}</p>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Why pick us — 3 cards with numeric badges
   ─────────────────────────────────────────────────────────────── */

export function WhyUs() {
  const cards = [
    {
      num: "01",
      title: "Built by a reseller",
      body: "12+ years running Excel Technologies — a Mumbai-based GW/M365/Zoho reseller. Every workflow comes from real operational pain, not feature-list bingo.",
    },
    {
      num: "02",
      title: "GST-first by design",
      body: "HSN 998313, CGST §31 invoice numbering, intra/inter-state tax split, advance receipts — built into the schema, not bolted on as plugins.",
    },
    {
      num: "03",
      title: "No drift from Excel Tech",
      body: "Excel Technologies is our first customer. If a feature doesn't work for us in production, it doesn't ship. Zero theoretical features.",
    },
  ];

  return (
    <section className="mx-auto max-w-5xl px-6 py-20 sm:py-24 relative">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
        className="mb-12 text-center"
      >
        <h2 className="font-serif text-3xl leading-tight tracking-tight sm:text-4xl">
          Why pick ResellerOS over a generic CRM
        </h2>
      </motion.div>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {cards.map((c, i) => (
          <motion.div
            key={c.num}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: i * 0.1 }}
            className="group relative rounded-xl border border-hairline bg-gradient-to-b from-paper to-paper/50 p-6 backdrop-blur-sm transition-all duration-300 hover:border-amber/30 hover:shadow-lg hover:-translate-y-1"
          >
            <span className="absolute right-5 top-5 font-serif text-2xl text-ink-3/30 transition-colors duration-300 group-hover:text-amber/40">
              {c.num}
            </span>
            <h3 className="mb-2 max-w-[80%] font-serif text-lg leading-tight tracking-tight">
              {c.title}
            </h3>
            <p className="text-sm leading-relaxed text-ink-2">{c.body}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────
   Founder section — editorial pull quote
   ─────────────────────────────────────────────────────────────── */

export function FounderSection() {
  return (
    <section className="border-y border-hairline bg-paper">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          {/* Quote column */}
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <Icon name="sparkles" className="mb-4 h-5 w-5 text-amber" />
            <blockquote className="font-serif text-3xl leading-[1.15] tracking-tight text-ink sm:text-4xl">
              &ldquo;I built the OS I wished I&rsquo;d had on day one.&rdquo;
            </blockquote>
            <div className="mt-6 flex items-center gap-3">
              <div className="h-px w-10 bg-ink-3/40" />
              <div>
                <p className="font-medium text-ink">Pardeep A</p>
                <p className="font-mono text-[11px] uppercase tracking-wider text-ink-3">
                  Founder · Excel Technologies · Mumbai
                </p>
              </div>
            </div>
          </motion.div>

          {/* Founder card column */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="rounded-xl border border-hairline bg-paper-2/40 p-6 sm:p-8 backdrop-blur-sm shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="mb-5 flex items-start gap-4">
              <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-amber-soft font-serif text-xl text-amber-ink shadow-inner">
                PA
              </div>
              <div>
                <p className="font-medium text-ink">Pardeep A</p>
                <p className="text-sm text-ink-3">
                  12+ years as a Google Workspace, M365 &amp; Zoho reseller
                </p>
              </div>
            </div>
            <p className="text-sm leading-relaxed text-ink-2">
              Built ResellerOS from the real constraints of operating his own
              business — payments missed, renewals slipped, GST filings done at
              the eleventh hour. Now sharing the tool with other resellers
              instead of keeping it inside Excel Tech.
            </p>
            <Link
              href={"/about" as never}
              className="mt-5 inline-flex items-center gap-1 text-sm font-medium text-amber hover:text-amber-ink transition-colors group"
            >
              Read the full story
              <Icon name="arrow_right" className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
            </Link>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────
   Beta pricing
   ─────────────────────────────────────────────────────────────── */

export function BetaPricing() {
  return (
    <section className="relative overflow-hidden border-b border-hairline">
      {/* Soft amber wash animated */}
      <motion.div
        animate={{ opacity: [0.3, 0.5, 0.3] }}
        transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(50% 60% at 50% 50%, rgba(254, 215, 170, 0.45) 0%, rgba(250, 250, 249, 0) 70%)",
        }}
      />
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6 }}
        className="mx-auto max-w-3xl px-6 py-16 text-center sm:py-20"
      >
        <Badge kind="warning" size="sm" dot className="mb-3 shadow-sm">
          Beta pricing
        </Badge>
        <h2 className="mb-3 font-serif text-3xl leading-tight tracking-tight sm:text-5xl">
          Free during beta.
        </h2>
        <p className="mx-auto max-w-xl text-base leading-relaxed text-ink-2">
          We&rsquo;re onboarding the first 10 paying resellers personally.
          Starter / Growth / Pro tiers launch once we hit ₹15K MRR.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-[11px] uppercase tracking-wider text-ink-3">
          <span>All features included</span>
          <Dot />
          <span>No seat limits</span>
          <Dot />
          <span>You decide when to start paying</span>
        </div>
      </motion.div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────
   Final CTA
   ─────────────────────────────────────────────────────────────── */

export function FinalCta() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-20 text-center sm:py-24 relative">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-64 w-64 rounded-full bg-amber/10 blur-3xl pointer-events-none" />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6 }}
      >
        <h2 className="mb-4 font-serif text-3xl leading-tight tracking-tight sm:text-5xl">
          Ready to leave the
          <br className="hidden sm:block" /> seven-tool circus?
        </h2>
        <p className="mx-auto mb-8 max-w-xl text-base leading-relaxed text-ink-2 relative z-10">
          Create your tenant, import your existing customers via CSV, and run
          your first GST-compliant invoice in under 10 minutes.
        </p>
        <div className="flex flex-wrap justify-center gap-3 relative z-10">
          <Button asChild variant="primary" iconRight="arrow_right" size="lg" className="shadow-lg shadow-amber/20 hover:shadow-amber/40 transition-shadow">
            <Link href="/signup">Start free trial</Link>
          </Button>
          <Button asChild variant="default" size="lg" className="hover:bg-paper-2 transition-colors">
            <Link href={"/about" as never}>Read the founder story</Link>
          </Button>
        </div>
      </motion.div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════
   CSS-only mockups (Enhanced with glassmorphism)
   ═══════════════════════════════════════════════════════════════ */

function BrowserFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-hairline/80 bg-paper/80 backdrop-blur-xl shadow-[0_30px_80px_-30px_rgba(28,25,23,0.25)] ring-1 ring-black/5">
      {/* Window chrome */}
      <div className="flex items-center gap-2 border-b border-hairline/60 bg-paper-2/40 px-4 py-2.5 backdrop-blur-md">
        <span className="h-2.5 w-2.5 rounded-full bg-rose/60 shadow-sm" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber/70 shadow-sm" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald/60 shadow-sm" />
        <div className="ml-3 flex-1 truncate rounded border border-hairline/60 bg-paper/50 px-3 py-1 text-center font-mono text-[10px] uppercase tracking-wider text-ink-3">
          {title}
        </div>
        <div className="hidden gap-1 sm:flex">
          <span className="h-1 w-1 rounded-full bg-ink-3/40" />
          <span className="h-1 w-1 rounded-full bg-ink-3/40" />
          <span className="h-1 w-1 rounded-full bg-ink-3/40" />
        </div>
      </div>
      {/* Content */}
      <div className="bg-paper/95">{children}</div>
    </div>
  );
}

function DashboardMockup() {
  return (
    <div className="flex min-h-[420px]">
      {/* Sidebar */}
      <aside className="hidden w-[180px] shrink-0 border-r border-hairline/60 bg-paper-2/30 p-3 sm:block backdrop-blur-md">
        <div className="mb-4 px-2 font-mono text-[9px] uppercase tracking-wider text-ink-3 font-semibold">
          Excel Tech
        </div>
        <SidebarItem icon="home"    label="Dashboard" active />
        <SidebarItem icon="target"  label="Leads"     badge="3" />
        <SidebarItem icon="file"    label="Quotes"    badge="2" />
        <SidebarItem icon="receipt" label="Invoices" />
        <SidebarItem icon="refresh" label="Renewals" />
        <SidebarItem icon="link"    label="Banking" />
        <div className="my-3 border-t border-hairline/60" />
        <SidebarItem icon="package" label="Catalog" />
        <SidebarItem icon="users"   label="Customers" />
        <SidebarItem icon="chart"   label="Reports" />
      </aside>

      {/* Main */}
      <div className="flex-1 p-5 sm:p-6 relative overflow-hidden">
        {/* Subtle background glow */}
        <div className="absolute top-0 right-0 h-64 w-64 bg-amber/5 blur-[100px] rounded-full pointer-events-none" />

        {/* Breadcrumb */}
        <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-ink-3">
          Friday, 29 May 2026
        </p>
        <h4 className="mb-4 font-serif text-lg tracking-tight">
          Good morning, Pardeep.
        </h4>

        {/* KPI strip */}
        <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <KpiTile label="MRR"        value="₹69.4K"  hint="4 active subs" />
          <KpiTile label="Pipeline"   value="₹96.3K"  hint="1 active deal" />
          <KpiTile label="Accepted"   value="₹6.3L"   hint="MTD · 4 quotes" />
          <KpiTile label="Renewals"   value="0"       hint="Next 30 days" />
        </div>

        {/* Quote table */}
        <div className="rounded-lg border border-hairline/60 bg-paper/80 shadow-sm backdrop-blur-sm">
          <div className="flex items-center justify-between border-b border-hairline/60 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <Icon name="file" className="h-3.5 w-3.5 text-ink-3" />
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
                Recent quotes
              </span>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-wider text-amber font-medium">
              View all →
            </span>
          </div>
          <table className="w-full">
            <tbody>
              <QuoteRow id="Q-2026-27-0005" who="Manoj"        plan="GW Starter"  amount="₹2.4L"  status="sent" />
              <QuoteRow id="Q-2026-27-0004" who="sunil loza"   plan="M365 Biz"    amount="₹28.9K" status="accepted" />
              <QuoteRow id="Q-2026-27-0003" who="TechVista"    plan="GW Business" amount="₹6.3L"  status="paid" />
              <QuoteRow id="Q-2026-27-0002" who="Excel"        plan="Zoho One"    amount="₹54K"   status="draft" />
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SidebarItem({
  icon,
  label,
  active = false,
  badge,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  active?: boolean;
  badge?: string;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] transition-colors ${
        active ? "bg-paper text-ink shadow-[0_1px_2px_rgba(28,25,23,0.08)] ring-1 ring-black/5" : "text-ink-2 hover:bg-paper/50 hover:text-ink"
      }`}
    >
      <Icon name={icon} className={`h-3.5 w-3.5 ${active ? "text-amber" : "text-ink-3"}`} />
      <span className="flex-1 font-medium">{label}</span>
      {badge && (
        <span className="rounded-full bg-amber-soft px-1.5 py-px font-mono text-[9px] text-amber-ink font-semibold">
          {badge}
        </span>
      )}
    </div>
  );
}

function KpiTile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-hairline/60 bg-paper/80 p-3 shadow-sm backdrop-blur-sm transition-transform hover:-translate-y-0.5 hover:shadow-md">
      <p className="font-mono text-[9px] uppercase tracking-wider text-ink-3 font-semibold">{label}</p>
      <p className="mt-0.5 font-serif text-lg leading-tight tracking-tight text-ink">{value}</p>
      <p className="text-[10px] text-ink-3">{hint}</p>
    </div>
  );
}

function QuoteRow({
  id,
  who,
  plan,
  amount,
  status,
}: {
  id: string;
  who: string;
  plan: string;
  amount: string;
  status: "draft" | "sent" | "accepted" | "paid";
}) {
  const statusStyle: Record<typeof status, string> = {
    draft:    "bg-ink-3/10 text-ink-3 border-ink-3/20",
    sent:     "bg-indigo/10 text-indigo border-indigo/20",
    accepted: "bg-amber-soft text-amber-ink border-amber/20",
    paid:     "bg-emerald/10 text-emerald border-emerald/20",
  };
  return (
    <tr className="border-b border-hairline/40 last:border-0 hover:bg-paper-2/30 transition-colors">
      <td className="px-4 py-2.5 font-mono text-[10px] text-ink-3">{id}</td>
      <td className="px-2 py-2.5 text-xs text-ink font-medium">{who}</td>
      <td className="hidden px-2 py-2.5 text-[11px] text-ink-2 sm:table-cell">{plan}</td>
      <td className="px-2 py-2.5 text-right font-serif text-sm tracking-tight text-ink">
        {amount}
      </td>
      <td className="px-4 py-2.5 text-right">
        <span className={`inline-block rounded-full px-2 py-px border font-mono text-[9px] uppercase tracking-wider font-semibold ${statusStyle[status]}`}>
          {status}
        </span>
      </td>
    </tr>
  );
}

/* ── Module mockups ────────────────────────────────────────────── */

function KanbanMockup() {
  const cols = [
    { name: "New",        items: [["Acme Corp", "₹84K"], ["BrightHR",  "₹54K"]] },
    { name: "Contacted",  items: [["DataCo",    "₹1.2L"]] },
    { name: "Quote Sent", items: [["TechVista", "₹2.4L"], ["GreenLeaf", "₹96K"]] },
    { name: "Won",        items: [["Manoj",     "₹6.3L"]] },
  ];

  return (
    <BrowserFrame title="resellersos.in/leads · Kanban">
      <div className="grid grid-cols-4 gap-2 bg-paper-2/30 p-3 backdrop-blur-md">
        {cols.map((c) => (
          <div key={c.name}>
            <div className="mb-2 flex items-center justify-between px-1.5">
              <span className="font-mono text-[9px] uppercase tracking-wider text-ink-3 font-semibold">
                {c.name}
              </span>
              <span className="font-mono text-[9px] text-ink-3 font-medium bg-paper px-1.5 rounded-full shadow-sm">
                {c.items.length}
              </span>
            </div>
            <div className="space-y-2">
              {c.items.map(([co, amt]) => (
                <div key={co} className="rounded-md border border-hairline/80 bg-paper p-2 shadow-sm transition-shadow hover:shadow-md cursor-pointer">
                  <p className="text-[11px] font-medium text-ink">{co}</p>
                  <p className="mt-0.5 font-serif text-xs tracking-tight text-amber">{amt}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </BrowserFrame>
  );
}

function QuoteBuilderMockup() {
  return (
    <BrowserFrame title="resellersos.in/quotes/new">
      <div className="p-4 sm:p-5 bg-paper/50 backdrop-blur-sm">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h4 className="font-serif text-base tracking-tight">New Quote</h4>
            <p className="font-mono text-[9px] text-ink-3">Q-2026-27-0042</p>
          </div>
          <Badge kind="warning" size="sm">Draft</Badge>
        </div>
        
        <div className="space-y-3">
          <div className="rounded-md border border-hairline/60 bg-paper p-3 shadow-sm">
            <p className="font-mono text-[9px] uppercase tracking-wider text-ink-3 font-semibold mb-1">Customer</p>
            <div className="flex items-center gap-2">
              <div className="h-6 w-6 rounded bg-indigo/10 flex items-center justify-center text-indigo font-serif text-[10px]">T</div>
              <div>
                <p className="text-xs font-medium">TechVista Solutions</p>
                <p className="text-[10px] text-ink-3">GSTIN: 27AADCB2230M1Z2</p>
              </div>
            </div>
          </div>
          
          <div className="rounded-md border border-hairline/60 bg-paper p-3 shadow-sm">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-hairline/40">
                  <th className="pb-2 font-mono text-[9px] uppercase text-ink-3">Item</th>
                  <th className="pb-2 font-mono text-[9px] uppercase text-ink-3 text-right">Qty</th>
                  <th className="pb-2 font-mono text-[9px] uppercase text-ink-3 text-right">Rate</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="py-2 text-xs font-medium">Google Workspace Business Standard</td>
                  <td className="py-2 text-xs text-right text-ink-2">50</td>
                  <td className="py-2 text-xs text-right text-ink-2">₹12,600/yr</td>
                </tr>
              </tbody>
            </table>
            <div className="border-t border-hairline/40 pt-2 mt-1 flex justify-between items-center">
              <span className="text-xs text-ink-3">Total (excl. GST)</span>
              <span className="font-serif text-sm">₹6,30,000</span>
            </div>
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}

function RenewalTimelineMockup() {
  return (
    <BrowserFrame title="resellersos.in/renewals/GW-882">
      <div className="p-4 sm:p-5 bg-paper/50 backdrop-blur-sm relative">
        <div className="absolute left-6 top-5 bottom-5 w-px bg-hairline/80 z-0" />
        
        <div className="space-y-4 relative z-10">
          <div className="flex gap-3">
            <div className="h-5 w-5 rounded-full bg-paper border-2 border-emerald flex items-center justify-center shrink-0 mt-0.5">
              <Icon name="check" className="h-3 w-3 text-emerald" />
            </div>
            <div>
              <p className="text-xs font-medium">T-30 Reminder Sent</p>
              <p className="text-[10px] text-ink-3">May 1, 2026 via Email</p>
            </div>
          </div>
          
          <div className="flex gap-3">
            <div className="h-5 w-5 rounded-full bg-paper border-2 border-emerald flex items-center justify-center shrink-0 mt-0.5">
              <Icon name="check" className="h-3 w-3 text-emerald" />
            </div>
            <div>
              <p className="text-xs font-medium">T-15 Quote Auto-drafted</p>
              <p className="text-[10px] text-ink-3">May 15, 2026 • Q-2026-27-0038</p>
            </div>
          </div>
          
          <div className="flex gap-3">
            <div className="h-5 w-5 rounded-full bg-amber-soft border-2 border-amber flex items-center justify-center shrink-0 mt-0.5 ring-2 ring-amber/20">
              <div className="h-1.5 w-1.5 rounded-full bg-amber-ink" />
            </div>
            <div className="bg-paper border border-amber/30 rounded-md p-2.5 shadow-sm flex-1">
              <p className="text-xs font-medium text-amber-ink">T-7 Final Reminder Due</p>
              <p className="text-[10px] text-ink-3 mb-2">May 23, 2026</p>
              <Button size="sm" variant="primary" className="h-6 text-[10px] px-2 w-full">Send WhatsApp + Email</Button>
            </div>
          </div>
          
          <div className="flex gap-3">
            <div className="h-5 w-5 rounded-full bg-paper border-2 border-hairline flex items-center justify-center shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium text-ink-3">T-0 Expiry & Grace Period</p>
              <p className="text-[10px] text-ink-3">May 30, 2026</p>
            </div>
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}

function BankingMockup() {
  return (
    <BrowserFrame title="resellersos.in/accounting/banking">
      <div className="p-3 sm:p-4 bg-paper/50 backdrop-blur-sm">
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 bg-[#004C8F] rounded flex items-center justify-center font-serif text-[10px] text-white">H</div>
            <span className="text-xs font-medium">HDFC Current •••• 1234</span>
          </div>
          <Badge kind="success" size="sm">Connected via Setu AA</Badge>
        </div>
        
        <div className="space-y-2">
          <div className="rounded-md border border-emerald/30 bg-emerald/5 p-2.5 flex justify-between items-center">
            <div>
              <p className="text-[11px] font-medium text-ink">UPI/TechVista/INV-0042</p>
              <p className="text-[9px] text-ink-3">May 28 • Cr</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-serif text-sm text-emerald">₹6,30,000</span>
              <span className="bg-emerald text-paper text-[9px] uppercase px-1.5 py-0.5 rounded font-mono tracking-wider">Matched</span>
            </div>
          </div>
          
          <div className="rounded-md border border-amber/30 bg-paper p-2.5 flex justify-between items-center shadow-sm relative overflow-hidden">
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-amber" />
            <div className="pl-2">
              <p className="text-[11px] font-medium text-ink">NEFT-SUNIL LOZA-HDFC</p>
              <p className="text-[9px] text-ink-3">May 27 • Cr</p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="font-serif text-sm text-emerald">₹28,900</span>
              <div className="flex gap-1">
                <button className="bg-amber-soft text-amber-ink text-[9px] uppercase px-1.5 py-0.5 rounded font-mono hover:bg-amber/30 transition-colors">Accept Match</button>
              </div>
            </div>
          </div>
          
          <div className="rounded-md border border-hairline/60 bg-paper p-2.5 flex justify-between items-center shadow-sm">
            <div>
              <p className="text-[11px] font-medium text-ink">AWS EMEA SARL</p>
              <p className="text-[9px] text-ink-3">May 25 • Dr</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-serif text-sm text-rose">₹12,450</span>
              <span className="border border-hairline text-ink-3 text-[9px] uppercase px-1.5 py-0.5 rounded font-mono">Unreconciled</span>
            </div>
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}
