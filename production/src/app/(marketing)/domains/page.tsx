import type { Metadata } from "next";
import { DomainLanding } from "@/site/components/domains/DomainLanding";
import { TLDS } from "@/site/lib/data/catalog";
import { DOMAIN_FAQS } from "@/site/lib/data/domains-landing";
import { SITE_URL } from "@/site/lib/config";
import { FREE_DOMAIN_TLDS_LABEL } from "@/lib/checkout/hosting-bundle";

/**
 * /domains — the conversion redesign ("Domain hosting improvement strategy",
 * 3 Sep 2026). The page is <DomainLanding/>, a self-contained editorial body;
 * the shared site chrome (home menu, utility bar, footer, cart drawer) wraps it
 * via the (marketing) layout, so navigation is present on this page as on every
 * other.
 *
 * SEO + AI-answerability (Pardeep's standing ask — the site should be legible to
 * Google/Gemini so it can rank and be quoted): rich <metadata> plus JSON-LD for
 * the organisation, the domain-registration offer catalogue (real ₹ prices from
 * TLDS), and the FAQ (the same six Q&A the page renders). All figures come from
 * the app's own data, never invented. Canonical origin is anutech.in (SITE_URL).
 */

export const metadata: Metadata = {
  title: "Domain registration & transfer — a free .com or .in with yearly hosting",
  description:
    `Register or transfer a domain in rupees, with the renewal price printed next to the first-year price. A ${FREE_DOMAIN_TLDS_LABEL} domain is ₹0 for the first year when Anutech hosting on a yearly plan is set up on it. 500+ extensions, GST invoice on every order.`,
  alternates: { canonical: `${SITE_URL}/domains` },
  openGraph: {
    title: "Domain registration & transfer — free .com / .in with yearly hosting",
    description:
      `Free ${FREE_DOMAIN_TLDS_LABEL} domain for the first year with yearly hosting. Live registry lookup, renewal price shown up front, GST invoice on every order.`,
    url: `${SITE_URL}/domains`,
    type: "website",
  },
};

/* Static-ish; the live availability check runs client-side, prices refresh on deploy. */
export const revalidate = 600;

export default function DomainsPage() {
  const cheapest = Math.min(...TLDS.map((t) => t.reg));

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: "Anutech Digital Pvt Ltd",
        url: SITE_URL,
        description: "Indian domain, hosting and business-email provider. Maker of ResellerOS.",
        address: { "@type": "PostalAddress", addressLocality: "Rohini", addressRegion: "Delhi", addressCountry: "IN" },
      },
      {
        "@type": "Product",
        name: "Domain registration",
        description:
          `Register or transfer a domain in rupees. A ${FREE_DOMAIN_TLDS_LABEL} domain is ₹0 for the first year when bundled with a yearly Anutech hosting plan. Renewal price shown up front; GST invoice on every order.`,
        brand: { "@type": "Brand", name: "Anutech Digital" },
        offers: {
          "@type": "AggregateOffer",
          priceCurrency: "INR",
          lowPrice: 0,
          highPrice: Math.max(...TLDS.map((t) => t.reg)),
          offerCount: TLDS.length,
          offers: TLDS.map((t) => ({
            "@type": "Offer",
            name: `${t.tld} domain — first year`,
            priceCurrency: "INR",
            price: t.reg,
            description: `${t.tld} for ${t.use}. Renews ₹${t.renew}/yr. ₹0 with a yearly hosting plan.`,
            url: `${SITE_URL}/domains#rates`,
          })),
        },
      },
      {
        "@type": "FAQPage",
        mainEntity: DOMAIN_FAQS.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <DomainLanding />
      <span hidden>{`Domains from ₹${cheapest}; a ${FREE_DOMAIN_TLDS_LABEL} is ₹0 for the first year with yearly hosting.`}</span>
    </>
  );
}
