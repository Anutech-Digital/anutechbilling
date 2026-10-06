/**
 * Privacy Policy — DPDP Act 2023 compliant (India).
 *
 * Static server-rendered page. Disclose:
 *   • What we collect (auth, transactional, lead/customer data)
 *   • Why (operate the SaaS, deliver invoices, reconcile payments)
 *   • Sub-processors (Supabase, Razorpay, Resend, Gupshup, Sandbox, etc.)
 *   • User rights (access, correction, deletion, grievance redressal)
 *   • Data location + retention
 *   • Contact / DPO
 *
 * Drafted with India's Digital Personal Data Protection Act, 2023 + global
 * standards (GDPR-compatible language) in mind. Not legal advice — operator
 * should have counsel review before going live with paying customers.
 */
import type { Metadata } from "next";
import {
  PublicShell, Intro, TOC, Section, Callout, FooterMeta,
} from "../_components/public-shell";
import { PLATFORM_OPERATOR } from "@/lib/platform";

export const metadata: Metadata = {
  title: "Privacy Policy — ResellerOS",
  description: "How ResellerOS collects, uses, and protects your data. DPDP Act 2023 compliant.",
};

/* 26 Aug 2026 ko badla kyunki SERVICE CHALANE WALI ENTITY badli: dastavez pehle "Excel
   Technologies Pvt Ltd" ko operator batata tha, jo ek doosri legal entity hai (uska GSTIN
   ek proprietorship ka hai — dekho lib/platform.ts). Privacy Policy me operator ka naam
   badalna aur taareekh purani chhod dena wahi jhooth hai jise ye badlav theek karne aaya
   hai — padhne wale ko lagega ki May se yahi likha tha. */
const LAST_UPDATED = "26 Aug 2026";

