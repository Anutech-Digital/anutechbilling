import type { Metadata } from "next";
import { CertCards } from "@/site/components/ssl/CertCards";
import { SectionHead, Reveal } from "@/site/components/ui/bits";
import { SECURITY_FEATURES } from "@/site/lib/data/copy";
import { bookCerts } from "@/lib/catalog/catalog-prices";
import { getPriceBook } from "@/lib/catalog/catalog-prices.server";
import { websiteTenantId } from "@/lib/website-tenant";

export const metadata: Metadata = {
  title: "SSL & security",
  description:
    "Free DV on every site. Paid certificates only when a client needs the paperwork — and we will say so rather than sell you one.",
};

/* R-1786: certificate prices from the price book (items rows with CATALOG_FROM_DB on). */
export const revalidate = 60;

export default async function SslPage() {
  const certs = bookCerts(await getPriceBook(websiteTenantId()));
  return (
    <>
      <section className="section rise">
        <div className="wrap">
          <div style={{ maxWidth: 640, marginBottom: 30 }}>
            <h1 className="h1-page" style={{ marginBottom: 16 }}>
              Free DV on every site. Paid certs only when a client needs the paperwork.
            </h1>
            <p className="body-lg" style={{ margin: 0 }}>
              Most sites never need more than the free certificate — and we will say so rather than
              sell you one.
            </p>
          </div>
          <CertCards certs={certs} />
        </div>
      </section>

      <section className="section" style={{ background: "var(--tint)" }}>
        <div className="wrap">
          <SectionHead eyebrow="SECURITY NOTES" title="Six things we do by default" />
          <div className="grid-3">
            {SECURITY_FEATURES.map((f) => (
              <Reveal key={f.title}>
                <div style={{ borderTop: "2px solid var(--dark)", paddingTop: 14 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{f.title}</div>
                  <p className="body" style={{ margin: 0, fontSize: 14 }}>{f.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
