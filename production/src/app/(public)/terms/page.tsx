/**
 * Terms of Service — ResellerOS, governed by Indian law (Maharashtra jurisdiction).
 *
 * Reasonable boilerplate for a B2B SaaS:
 *   • Account terms + acceptable use
 *   • Subscription + payment (Razorpay)
 *   • IP ownership (we own the platform, customer owns their data)
 *   • Warranty disclaimers + liability cap
 *   • Indemnification
 *   • Termination + data export window
 *   • Indian governing law + Mumbai jurisdiction
 *
 * Not legal advice. Operator should have counsel review before live use.
 */
import type { Metadata } from "next";
import {
  PublicShell, Intro, TOC, Section, Callout, FooterMeta,
} from "../_components/public-shell";
import { PLATFORM_OPERATOR } from "@/lib/platform";

export const metadata: Metadata = {
  title: { absolute: "ResellerOS terms of service" },
  description: "Terms governing your use of ResellerOS.",
};

/* 26 Aug 2026: operator entity badli (dekho privacy/page.tsx ka wahi comment). Terms me
   "Company" ka matlab hi badal gaya, isliye taareekh badalna zaroori hai — nahi to
   dastavez kehta hai ki ye shartein May se kisi AUR company ke saath thin. */
const LAST_UPDATED = "26 Aug 2026";

