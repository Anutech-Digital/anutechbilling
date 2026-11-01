/** 760px legal measure: h1 40px, mono "Last updated", intro, blocks with 1px top rules. */
import Link from "@/site/components/ui/SiteLink";
import { LEGAL } from "@/site/lib/data/misc";

/* Where each document lives. `/terms` is the ResellerOS software's own terms, so the
   terms for what customers buy are at /terms-and-conditions (30 Sep 2026); likewise
   /privacy is the software's, and the buyer's privacy policy is at /privacy-policy. */
const HREF: Record<keyof typeof LEGAL, string> = { terms: "/terms-and-conditions", refund: "/refund", privacy: "/privacy-policy" };

/** R-2011: each block can be linked (/privacy-policy#your-rights, #grievances) — the forms' data notice does. */
export function legalBlockId(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function LegalDoc({ page }: { page: keyof typeof LEGAL }) {
  const doc = LEGAL[page];
  return (
    <section className="section rise">
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 20px" }}>
        <h1 className="h1-narrow" style={{ marginBottom: 8 }}>{doc.title}</h1>
        <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 16 }}>{doc.updated.toUpperCase()}</div>
        <p className="body-lg" style={{ margin: "0 0 30px" }}>{doc.intro}</p>
        {doc.blocks.map((b) => (
          <div key={b.h} id={legalBlockId(b.h)} style={{ borderTop: "1px solid var(--border-light)", padding: "22px 0", scrollMarginTop: 80 }}>
            <h2 style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 8 }}>{b.h}</h2>
            <p style={{ fontSize: 16, lineHeight: 1.6, color: "var(--text-secondary)", margin: 0 }}>{b.p}</p>
          </div>
        ))}
        <nav aria-label="Related documents" style={{ borderTop: "1px solid var(--border-light)", paddingTop: 22, display: "flex", gap: 20, flexWrap: "wrap" }}>
          <span className="mono-label" style={{ color: "var(--text-muted)", alignSelf: "center" }}>Also read</span>
          {(Object.keys(HREF) as (keyof typeof LEGAL)[]).filter((k) => k !== page).map((k) => (
            <Link key={k} href={HREF[k]} style={{ color: "var(--primary)", fontWeight: 600, fontSize: 15 }}>{LEGAL[k].title}</Link>
          ))}
        </nav>
      </div>
    </section>
  );
}
