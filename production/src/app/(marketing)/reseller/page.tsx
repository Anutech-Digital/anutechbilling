import type { Metadata } from "next";
import Link from "@/site/components/ui/SiteLink";
import { MarginCalculator } from "@/site/components/reseller/MarginCalculator";
import { SectionHead, Reveal } from "@/site/components/ui/bits";
import { SWITCH_REASONS } from "@/site/lib/data/copy";

export const metadata: Metadata = {
  title: "Wholesale reseller program",
  description:
    "Wholesale rates you can read before you join. No advance deposit, no volume slabs, no USD surprise at renewal.",
};

export default function ResellerPage() {
  return (
    <>
      <section className="section rise">
        <div className="wrap">
          <div style={{ maxWidth: 680, marginBottom: 34 }}>
            <h1 className="h1-page" style={{ marginBottom: 16 }}>
              Wholesale rates you can read before you join.
            </h1>
            <p className="body-lg" style={{ margin: 0 }}>
              No advance deposit, no volume slabs, no USD surprise at renewal. The rate card is
              published, and the price you read today is the price on order one.
            </p>
          </div>

          {/* THEM vs us — 2×2 bordered grid, never naming the competitor. */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "var(--border)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }} data-grid>
            {SWITCH_REASONS.map((r) => (
              <div key={r.them} style={{ background: "#fff", padding: 24 }}>
                <div className="mono-label" style={{ color: "var(--danger)", marginBottom: 10 }}>{r.them}</div>
                <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>{r.us}</div>
                <p className="body" style={{ margin: 0, fontSize: 14 }}>{r.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="margin" style={{ background: "var(--tint)" }}>
        <div className="wrap">
          <SectionHead
            eyebrow="MARGIN CALCULATOR"
            title="Your volumes, our rates, your margin"
            body="Buy and sell figures are the published assumptions — replace them with your own retail prices and the arithmetic holds."
          />
          <MarginCalculator />
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <Reveal>
            <div className="card card-highlight-os" style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 380px" }}>
                <div className="mono-label" style={{ color: "var(--accent)", marginBottom: 8 }}>AND THE SOFTWARE SIDE</div>
                <h2 className="h2-sub" style={{ marginBottom: 8 }}>Run the whole reselling business on ResellerOS</h2>
                <p className="body" style={{ margin: 0 }}>
                  Subscriptions, GST quotes and invoices, renewals and bank reconciliation — built by this
                  company, for this exact business. Free during beta.
                </p>
              </div>
              <Link href="/reselleros" className="btn btn-os">Explore ResellerOS →</Link>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
