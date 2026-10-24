"use client";
/**
 * The rest of the global chrome: utility bar, breadcrumb, CTA band, footer and the consent
 * banner (R-1498: WhatsApp now sits in the AgentChat launcher menu). One file, because every piece is a fixed band with
 * no state of its own except consent — splitting them into six files would scatter what the
 * README describes as one system ("Global Chrome (every route)").
 */
import Image from "next/image";
import { FREE_DOMAIN_TLDS_LABEL } from "@/lib/checkout/hosting-bundle";
import Link from "@/site/components/ui/SiteLink";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { COMPANY, WHATSAPP_URL, WHATSAPP_READY, CLIENT_AREA_URL } from "@/site/lib/config";
import { hideFloatingOn } from "./floating";

export function UtilityBar() {
  const pathname = usePathname();
  const onDomains = pathname.startsWith("/domains");
  /* The home leads with custom software (R-155); "free migration" is an email promise. */
  const onHome = pathname === "/";
  return (
    <div style={{ background: "var(--dark)", color: "#C3CBD6", fontSize: 13, padding: "9px 0" }}>
      <div className="wrap" style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        {onDomains ? (
          /* The domains page leads with the offer — the ₹0 lever is the whole page's
             thesis, so the utility bar states it first (offer text in warm accent). */
          <span><span style={{ color: "#FFC9A8" }}>Free {FREE_DOMAIN_TLDS_LABEL} domain for the first year with yearly hosting</span> · GST invoice on every order</span>
        ) : onHome ? (
          <span>Custom software &amp; office automation · {COMPANY.partnerLine}</span>
        ) : (
          <span>Free migration on every plan · GST invoice on every order</span>
        )}
        <span className="hide-mobile" style={{ display: "flex", gap: 18 }}>
          <Link href="/rates">All prices</Link>
          <Link href="/contact">Support</Link>
          <Link href="/status">Status</Link>
          {/* R-233: customers sign in to the hosting/domain panel, not the ResellerOS staff app. */}
          <Link href={CLIENT_AREA_URL as never}>Customer login</Link>
        </span>
      </div>
    </div>
  );
}

/** "Home / <page title>" on every route except home. The map is the handoff's crumb map. */
const CRUMBS: Record<string, string> = {
  "/domains": "Domain registration & transfer",
  "/hosting": "cPanel web hosting",
  "/email": "Business email & productivity",
  "/email/compare-editions": "Compare editions",
  "/google-workspace/pricing": "Google Workspace pricing",
  "/ssl": "SSL & security",
  "/login": "Log in",
  "/terms": "ResellerOS terms of service",
  "/terms-and-conditions": "Anutech Digital terms and conditions",
  "/privacy": "ResellerOS privacy policy",
  "/privacy-policy": "Anutech Digital privacy policy",
  "/refund": "Refund policy",
  "/reselleros": "ResellerOS — software for resellers",
  "/reseller": "Reseller program",
  "/rates": "Every price",
  "/pricing": "ResellerOS pricing",
  "/why-us": "Why us",
  "/about": "About Anutech Digital",
  "/support": "Support & knowledge base",
  "/contact": "Support",
  "/status": "System status",
  "/quote": "Get a quote",
  "/cart": "Cart",
  "/checkout": "Checkout",
  "/done": "Order placed",
  "/dashboard": "Client area",
};

export function Breadcrumb() {
  const pathname = usePathname();
  const title = CRUMBS[pathname];
  if (!title) return null;
  return (
    <div style={{ background: "var(--tint-2)", borderBottom: "1px solid var(--border-hairline)", fontSize: 13, padding: "9px 0", color: "var(--text-muted)" }}>
      <div className="wrap">
        <Link href="/" style={{ color: "var(--text-muted)" }}>Home</Link>
        <span style={{ margin: "0 8px" }}>/</span>
        <span style={{ color: "var(--text)" }}>{title}</span>
      </div>
    </div>
  );
}

