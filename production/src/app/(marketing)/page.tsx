import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { headers } from "next/headers";
import { siteKindForHost } from "@/site/lib/site-split";
import { HomeCompany } from "@/site/components/home/HomeCompany";
import { COMPANY_FAQS } from "@/site/lib/data/company-faqs";
import { COMPANY, SITE_URL } from "@/site/lib/config";
import { emailFromRate, fetchLiveWorkspace, mergeEditions } from "@/site/lib/live-catalog";

/**
 * Home — the whole company (R-155, 5 Oct 2026). Pardeep: the home is about Anutech Digital,
 * not one category, and custom software / office automation gets the most weight; email,
 * domains, hosting and SSL follow as "IT for your office". The old email-first home
 * (HomeV2) is now the Business Email category page at /email, with its Product JSON-LD.
 *
 * On dev/staging hosts a signed-in operator hitting "/" is sent to their workspace ("?preview=1"
 * keeps them here). On anutech.in (R-520) the company home never bounces: the company site is
 * not the app, so the logo can link to plain "/" (R-465).
 */

export const metadata: Metadata = {
  title: {
    absolute: "Anutech Digital — Custom software & office automation, business email, domains and hosting in India",
  },
  description:
    "Anutech Digital builds custom software and office automation for Indian businesses — leads, quotes, GST invoices, approvals, staff and reports in one system. Fixed quotes, demos at every milestone. Also Google Workspace, Microsoft 365, domains and hosting since 2014.",
  keywords: [
    "Anutech Digital",
    "custom software development India",
    "office automation software India",
    "business process automation Delhi",
    "custom CRM and billing software",
    "GST invoice software custom",
    "Google Workspace partner India",
    "business email domains hosting India",
  ],
  alternates: { canonical: `${SITE_URL}/` },
  openGraph: {
    title: "Anutech Digital — Custom software & office automation",
    description:
      "Software built for how your business works: enquiries, quotes, GST invoices, approvals, staff and reports. Fixed quote first, a working demo at every milestone. Delhi, since 2014.",
    url: `${SITE_URL}/`,
    siteName: "Anutech Digital",
    type: "website",
    locale: "en_IN",
  },
};

export default async function HomePage(
  props: {
    searchParams: Promise<{ preview?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const supabase = createClient();
  const h = await headers();
  if (siteKindForHost(h.get("x-forwarded-host") ?? h.get("host")) !== "company") {
    const { data: { user } } = await supabase.auth.getUser();
    if (user && searchParams.preview !== "1") redirect("/dashboard");
  }

  // "Business email from ₹…" on the IT card: the cheapest of the live licence rates and
  // the Anutech Mail mailbox, so the card never undercuts or overstates /email.
  const editions = mergeEditions(await fetchLiveWorkspace());
  const emailFrom = emailFromRate(editions);

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE_URL}/#organization`,
        name: COMPANY.name,
        alternateName: COMPANY.short,
        url: SITE_URL,
        logo: `${SITE_URL}/anutech-digital-logo.png`,
        description:
          "Delhi-based software company (since 2014) building custom software and office automation for Indian businesses, and a Google Premier Partner selling Google Workspace, Microsoft 365 and Zoho licences, domains, hosting and business email with GST invoices. Maker of ResellerOS.",
        foundingDate: "2014",
        award: "Google Premier Partner",
        taxID: COMPANY.gstin,
        address: { "@type": "PostalAddress", addressLocality: "Rohini", addressRegion: "Delhi", addressCountry: "IN" },
        contactPoint: { "@type": "ContactPoint", contactType: "customer support", email: COMPANY.supportEmail, areaServed: "IN", availableLanguage: ["en", "hi"] },
        areaServed: "IN",
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        name: "Anutech Digital",
        url: SITE_URL,
        publisher: { "@id": `${SITE_URL}/#organization` },
        inLanguage: "en-IN",
      },
      {
        "@type": "Service",
        name: "Custom software and office automation",
        serviceType: "Custom software development",
        description: "Software built around a business's own process: enquiries and leads, quotes and GST invoices, approvals, staff and salary, reports and dashboards. Fixed quote with milestones, a working demo at each milestone, training and support after go-live.",
        provider: { "@id": `${SITE_URL}/#organization` },
        areaServed: "IN",
        url: `${SITE_URL}/#software`,
      },
      {
        "@type": "FAQPage",
        mainEntity: COMPANY_FAQS.map((f) => ({
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
      <HomeCompany emailFrom={emailFrom} />
    </>
  );
}
