import type { Metadata } from "next";
import Link from "@/site/components/ui/SiteLink";
import { SectionHead } from "@/site/components/ui/bits";
import { TLDS, CERTS, MAIL_RATES } from "@/site/lib/data/catalog";
import { HOSTING_TIERS } from "@/site/lib/data/hosting-landing-v2";
import { fetchLiveWorkspace, mergeEditions } from "@/site/lib/live-catalog";
import { buildRateCard } from "@/site/lib/rate-card";

/**
 * /rates — every customer price on one page (R-075, 1 Oct 2026).
 *
 * "All prices" in the header and the hosting page's rate-card link used to open /pricing,
 * the ResellerOS software plans. This page is what those links promise. Each table reads
 * the source its product page reads (see site/lib/rate-card.ts), so the two cannot
 * disagree; Google Workspace takes the same live catalogue overlay as /email.
 */
export const metadata: Metadata = {
  title: "All prices — domains, hosting, email, SSL",
  description:
    "Anutech Digital's full rate card in rupees: domain register, renew and transfer prices, web hosting, business email and SSL. All prices exclusive of 18% GST.",
};

/* The live Workspace prices revalidate every 10 minutes, same as /email. */
export const revalidate = 600;

export default async function RatesPage() {
  const live = await fetchLiveWorkspace();
  const sections = buildRateCard({
    tlds: TLDS,
    hosting: HOSTING_TIERS,
    editions: mergeEditions(live),
    mailRates: MAIL_RATES,
    certs: CERTS,
  });

  return (
    <>
      <section className="section rise">
        <div className="wrap">
          <div style={{ maxWidth: 680, marginBottom: 24 }}>
            <div className="eyebrow" style={{ color: "var(--primary)", marginBottom: 10 }}>RATE CARD</div>
            <h1 className="h1-page" style={{ marginBottom: 14 }}>Every price, on one page.</h1>
            <p className="body-lg" style={{ margin: 0 }}>
              Domains, hosting, email and SSL in rupees. The same numbers each product page shows. All prices
              exclude GST at 18%, which is shown separately on every invoice.
            </p>
          </div>
          <nav aria-label="Jump to" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {sections.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="chip">{s.title}</a>
            ))}
          </nav>
        </div>
      </section>

      {sections.map((s, i) => (
        <section key={s.id} id={s.id} className="section" style={i % 2 === 0 ? { background: "var(--tint)" } : undefined}>
          <div className="wrap">
            <SectionHead eyebrow={s.unit.toUpperCase()} title={s.title} />
            <div className="tablewrap">
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 15 }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid var(--dark)", textAlign: "left" }}>
                    {/* R-1507: the outer columns sit 16px inside the box border (same as table.rates), never 0. */}
                    <th scope="col" style={{ padding: "10px 12px 10px 16px" }}>{s.id === "domains" ? "Extension" : "Plan"}</th>
                    {s.columns.map((c, ci) => (
                      <th key={c} scope="col" style={{ padding: ci === s.columns.length - 1 ? "10px 16px 10px 12px" : "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((r) => (
                    <tr key={r.name} style={{ borderBottom: "1px solid var(--line, rgba(0,0,0,.1))" }}>
                      <th scope="row" style={{ padding: "12px 12px 12px 16px", textAlign: "left", fontWeight: 600 }}>
                        <span className={s.id === "domains" ? "mono" : undefined}>{r.name}</span>
                        <span className="meta" style={{ display: "block", fontWeight: 400 }}>{r.note}</span>
                      </th>
                      {r.cells.map((c, ci) => (
                        <td
                          key={ci}
                          colSpan={ci === r.cells.length - 1 ? s.columns.length - r.cells.length + 1 : 1}
                          style={{ padding: ci === r.cells.length - 1 ? "12px 16px 12px 12px" : "12px", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}
                        >
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 18 }}>
              <Link href={s.href} className="btn btn-outline btn-sm">{s.cta}</Link>
            </div>
          </div>
        </section>
      ))}

      <section className="section-tight">
        <div className="wrap">
          <p className="meta" style={{ margin: 0 }}>
            Looking for the ResellerOS software plans? <Link href="/pricing">See ResellerOS pricing</Link>.
          </p>
        </div>
      </section>
    </>
  );
}
