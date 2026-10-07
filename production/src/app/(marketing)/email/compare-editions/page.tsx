import type { Metadata } from "next";
import Link from "@/site/components/ui/SiteLink";
import { SLA } from "@/site/lib/config";
import { EditionTabs } from "@/site/components/email/EditionTabs";
import { SectionHead, Reveal } from "@/site/components/ui/bits";
import { PICK_GUIDES } from "@/site/lib/data/catalog";
import { fetchLiveWorkspace, mergeEditions, suitePriceRows } from "@/site/lib/live-catalog";

export const metadata: Metadata = { title: "Compare editions — GW, M365, Zoho" };

/* Live prices, re-read every 10 minutes — the same figures /email and checkout use. */
export const revalidate = 600;

export default async function CompareEditionsPage() {
  /* R-076: every suite's price row (GW, M365, Zoho) from the catalogue, typed cell as fallback. */
  const prices = suitePriceRows(mergeEditions(await fetchLiveWorkspace()));
  return (
    <>
      <section className="section rise">
        <div className="wrap">
          <div style={{ maxWidth: 640, marginBottom: 30 }}>
            <h1 className="h1-page" style={{ marginBottom: 16 }}>
              Google Workspace, Microsoft 365 and Zoho — side by side.
            </h1>
            <p className="body-lg" style={{ margin: 0 }}>
              Eleven rows per suite, the em-dash meaning &ldquo;not included&rdquo;, and a plain
              recommendation for six common situations underneath.
            </p>
          </div>
          <EditionTabs prices={prices} />
        </div>
      </section>

      <section className="section" style={{ background: "var(--tint)" }}>
        <div className="wrap">
          <SectionHead
            eyebrow="WHICH ONE"
            title="Six situations, six answers"
            body={`If none of these is you, send a headcount and we answer ${SLA.quote}.`}
          />
          <div className="grid-3">
            {PICK_GUIDES.map((g) => (
              <Reveal key={g.when}>
                <div className="card" style={{ height: "100%" }}>
                  <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 10 }}>{g.when.toUpperCase()}</div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: "var(--primary)", marginBottom: 8 }}>{g.pick}</div>
                  <p className="body" style={{ margin: 0, fontSize: 14 }}>{g.why}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 30 }}>
            <Link href="/email#products" className="btn btn-primary">Price it in the calculator</Link>
            <Link href="/quote" className="btn btn-outline">Get a quote instead</Link>
          </div>
        </div>
      </section>
    </>
  );
}