export default function PrivacyPage() {
  return (
    <PublicShell title="Privacy Policy" subtitle={`Last updated: ${LAST_UPDATED}`}>
      <Intro>
        {PLATFORM_OPERATOR.productName} is operated by <b>{PLATFORM_OPERATOR.legalName}</b>{" "}
        (GSTIN {PLATFORM_OPERATOR.gstin}) (&ldquo;ResellerOS&rdquo;,
        &ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;). This Privacy Policy explains how
        we collect, use, store, and share information when you use our SaaS platform
        for cloud resellers — accessible via <code>resellersos.in</code> and related
        subdomains. We comply with India&rsquo;s <b>Digital Personal Data Protection
        Act, 2023</b> (&ldquo;DPDP Act&rdquo;).
      </Intro>

      <TOC items={TOC_ITEMS} />

      <Section id="data-we-collect" n={1} title="Information we collect">
        <p>We collect only what we need to deliver ResellerOS reliably:</p>
        <ul className="list-disc pl-5 space-y-1.5 mt-2">
          <li>
            <b>Account data</b> — your name, business name, work email,
            phone number, and password (stored hashed).
          </li>
          <li>
            <b>Business identifiers</b> — GSTIN, PAN, state, and address —
            for GST-compliant invoicing.
          </li>
          <li>
            <b>Operational data</b> — leads, customers, quotes, invoices,
            subscriptions, payments, and bank transactions <em>you create</em>
            in ResellerOS.
          </li>
          <li>
            <b>Communication logs</b> — emails / WhatsApp messages sent via
            our platform, including their delivery status.
          </li>
          <li>
            <b>Technical data</b> — IP address, browser type, device, and
            timestamps (server logs, kept for 90 days for security).
          </li>
        </ul>
        <Callout tone="info">
          <b>What we do NOT store:</b> Full bank account numbers (only last 4
          digits + IFSC), payment card details (handled by Razorpay), or
          full Google OAuth tokens (Supabase Auth manages session JWTs only).
        </Callout>
      </Section>

      <Section id="how-we-use" n={2} title="How we use your information">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>To deliver core ResellerOS functionality (CRUD, reporting, automations).</li>
          <li>To process payments and issue GST-compliant invoices on your behalf.</li>
          <li>To send transactional emails (quotes, renewals, receipts) you initiate.</li>
          <li>To respond to support requests.</li>
          <li>To detect fraud, abuse, and security incidents.</li>
          <li>To comply with our legal obligations under Indian law.</li>
        </ul>
        <p className="mt-3">
          We <b>do not</b> sell your data. We do not use your customer or
          lead data to train AI models. We do not run advertising.
        </p>
      </Section>

      <Section id="sub-processors" n={3} title="Sub-processors">
        <p>
          We use the following carefully selected service providers. Each is
          contractually bound to data protection standards equivalent to or
          stricter than the DPDP Act:
        </p>
        <table className="w-full mt-3 text-sm">
          <thead className="border-b border-hairline text-left text-2xs uppercase tracking-wider text-ink-3">
            <tr>
              <th className="py-2 pr-3 font-semibold">Provider</th>
              <th className="py-2 pr-3 font-semibold">Purpose</th>
              <th className="py-2 font-semibold">Data location</th>
            </tr>
          </thead>
          <tbody className="text-ink-2">
            {SUB_PROCESSORS.map((s) => (
              <tr key={s.name} className="border-b border-hairline last:border-b-0">
                <td className="py-2 pr-3 font-medium text-ink">{s.name}</td>
                <td className="py-2 pr-3">{s.purpose}</td>
                <td className="py-2 text-ink-3">{s.location}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section id="data-location" n={4} title="Where we store your data">
        <p>
          Your data lives on <b>Supabase Postgres in Mumbai (asia-south1)</b>,
          with Row-Level Security ensuring each tenant only sees their own
          data. Application servers run on <b>Google Cloud Run</b> in the
          same Mumbai region. Backups are encrypted at rest and replicated
          within India.
        </p>
      </Section>

      <Section id="retention" n={5} title="Data retention">
        <p>
          We retain your operational data <b>as long as your account is
          active</b>. If you cancel, we keep your data for an additional
          <b> 90 days</b> in case you want to reactivate, then permanently
          delete it (except records we&rsquo;re legally required to keep,
          such as GST invoices for 6 years under CGST Section 36).
        </p>
      </Section>

      <Section id="your-rights" n={6} title="Your rights (DPDP Act 2023)">
        <p>You have the right to:</p>
        <ul className="list-disc pl-5 space-y-1.5 mt-2">
          <li><b>Access</b> the personal data we hold about you</li>
          <li><b>Correct</b> any inaccurate or incomplete data</li>
          <li><b>Erase</b> your data (subject to legal retention requirements)</li>
          <li><b>Withdraw consent</b> for non-essential processing at any time</li>
          <li><b>Grievance redressal</b> — see Section 9 for our DPO contact</li>
          <li><b>Nominate another person</b> to exercise these rights in case of death/incapacity</li>
        </ul>
        <p className="mt-3">
          To exercise these rights, email{" "}
          <a href="mailto:privacy@resellersos.in" className="text-amber underline">
            privacy@resellersos.in
          </a>
          . We respond within <b>7 working days</b> (DPDP requirement: 30 days).
        </p>
      </Section>

      <Section id="security" n={7} title="Security">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>All data in transit is encrypted with TLS 1.3</li>
          <li>Database backups encrypted at rest (AES-256)</li>
          <li>Row-Level Security on every table — no cross-tenant data leakage</li>
          <li>Passwords stored using bcrypt (salted)</li>
          <li>OAuth sessions use HTTPOnly + Secure + SameSite cookies</li>
          <li>Service-role keys never exposed to client browsers</li>
        </ul>
      </Section>

      <Section id="cookies" n={8} title="Cookies">
        <p>
          We use only <b>essential cookies</b> required to keep you signed in
          and maintain your session. No third-party advertising cookies,
          no behavioural tracking. Plausible Analytics (if enabled) is cookie-less
          and IP-anonymised.
        </p>
      </Section>

      <Section id="contact" n={9} title="Grievance contact / DPO">
        {/* The company, not a named person, is the grievance officer (Pawan, 5 Oct 2026). */}
        <p className="space-y-1">
          <strong className="text-ink">Grievance Officer / Data Protection Officer:</strong><br />
          {PLATFORM_OPERATOR.legalName}<br />
          {PLATFORM_OPERATOR.address}<br />
          Email:{" "}
          <a href="mailto:privacy@resellersos.in" className="text-amber underline">
            privacy@resellersos.in
          </a>
        </p>
        <p className="mt-3 text-[12px] text-ink-3">
          If you&rsquo;re dissatisfied with our response, you may approach the
          <b> Data Protection Board of India</b> (when constituted under the
          DPDP Act).
        </p>
      </Section>

      <Section id="changes" n={10} title="Changes to this policy">
        <p>
          We&rsquo;ll update this page with the new effective date if we change
          how we handle your data. Material changes will be emailed to all
          tenant owners at least <b>7 days</b> in advance.
        </p>
      </Section>

      <FooterMeta />
    </PublicShell>
  );
}

// ─── Data ──────────────────────────────────────────────────────────────────

const TOC_ITEMS: Array<{ id: string; label: string }> = [
  { id: "data-we-collect", label: "Information we collect" },
  { id: "how-we-use",      label: "How we use it" },
  { id: "sub-processors",  label: "Sub-processors" },
  { id: "data-location",   label: "Where it's stored" },
  { id: "retention",       label: "Retention" },
  { id: "your-rights",     label: "Your rights" },
  { id: "security",        label: "Security" },
  { id: "cookies",         label: "Cookies" },
  { id: "contact",         label: "Grievance / DPO" },
  { id: "changes",         label: "Changes" },
];

const SUB_PROCESSORS: Array<{ name: string; purpose: string; location: string }> = [
  { name: "Supabase",      purpose: "Postgres database, authentication, file storage", location: "Mumbai (asia-south1)" },
  { name: "Google Cloud Run", purpose: "Application hosting", location: "Mumbai (asia-south1)" },
  { name: "Razorpay",      purpose: "Payment processing",     location: "India" },
  { name: "Resend",        purpose: "Transactional email",    location: "EU + US" },
  { name: "Gupshup BSP",   purpose: "WhatsApp Business API",  location: "India" },
  { name: "Sandbox.co.in", purpose: "GSTIN verification",     location: "India" },
  { name: "Setu",          purpose: "Account Aggregator (when enabled)", location: "India" },
];

// Shared shells live in `_components/public-shell.tsx` and are imported above.
