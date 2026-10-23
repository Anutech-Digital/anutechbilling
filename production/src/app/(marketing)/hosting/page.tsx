import type { Metadata } from "next";
import { HostingLanding } from "@/site/components/hosting/HostingLanding";
import { HOSTING_FAQS_V2, HOSTING_FROM_MO, hostingCharge, type HostingTier } from "@/site/lib/data/hosting-landing-v2";
import { getPriceBook } from "@/lib/catalog/catalog-prices.server";
import { websiteTenantId } from "@/lib/website-tenant";
import { rupee } from "@/site/lib/money";

/**
 * /hosting — the conversion-focused hosting landing page (redesign, 2 Sep 2026).
 *
 * It lives UNDER (marketing) on purpose: the marketing layout gives it the
 * shared site chrome — the same home-page menu (a sticky Header), the utility
 * bar and the footer — on this page as on every other, so a visitor can always
 * get back to the home page and across to Domains, Email, ResellerOS, etc.
 * (Pardeep, 2 Sep: the menu must be on every page.) HostingLanding therefore
 * renders only its own body (hero → final CTA); its in-page navigation is the
 * quick-jump strip. It still loads its own display fonts (Manrope / Instrument
 * Serif / JetBrains Mono) for the body, scoped to itself.
 *
 * SEO + AI-answer-engine friendliness (Pardeep, 2 Sep — "koi AI chatbot jaise
 * Gemini me ranking la sake"): rich metadata plus server-rendered JSON-LD for
 * Organization, the three priced Offers, and the FAQ. Answer engines (Gemini,
 * ChatGPT, Perplexity) and Google's rich results read this structured, factual
 * markup directly, and it is generated from the SAME real data the page shows,
 * so the machine-readable facts can never drift from the visible ones.
 */

const SITE_URL = "https://resellersos-njvk4nxhdq-el.a.run.app";
const PAGE_URL = `${SITE_URL}/hosting`;

export const metadata: Metadata = {
  title: "Web hosting on Google Cloud — 15-day free trial, no credit card",
  description:
    `cPanel web hosting on Google Cloud from Anutech Digital. Free SSL, daily backups, free migration and real-person support. Plans from ${HOSTING_FROM_MO}/mo. Start a 15-day free trial — no credit card, GST invoice on every order.`,
  keywords: [
    "web hosting India", "cPanel hosting", "Google Cloud hosting", "free website migration",
    "WordPress hosting India", "GST invoice hosting", "15-day free trial hosting", "Anutech Digital",
  ],
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    siteName: "Anutech Digital",
    title: "Web hosting on Google Cloud — 15-day free trial, no credit card",
    description:
      `cPanel web hosting on Google Cloud. Free SSL, daily backups, free migration, real-person support. Plans from ${HOSTING_FROM_MO}/mo. 15-day free trial, no credit card.`,
  },
  twitter: {
    card: "summary_large_image",
    title: "Web hosting on Google Cloud — 15-day free trial",
    description: "cPanel hosting from Anutech Digital. Free migration, GST invoice, no-card trial.",
  },
};

/** JSON-LD built from the SAME real data the page renders — never a second copy. */
function structuredData(tiers: readonly HostingTier[]) {
  const organization = {
    "@type": "Organization",
    name: "Anutech Digital Pvt Ltd",
    url: SITE_URL,
    address: {
      "@type": "PostalAddress",
      addressLocality: "Rohini",
      addressRegion: "Delhi",
      addressCountry: "IN",
    },
    taxID: "07ABDCA0298H1ZP",
    makesOffer: "Web hosting, domain registration and Google Workspace for Indian businesses",
  };

  /* R-1465: the whole-rupee yearly figure checkout charges (₹600), not ₹599.88. */
  const prices = tiers.map((t) => hostingCharge(t, true).exGst);
  const product = {
    "@type": "Product",
    name: "Web hosting on Google Cloud",
    description:
      "cPanel web hosting on Google Cloud with free SSL, automatic daily backups, free website migration and real-person support. Three plans: Starter, Standard and Plus.",
    brand: { "@type": "Brand", name: "Anutech Digital" },
    category: "Web hosting",
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "INR",
      lowPrice: Math.min(...prices),
      highPrice: Math.max(...prices),
      offerCount: tiers.length,
      offers: tiers.map((t) => ({
        "@type": "Offer",
        name: `${t.name} hosting (billed yearly)`,
        priceCurrency: "INR",
        price: hostingCharge(t, true).exGst,
        description: `${t.storage} NVMe SSD storage, ${t.bandwidth} bandwidth, ${t.sites === "1" ? "1 website" : "multiple websites"}. Renews at ${rupee(t.yearlyMo)}/mo — the same price.`,
        availability: "https://schema.org/InStock",
        url: PAGE_URL,
      })),
    },
  };

  const faq = {
    "@type": "FAQPage",
    mainEntity: HOSTING_FAQS_V2.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  return { "@context": "https://schema.org", "@graph": [organization, product, faq] };
}

/* R-1786: with CATALOG_FROM_DB on, the plan prices are the `items` rows (60 s cache), so an
   Items page edit reaches this page within a minute. With the flag off: the code prices. */
export const revalidate = 60;

export default async function HostingPage() {
  const { tiers } = await getPriceBook(websiteTenantId());
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData(tiers)) }}
      />
      <HostingLanding tiers={tiers} />
    </>
  );
}
