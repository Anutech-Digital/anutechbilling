import type { Metadata } from "next";
import { HomeV2 } from "@/site/components/home/HomeV2";
import { HOME_FAQS } from "@/site/lib/data/home-faqs";
import { SITE_URL, SLA } from "@/site/lib/config";
import { fetchLiveWorkspace, mergeEditions } from "@/site/lib/live-catalog";

/**
 * /email — the Business Email category page (R-155, 5 Oct 2026). This is the email-first
 * design that was the home until today (HomeV2: suite → edition → Buy/Trial/Quote, compare,
 * migration, FAQ) plus Anutech Mail. The home is now about the whole company.
 *
 * SEO: one Product + AggregateOffer per suite with the real ₹ prices (moved here from the
 * home, which no longer sells one category), and a FAQPage matching the on-page FAQ.
 */
export const metadata: Metadata = {
  title: { absolute: "Business email in India — Google Workspace, Microsoft 365 & Zoho prices · Anutech Digital" },
  description:
    `Google Workspace, Microsoft 365 and Zoho Workplace for Indian businesses — every edition's price published in rupees, GST invoice with input credit, free migration done by us (${SLA.migration}), WhatsApp support. Google Premier Partner since 2014.`,
  keywords: [
    "business email India",
    "Google Workspace price India",
    "Microsoft 365 reseller India",
    "Zoho Workplace India",
    "business email GST invoice",
    "email migration free",
  ],
  alternates: { canonical: `${SITE_URL}/email` },
  openGraph: {
    title: "Business email — Google Workspace, Microsoft 365 & Zoho in rupees",
    description: "All editions priced side by side, GST invoice, free migration, WhatsApp support. Anutech Digital, Google Premier Partner since 2014.",
    url: `${SITE_URL}/email`,
    siteName: "Anutech Digital",
    type: "website",
    locale: "en_IN",
  },
};

/* Live GW prices from the app, re-read every 10 minutes — see lib/live-catalog.ts. */
export const revalidate = 600;

/** Suite → its editions, for the Product/Offer structured data. */
const SUITES: { name: string; prefix: string; desc: string }[] = [
  { name: "Google Workspace", prefix: "GW ", desc: "Gmail, Meet, Drive and Docs on your own domain, billed in rupees with a GST invoice." },
  { name: "Microsoft 365", prefix: "M365 ", desc: "Outlook, Teams and OneDrive for your team, billed in rupees with a GST invoice." },
  { name: "Zoho Workplace", prefix: "Zoho", desc: "Mail plus Writer, Sheet and Show — the cheapest full suite, billed in rupees." },
];

export default async function EmailPage() {
  const editions = mergeEditions(await fetchLiveWorkspace());

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      ...SUITES.map((s) => {
        const eds = editions.filter((e) => e.name.startsWith(s.prefix));
        const prices = eds.map((e) => e.annual);
        return {
          "@type": "Product",
          name: s.name,
          description: s.desc,
          brand: { "@type": "Brand", name: s.name },
          category: "Business email and productivity suite",
          offers: {
            "@type": "AggregateOffer",
            priceCurrency: "INR",
            lowPrice: Math.min(...prices),
            highPrice: Math.max(...prices),
            offerCount: eds.length,
            offers: eds.map((e) => ({
              "@type": "Offer",
              name: `${e.name} — per user / month (annual, GST extra)`,
              priceCurrency: "INR",
              price: e.annual,
              url: `${SITE_URL}/email#products`,
              seller: { "@id": `${SITE_URL}/#organization` },
            })),
          },
        };
      }),
      {
        "@type": "FAQPage",
        mainEntity: HOME_FAQS.map((f) => ({
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
      <HomeV2 editions={editions} page="email" />
    </>
  );
}
