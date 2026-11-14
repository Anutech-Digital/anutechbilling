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

/* Warm theme only (class w-only — hidden on Classic, src/site/warm-only.css): the refund cards'
   icon and badge from the Refund artboard. A badge is shown only where the block's own text says
   exactly that (thirty days, vendor's terms, non-refundable, fifteen days); the design's "₹0 PAID"
   on Free trial is left out — the text says "takes no payment", not a figure. Keyed by heading. */
type CardTone = "teal" | "marigold" | "red";
const REFUND_CARD: Record<string, { icon: string; tone: Exclude<CardTone, "red">; badge?: { text: string; tone: CardTone } }> = {
  Hosting: { icon: "M4 4h16v7H4z M4 13h16v7H4z M8 7.5h.01 M8 16.5h.01", tone: "teal", badge: { text: "30 days", tone: "teal" } },
  Licences: { icon: "M7 3h7l5 5v13H7z M14 3v5h5 M10 13h6 M10 17h6", tone: "marigold", badge: { text: "Vendor terms", tone: "marigold" } },
  Domains: { icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z", tone: "teal", badge: { text: "Non-refundable", tone: "red" } },
  Certificates: { icon: "M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z M8.5 12l2.5 2.5 4.5-5", tone: "marigold", badge: { text: "15 days", tone: "teal" } },
  "Free trial": { icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2", tone: "teal" },
};

function RefundCardTop({ heading }: { heading: string }) {
  const card = REFUND_CARD[heading];
  if (!card) return null;
  return (
    <div className="w-only legal-card-top">
      <span className="legal-card-icon" data-tone={card.tone} aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d={card.icon} />
        </svg>
      </span>
      {card.badge && <span className="legal-card-badge" data-tone={card.badge.tone}>{card.badge.text}</span>}
    </div>
  );
}

export function LegalDoc({ page }: { page: keyof typeof LEGAL }) {
  const doc = LEGAL[page];
  return (
    <section className="section rise">
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 20px" }}>
        <h1 className="h1-narrow" style={{ marginBottom: 8 }}>{doc.title}</h1>
        <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 16 }}>{doc.updated.toUpperCase()}</div>
        <p className="body-lg" style={{ margin: "0 0 30px" }}>{doc.intro}</p>
        {/* Warm only: the Privacy / Terms artboards' contents list (the Refund artboard draws cards instead). */}
        {page !== "refund" && (
          <nav aria-label="On this page" className="w-only legal-toc">
            <span className="legal-toc-label">On this page</span>
            {doc.blocks.map((b) => (
              <a key={b.h} href={`#${legalBlockId(b.h)}`}>{b.h}</a>
            ))}
          </nav>
        )}
        {doc.blocks.map((b) => (
          <div key={b.h} id={legalBlockId(b.h)} style={{ borderTop: "1px solid var(--border-light)", padding: "22px 0", scrollMarginTop: 80 }}>
            {page === "refund" && <RefundCardTop heading={b.h} />}
            <h2 style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 8 }}>{b.h}</h2>
            <p style={{ fontSize: 16, lineHeight: 1.6, color: "var(--text-secondary)", margin: 0 }}>{b.p}</p>
            {b.link && (
              <p style={{ margin: "10px 0 0" }}>
                <Link href={b.link.href} style={{ color: "var(--primary)", fontWeight: 600, fontSize: 15 }}>{b.link.label}</Link>
              </p>
            )}
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
