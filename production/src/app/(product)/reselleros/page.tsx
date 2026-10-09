/**
 * R-520 — the ResellerOS homepage. Served at "/" on reselleros.anutech.in (middleware rewrite,
 * see site/lib/site-split.ts) and at /reselleros on dev/staging hosts.
 *
 * Every word comes from site/lib/data/reselleros-home.ts (owner TODOs listed there).
 * Phone-first: one column at 390px, two/three columns from sm/md up. App tokens, so the
 * light and dark themes both work.
 *
 * A signed-in operator who opens the product root goes to their workspace; "?preview=1"
 * keeps them here.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { HOME, PRICING_LINE } from "@/site/lib/data/reselleros-home";
import { PRODUCT_ORIGIN, COMPANY_ORIGIN } from "@/site/lib/site-split";
import { CUSTOMER_LOGIN_URL } from "@/site/components/product/ProductChrome";

export const metadata: Metadata = {
  title: { absolute: HOME.title },
  description: HOME.description,
  alternates: { canonical: `${PRODUCT_ORIGIN}/` },
  openGraph: {
    title: HOME.title,
    description: HOME.description,
    url: `${PRODUCT_ORIGIN}/`,
    siteName: "ResellerOS",
    type: "website",
    locale: "en_IN",
  },
};

const primaryBtn =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-amber px-5 py-2.5 text-base font-medium text-white shadow-sm hover:bg-amber/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber";
const quietBtn =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-hairline bg-paper px-5 py-2.5 text-base font-medium text-ink hover:bg-paper-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber";

export default async function ResellerOsHome(props: { searchParams: Promise<{ preview?: string }> }) {
  const searchParams = await props.searchParams;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user && searchParams.preview !== "1") redirect("/dashboard");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "ResellerOS",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: `${PRODUCT_ORIGIN}/`,
    description: HOME.description,
    publisher: { "@type": "Organization", name: "Anutech Digital", url: COMPANY_ORIGIN },
  };

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-4 pb-12 pt-10 sm:px-5 sm:pt-16">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-amber-ink">{HOME.eyebrow}</p>
        <h1 className="max-w-3xl font-serif text-4xl leading-tight text-ink sm:text-5xl">{HOME.headline}</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink-2">{HOME.sub}</p>
        <div className="mt-7 flex flex-col gap-3 sm:flex-row">
          <Link href="/signup" className={primaryBtn}>{HOME.ctaPrimary}</Link>
          <Link href="/login" className={quietBtn}>{HOME.ctaLogin}</Link>
        </div>
        <p className="mt-3 text-sm text-ink-3" data-testid="pricing-line">{PRICING_LINE}</p>
        <p className="mt-6 text-sm">
          <a href="#features" className="text-ink-2 underline underline-offset-4 hover:text-ink">{HOME.ctaFeatures} ↓</a>
        </p>
      </section>

      {/* Who it is for */}
      <section className="border-t border-hairline bg-paper-2/50">
        <div className="mx-auto max-w-5xl px-4 py-12 sm:px-5">
          <h2 className="font-serif text-2xl text-ink sm:text-3xl">{HOME.whoTitle}</h2>
          <ul className="mt-6 grid gap-4 md:grid-cols-3">
            {HOME.who.map((w) => (
              <li key={w.title} className="rounded-lg border border-hairline bg-paper p-5">
                <h3 className="text-base font-semibold text-ink">{w.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-2">{w.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="scroll-mt-20">
        <div className="mx-auto max-w-5xl px-4 py-12 sm:px-5">
          <h2 className="font-serif text-2xl text-ink sm:text-3xl">{HOME.featuresTitle}</h2>
          <ul className="mt-6 grid gap-x-8 gap-y-6 sm:grid-cols-2 md:grid-cols-3">
            {HOME.features.map((f) => (
              <li key={f.title} className="border-l-2 border-amber pl-4">
                <h3 className="text-base font-semibold text-ink">{f.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-2">{f.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Steps */}
      <section className="border-t border-hairline bg-paper-2/50">
        <div className="mx-auto max-w-5xl px-4 py-12 sm:px-5">
          <h2 className="font-serif text-2xl text-ink sm:text-3xl">{HOME.stepsTitle}</h2>
          <ol className="mt-6 grid gap-4 md:grid-cols-3">
            {HOME.steps.map((s, i) => (
              <li key={s.title} className="flex gap-4 rounded-lg border border-hairline bg-paper p-5">
                <span className="font-serif text-2xl leading-none text-amber" aria-hidden>{i + 1}</span>
                <div>
                  <h3 className="text-base font-semibold text-ink">{s.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-ink-2">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="scroll-mt-20">
        <div className="mx-auto max-w-5xl px-4 py-12 sm:px-5">
          <h2 className="font-serif text-2xl text-ink sm:text-3xl">{HOME.pricingTitle}</h2>
          {HOME.pricingTier && (
            <div className="mt-6 max-w-md rounded-lg border-2 border-amber bg-paper p-6">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-lg font-semibold text-ink">{HOME.pricingTier.name}</h3>
                <span className="font-serif text-3xl text-ink">{HOME.pricingTier.price}</span>
              </div>
              <p className="mt-1 text-sm text-ink-3">{HOME.pricingTier.note}</p>
              <ul className="mt-4 space-y-2 text-sm text-ink-2">
                {HOME.pricingTier.lines.map((l) => (
                  <li key={l} className="flex gap-2"><span className="text-amber" aria-hidden>✓</span>{l}</li>
                ))}
              </ul>
              <Link href="/signup" className={`${primaryBtn} mt-5 w-full`}>{HOME.ctaPrimary}</Link>
              <p className="mt-2 text-center text-xs text-ink-3">{PRICING_LINE}</p>
            </div>
          )}
          <p className="mt-4 text-sm">
            <Link href="/pricing" className="text-ink-2 underline underline-offset-4 hover:text-ink">{HOME.pricingMore} →</Link>
          </p>
        </div>
      </section>

      {/* Domain/hosting customers looking for their own login (R-460) */}
      {CUSTOMER_LOGIN_URL && (
        <section className="border-t border-hairline">
          <div className="mx-auto max-w-5xl px-4 py-6 text-sm text-ink-2 sm:px-5">
            {HOME.clientLoginLead}{" "}
            <a href={CUSTOMER_LOGIN_URL} className="font-medium text-ink underline underline-offset-4">{HOME.clientLoginCta} →</a>
          </div>
        </section>
      )}
    </>
  );
}