export function CtaBand() {
  /* The home ends with its own custom-software call band (R-155); this one is the
     licence quote ask, right for every other page. */
  const pathname = usePathname();
  if (pathname === "/") return null;
  /* R-1478: /quote IS the quote form — a "Get a quote" band under it points at the page itself. */
  if (pathname === "/quote") return null;
  return (
    <section style={{ background: "var(--dark)", color: "#fff", padding: "56px 0" }}>
      <div className="wrap" style={{ display: "flex", alignItems: "center", gap: 28, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 420px" }}>
          <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em", marginBottom: 8 }}>
            Send a headcount, get every option priced today.
          </h2>
          <p style={{ color: "var(--dark-body)", margin: 0, fontSize: 16 }}>
            Three suites, GST broken out, renewal price printed up front. No callback queue.
          </p>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {/* R-078: only with the real number configured; the placeholder sent people nowhere. */}
          {WHATSAPP_READY && (
            <a href={WHATSAPP_URL} target="_blank" rel="noopener" className="btn btn-outline" style={{ background: "transparent", color: "#fff", borderColor: "#39434e" }}>
              WhatsApp us
            </a>
          )}
          <Link href="/quote" className="btn btn-primary">Get a quote</Link>
        </div>
      </div>
    </section>
  );
}

const FOOTER_COLS = [
  { title: "DOMAINS", links: [["Search a domain", "/domains"], ["Rate card", "/domains#rates"], ["Transfer in", "/domains"], ["All prices", "/rates"]] },
  { title: "HOSTING", links: [["Shared hosting", "/hosting"], ["Full specification", "/hosting#specs"], ["Client area", CLIENT_AREA_URL], ["System status", "/status"]] },
  { title: "EMAIL & SECURITY", links: [["Compare editions", "/email/compare-editions"], ["Business email", "/email"], ["Google Workspace pricing", "/google-workspace/pricing"], ["Microsoft 365", "/quote"], ["SSL certificates", "/ssl"]] },
  { title: "RESELLEROS", links: [["What it is", "/reselleros"], ["Modules", "/reselleros#features"], ["Interactive demo", "/reselleros"], ["Pricing — free in beta", "/reselleros#pricing"]] },
  { title: "COMPANY", links: [["About Anutech", "/why-us"], ["Reseller program", "/reseller"], ["Why us", "/why-us"], ["Support", "/contact"], ["Get a quote", "/quote"], ["ResellerOS login", "/login"],["Anutech Digital terms", "/terms-and-conditions"], ["Anutech Digital privacy", "/privacy-policy"], ["Refunds", "/refund"]] },
] as const;

export function Footer() {
  return (
    <footer style={{ background: "var(--tint-2)", borderTop: "1px solid var(--border-light)", padding: "52px 0 28px" }}>
      <div className="wrap">
        {/* R-1811: the columns live in site.css (.footer-grid), not styled-jsx — styled-jsx has no
            server registry here, so its phone rule arrived only after hydration and a phone's first
            paint was six columns, 592px wide on a 375px screen. */}
        <div className="footer-grid">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <Image src="/lp/anutech-logo.png" alt="ANUTECH Digital Pvt Ltd" width={108} height={36} style={{ objectFit: "contain", height: 36, width: "auto" }} />
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.55, color: "var(--text-secondary)", maxWidth: 260, margin: "0 0 14px" }}>
              Anutech Digital Pvt Ltd, Rohini, Delhi. {COMPANY.partnerLine}. Maker of ResellerOS.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {["GST INVOICE", "UPI", "NETBANKING", "VISA / MASTERCARD"].map((b) => (
                <span key={b} className="mono-label" style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "4px 8px", color: "var(--text-muted)" }}>
                  {b}
                </span>
              ))}
            </div>
          </div>
          {FOOTER_COLS.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 12 }}>{col.title}</div>
              {col.links.map(([label, href]) => (
                <Link key={label} href={href as never} style={{ display: "block", fontSize: 14, color: "var(--text-secondary)", padding: "4px 0" }}>
                  {label}
                </Link>
              ))}
            </nav>
          ))}
        </div>
        <div style={{ borderTop: "1px solid var(--border-light)", marginTop: 36, paddingTop: 18, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", fontSize: 12, color: "var(--text-muted)" }}>
          <span>© 2026 {COMPANY.name} · {COMPANY.city} · GSTIN {COMPANY.gstin}</span>
          <span>All prices exclusive of GST at 18%, stated separately on every invoice.</span>
        </div>
      </div>
    </footer>
  );
}

/* R-230 (6 Oct 2026): nothing floats on /checkout and /done. R-464 (10 Oct 2026): one floating
   action below 980px; R-1498 one launcher at every width. The rules live in ./floating; hideFloatingOn
   is re-exported here because the R-230 callers and tests import it from Chrome. */
export { hideFloatingOn };

export function ConsentBanner() {
  /* null until mounted — the banner must not flash for a visitor who already chose. */
  const [consent, setConsent] = useState<string | null | "unknown">("unknown");
  useEffect(() => {
    try {
      setConsent(window.localStorage.getItem("anutech.consent.v1"));
    } catch {
      setConsent("essential");
    }
  }, []);
  if (consent !== null) return null;

  const choose = (value: string) => {
    try { window.localStorage.setItem("anutech.consent.v1", value); } catch { /* in-memory only */ }
    setConsent(value);
  };

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      className="consent-banner"
      style={{
        position: "fixed", zIndex: 95,
        background: "#fff", border: "1px solid var(--border)", borderRadius: 10,
        padding: 18, boxShadow: "var(--shadow-panel)",
      }}
    >
      {/* R-230: left 22 + maxWidth 360 was wider than a 375px phone. Below 980px the banner
          spans the screen with a 12px gutter instead of hanging off the right edge. */}
      <style jsx>{`
        .consent-banner { left: 22px; bottom: 22px; max-width: 360px; }
        @media (max-width: 979px) {
          .consent-banner { left: 12px; right: 12px; bottom: 12px; max-width: none; }
        }
      `}</style>
      <p style={{ fontSize: 14, lineHeight: 1.5, color: "var(--text-secondary)", margin: "0 0 12px" }}>
        Essential cookies keep the cart working. Analytics cookies are set only if you accept them.
      </p>
      <div style={{ display: "flex", gap: 10 }}>
        <button className="btn btn-primary btn-sm" onClick={() => choose("all")}>Accept all</button>
        <button className="btn btn-outline btn-sm" onClick={() => choose("essential")}>Essential only</button>
      </div>
    </div>
  );
}
