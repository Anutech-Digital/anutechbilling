/**
 * Four certificate cards. Paid certificates are quote items (owner decision 20: the cart
 * checkout has no server-side SSL price, so a cart line was refused at payment) — each card's
 * button opens /quote on the SSL category with that certificate picked (R-1504; it used to
 * open /quote on Google Workspace, so SSL looked missing). Free DV is included, not sold.
 */
import Link from "next/link";
import { CERTS } from "@/site/lib/data/catalog";
import { sslQuoteHref } from "@/site/lib/data/quote-catalog";
import { Tick } from "@/site/components/ui/bits";

export function CertCards() {
  return (
    <div className="grid-4" style={{ gap: 20 }}>
      {CERTS.map((c) => {
        const href = sslQuoteHref(c.name);
        const btn = `btn btn-sm ${c.highlighted ? "btn-primary" : "btn-outline"}`;
        return (
          <div key={c.name} className={`card${c.highlighted ? " card-highlight" : ""}`} style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>{c.name}</div>
            <div className="meta" style={{ marginBottom: 10 }}>{c.who}</div>
            <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", marginBottom: 12 }}>
              {c.price}
              <span style={{ fontSize: 14, fontWeight: 400, color: "var(--text-muted)" }}>{c.unit}</span>
            </div>
            <div style={{ flex: 1 }}>
              {c.lines.map((l) => (
                <Tick key={l}>{l}</Tick>
              ))}
            </div>
            {href ? (
              <Link href={href as never} className={btn} style={{ marginTop: 16 }}>
                {c.cta}
              </Link>
            ) : (
              <button className={btn} style={{ marginTop: 16 }} disabled={c.cta === "Included"}>
                {c.cta}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
