/**
 * About ResellerOS — founding story + mission + the team.
 *
 * Public marketing page. Customers want to know who they're buying from,
 * especially in B2B SaaS. This page builds trust by being honest about who
 * we are and why this product exists.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { PublicShell } from "../_components/public-shell";
import { PLATFORM_OPERATOR } from "@/lib/platform";
import { PRICING_LINE } from "@/site/lib/data/reselleros-home";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "About — ResellerOS",
  description: "ResellerOS — built by an Indian cloud reseller, for Indian cloud resellers.",
};

export default function AboutPage() {
  return (
    <PublicShell title="About ResellerOS" subtitle="Built by an Indian cloud reseller, for Indian cloud resellers.">
      <div className="space-y-8">
        {/* Founder section */}
        <section>
          <Badge kind="info" dot className="mb-4">The story</Badge>
          <p className="text-lg leading-relaxed text-ink-2">
            ResellerOS was born out of frustration. After 12+ years running{" "}
            <b>ANUTECH DIGITAL</b> — a Delhi-based Google Workspace, Microsoft
            365, and Zoho reseller — I was juggling 5-7 disconnected tools just
            to run the business: a spreadsheet for leads, Tally for invoices,
            Zoho Books for accounting, WhatsApp for follow-ups, email for
            quotes, paper for bank reconciliation, and a dozen browser tabs.
          </p>
          <p className="text-lg leading-relaxed text-ink-2 mt-4">
            None of them <i>knew</i> about each other. Every customer
            interaction needed me to copy data between 3-4 systems. Renewals
            got missed. Margins got fuzzy. GST filings became a quarterly
            crisis.
          </p>
          <p className="text-lg leading-relaxed text-ink-2 mt-4">
            <b>So I built the OS I wished I&rsquo;d had on day one.</b>
          </p>
        </section>

        {/* Mission */}
        <section>
          <h2 className="font-serif text-2xl mb-3">Our mission</h2>
          <p className="text-base leading-relaxed text-ink-2">
            Help every Indian cloud reseller — from solo SaaS hustlers to
            100-employee distributors — run a tighter, more profitable
            business with one tool instead of seven. Lead to renewal. Bank
            to bookkeeping. GST to growth.
          </p>
        </section>

        {/* What we are */}
        <section>
          <h2 className="font-serif text-2xl mb-3">What ResellerOS is</h2>
          <ul className="space-y-2 text-base text-ink-2">
            <li>✔ A complete CRM for cloud reseller leads + deals</li>
            <li>✔ A quote builder that knows Indian commitment + billing nuances</li>
            <li>✔ A GST-compliant invoicing engine (HSN 998313 built-in)</li>
            <li>✔ A renewal automation engine that won&rsquo;t let a customer churn silently</li>
            <li>✔ A bank reconciliation module that imports statements + auto-matches</li>
            <li>✔ Quote links your customers open, accept and pay from — no login needed</li>
            <li>✔ A WhatsApp + email engine to nudge prospects without leaving the app</li>
            <li>✔ A reporting layer that finally tells you who&rsquo;s actually profitable</li>
          </ul>
        </section>

        {/* What we're not */}
        <section>
          <h2 className="font-serif text-2xl mb-3">What ResellerOS isn&rsquo;t</h2>
          <ul className="space-y-2 text-base text-ink-2">
            <li>✘ A generic CRM like HubSpot — we&rsquo;re Indian-reseller specific</li>
            <li>✘ A full accounting system like Tally — but we hand off cleanly</li>
            <li>✘ A no-code platform — opinionated workflows by design</li>
            <li>✘ Built for global SaaS — INR, GST, IFSC, GSTIN at the core</li>
          </ul>
        </section>

        {/* First customer */}
        <section className="rounded-md border border-amber/30 bg-amber-soft/30 p-5">
          <Badge kind="warning" size="sm" dot className="mb-2">Dogfooding</Badge>
          <p className="text-base text-ink-2 leading-relaxed">
            <b>ANUTECH DIGITAL is our first customer.</b> Every feature you
            see has been battle-tested against our own operations — quotes
            we&rsquo;ve sent, payments we&rsquo;ve received, GST returns
            we&rsquo;ve filed, customers we&rsquo;ve renewed. If it doesn&rsquo;t
            work for us, it doesn&rsquo;t ship to you.
          </p>
        </section>

        {/* Founder card */}
        <section>
          <h2 className="font-serif text-2xl mb-4">Founded by</h2>
          <div className="rounded-md border border-hairline bg-paper-2/30 p-5 flex items-start gap-4">
            <div className="w-14 h-14 rounded-full bg-amber-soft flex items-center justify-center text-amber-ink font-serif text-xl shrink-0">
              PS
            </div>
            <div className="min-w-0">
              <p className="font-medium text-ink">Pardeep Sharma</p>
              <p className="text-sm text-ink-3 mt-0.5">
                Founder · ANUTECH DIGITAL PVT LTD · Delhi
              </p>
              <p className="text-[13px] text-ink-2 mt-2 leading-relaxed">
                12+ years as a Google Workspace + M365 reseller. Built ResellerOS
                from the constraints of operating his own business. Background
                in distribution, customer success, and tax compliance.
              </p>
            </div>
          </div>
        </section>

        {/* Company facts */}
        <section>
          <h2 className="font-serif text-2xl mb-3">Company facts</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            {/* "Hosted in Mumbai" neeche JAAN-BOOJHKAR raha — wo Google Cloud ka region
                hai, company ka sheher nahi. Company Delhi ki hai. */}
            <Fact label="Legal entity"      value={PLATFORM_OPERATOR.legalName} />
            <Fact label="GSTIN"             value={PLATFORM_OPERATOR.gstin} />
            <Fact label="Country"           value="India" />
            <Fact label="Headquarters"      value="Rohini, Delhi" />
            <Fact label="Hosted in"         value="Google Cloud, Mumbai (asia-south1)" />
            <Fact label="Database"          value="Supabase Postgres (Mumbai)" />
            <Fact label="Payments"          value="Razorpay (PCI-DSS compliant)" />
            <Fact label="Data privacy"      value="DPDP Act 2023 compliant" />
            <Fact label="GST compliance"    value="HSN 998313 · CGST §31" />
          </dl>
        </section>

        {/* CTA */}
        <section className="text-center py-8 border-t border-hairline">
          <h2 className="font-serif text-2xl mb-3">Ready to try ResellerOS?</h2>
          <p className="text-base text-ink-3 mb-6">
            {PRICING_LINE}
          </p>
          <div className="flex gap-3 justify-center flex-wrap">
            <Button asChild variant="primary" iconRight="arrow_right">
              <Link href="/signup">Get started free</Link>
            </Button>
            <Button asChild variant="default">
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
        </section>
      </div>
    </PublicShell>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-hairline pb-2">
      <dt className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-0.5">
        {label}
      </dt>
      <dd className="text-ink font-medium">{value}</dd>
    </div>
  );
}