export default function TermsPage() {
  return (
    <PublicShell title="ResellerOS terms of service" subtitle={`Last updated: ${LAST_UPDATED}`}>
      <Intro>
        These Terms govern your access to and use of <b>{PLATFORM_OPERATOR.productName}</b> — a
        software-as-a-service platform operated by <b>{PLATFORM_OPERATOR.legalName}</b>{" "}
        (GSTIN {PLATFORM_OPERATOR.gstin}) (&ldquo;Company&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;)
        for cloud resellers in India. By creating an account or using the
        Service, you agree to these Terms. If you don&rsquo;t agree, please
        do not use the Service.
      </Intro>

      <TOC items={TOC_ITEMS} />

      <Section id="account" n={1} title="Your account">
        <p>
          You must provide accurate registration information and keep it
          updated. You&rsquo;re responsible for safeguarding your password and
          for all activity under your account. Notify us immediately at{" "}
          <a href="mailto:hello@resellersos.in" className="text-amber underline">
            hello@resellersos.in
          </a>{" "}
          if you suspect unauthorised access.
        </p>
        <p>
          You must be at least 18 years old and authorised to bind your
          business entity (e.g. Pvt Ltd, LLP, proprietorship) to these Terms.
        </p>
      </Section>

      <Section id="acceptable-use" n={2} title="Acceptable use">
        <p>You agree NOT to use ResellerOS to:</p>
        <ul className="list-disc pl-5 space-y-1.5 mt-2">
          <li>Violate any law (Indian or otherwise) — including spamming, fraud, or money laundering</li>
          <li>Send unsolicited bulk email or WhatsApp messages outside your customer base</li>
          <li>Reverse-engineer, decompile, or attempt to extract source code</li>
          <li>Scrape, mass-extract, or resell our data structures</li>
          <li>Interfere with other tenants&rsquo; use of the Service</li>
          <li>Upload malware, viruses, or harmful content</li>
          <li>Misrepresent your identity or business</li>
        </ul>
        <p className="mt-3 text-[13px] text-ink-3">
          We may suspend or terminate accounts that violate these terms,
          without refund.
        </p>
      </Section>

      <Section id="subscription" n={3} title="Subscription & payments">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            ResellerOS is offered on monthly or annual subscription plans.
            Pricing is published on{" "}
            <a href="/pricing" className="text-amber underline">our pricing page</a>{" "}
            and may change with 30 days&rsquo; notice for existing customers.
          </li>
          <li>
            Payments are processed via <b>Razorpay</b>. Card details are
            stored by Razorpay (PCI-DSS compliant), not by ResellerOS.
          </li>
          <li>
            All fees are <b>inclusive of GST</b> where applicable. We will
            issue a GST-compliant tax invoice (HSN 998313) for each payment.
          </li>
          <li>
            Annual plans are billed upfront and are <b>non-refundable</b>
            after the first 14 days. Monthly plans can be cancelled anytime
            with no further charge from the next billing cycle.
          </li>
          <li>
            Failed payments result in account suspension after a 7-day grace
            period. Data is preserved for 90 days after suspension.
          </li>
        </ul>
      </Section>

      <Section id="data" n={4} title="Your data, your IP">
        <p>
          <b>You own all data you create or upload</b> to ResellerOS — your
          leads, customers, quotes, invoices, payments, communications, and
          uploads. We claim no ownership.
        </p>
        <p>
          We use your data only to operate the Service for you (see our{" "}
          <a href="/privacy" className="text-amber underline">Privacy Policy</a>).
          We do not train AI models on your data, do not sell it, do not use
          it for advertising.
        </p>
        <p>
          You may export your data at any time via the Settings → Export feature.
          On termination, we provide a 90-day window during which you can request
          a full data export.
        </p>
      </Section>

      <Section id="our-ip" n={5} title="Our intellectual property">
        <p>
          {PLATFORM_OPERATOR.productName}&rsquo;s software, design, content, brand, logos, and
          documentation are owned by {PLATFORM_OPERATOR.legalName}. We grant you
          a <b>non-exclusive, non-transferable, revocable licence</b> to use
          the Service for your business while your subscription is active.
        </p>
      </Section>

      <Section id="third-party" n={6} title="Third-party services">
        <p>
          ResellerOS integrates with third-party services (Google Workspace,
          Microsoft 365, Zoho, Razorpay, Gupshup WhatsApp, Resend, GST APIs,
          Account Aggregator TSPs, etc.). Your use of these third-party
          services is governed by their respective terms. We are not
          responsible for their availability, accuracy, or fitness for purpose.
        </p>
      </Section>

      <Section id="warranty" n={7} title="Warranty disclaimer">
        <Callout tone="warning">
          The Service is provided <b>&ldquo;AS IS&rdquo;</b> and <b>&ldquo;AS
          AVAILABLE&rdquo;</b>. We disclaim all warranties, express or implied,
          including merchantability, fitness for a particular purpose, and
          non-infringement, to the maximum extent permitted by Indian law.
        </Callout>
        <p>
          We strive for 99.5% uptime but do not guarantee uninterrupted or
          error-free service. Scheduled maintenance windows will be announced
          in advance via email.
        </p>
      </Section>

      <Section id="liability" n={8} title="Limitation of liability">
        <p>
          To the maximum extent permitted by law, <b>our total liability</b> to
          you for any claim arising from these Terms or your use of the Service
          is limited to the <b>amount you paid us in the 12 months preceding
          the claim</b>.
        </p>
        <p>
          We are not liable for indirect, incidental, special, consequential,
          or punitive damages — including loss of profit, business interruption,
          or data loss not caused by our gross negligence.
        </p>
      </Section>

      <Section id="indemnification" n={9} title="Indemnification">
        <p>
          You agree to indemnify and hold us harmless from claims arising
          from: (a) your violation of these Terms, (b) your violation of any
          third-party right, (c) your unlawful use of the Service, or
          (d) the content you upload or transmit through the Service.
        </p>
      </Section>

      <Section id="termination" n={10} title="Termination">
        <p>
          <b>You</b> may cancel anytime from Settings → Billing. Your
          access continues until the end of the current billing period.
        </p>
        <p>
          <b>We</b> may suspend or terminate your account if you breach these
          Terms, fail to pay, or use the Service in ways that harm other
          users or our infrastructure. Material breach: immediate termination
          without refund.
        </p>
      </Section>

      <Section id="governing-law" n={11} title="Governing law & disputes">
        <p>
          These Terms are governed by the <b>laws of India</b>. Any dispute
          shall be subject to the <b>exclusive jurisdiction of courts in
          Mumbai, Maharashtra</b>.
        </p>
        <p>
          We&rsquo;ll attempt good-faith resolution via direct contact before
          either party pursues legal action. Notice to us:{" "}
          <a href="mailto:legal@resellersos.in" className="text-amber underline">
            legal@resellersos.in
          </a>
          .
        </p>
      </Section>

      <Section id="changes" n={12} title="Changes to these Terms">
        <p>
          We may update these Terms. Material changes will be emailed to tenant
          owners at least <b>30 days</b> in advance. Continued use after the
          effective date constitutes acceptance.
        </p>
      </Section>

      <Section id="contact" n={13} title="Contact">
        <p className="space-y-1">
          <strong className="text-ink">{PLATFORM_OPERATOR.legalName}</strong><br />
          {PLATFORM_OPERATOR.address}<br />
          General:{" "}
          <a href="mailto:hello@resellersos.in" className="text-amber underline">hello@resellersos.in</a><br />
          Legal:{" "}
          <a href="mailto:legal@resellersos.in" className="text-amber underline">legal@resellersos.in</a><br />
          Privacy:{" "}
          <a href="mailto:privacy@resellersos.in" className="text-amber underline">privacy@resellersos.in</a>
        </p>
      </Section>

      <FooterMeta />
    </PublicShell>
  );
}

const TOC_ITEMS: Array<{ id: string; label: string }> = [
  { id: "account",         label: "Your account" },
  { id: "acceptable-use",  label: "Acceptable use" },
  { id: "subscription",    label: "Subscription & payments" },
  { id: "data",            label: "Your data, your IP" },
  { id: "our-ip",          label: "Our IP" },
  { id: "third-party",     label: "Third-party services" },
  { id: "warranty",        label: "Warranty disclaimer" },
  { id: "liability",       label: "Limitation of liability" },
  { id: "indemnification", label: "Indemnification" },
  { id: "termination",     label: "Termination" },
  { id: "governing-law",   label: "Governing law" },
  { id: "changes",         label: "Changes" },
  { id: "contact",         label: "Contact" },
];
