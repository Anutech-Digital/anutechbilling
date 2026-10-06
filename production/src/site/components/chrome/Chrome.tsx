"use client";
/**
 * The rest of the global chrome: utility bar, breadcrumb, CTA band, footer, the persistent
 * WhatsApp pill and the consent banner. One file, because every piece is a fixed band with
 * no state of its own except consent — splitting them into six files would scatter what the
 * README describes as one system ("Global Chrome (every route)").
 */
import Image from "next/image";
import Link from "@/site/components/ui/SiteLink";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { COMPANY, WHATSAPP_URL, WHATSAPP_READY, CLIENT_AREA_URL } from "@/site/lib/config";

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
          <span><span style={{ color: "#FFC9A8" }}>Domain ₹0 with any 1-year hosting plan</span> · GST invoice on every order</span>
        ) : onHome ? (
          <span>Custom software &amp; office automation · Google Premier Partner since 2014</span>
        ) : (
          <span>Free migration on every plan · GST invoice on every order</span>
        )}
        <span className="hide-mobile" style={{ display: "flex", gap: 18 }}>
          <Link href="/rates">All prices</Link>
          <Link href="/contact">Support</Link>
          <Link href="/status">Status</Link>
          <Link href="/login">Client login</Link>
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
  "/login": "Client login",
  "/terms": "Terms of service",
  "/terms-and-conditions": "Terms and conditions",
  "/privacy": "Privacy policy",
  "/privacy-policy": "Privacy policy",
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
  { title: "RESELLEROS", links: [["What it is", "/reselleros"], ["Modules", "/reselleros#modules"], ["Interactive demo", "/reselleros"], ["Pricing — free in beta", "/reselleros#pricing"]] },
  { title: "COMPANY", links: [["About Anutech", "/about"], ["Reseller program", "/reseller"], ["Why us", "/why-us"], ["Support", "/contact"], ["Get a quote", "/quote"], ["Client login", "/login"], ["Terms", "/terms-and-conditions"], ["Privacy", "/privacy-policy"], ["Refunds", "/refund"]] },
] as const;

export function Footer() {
  return (
    <footer style={{ background: "var(--tint-2)", borderTop: "1px solid var(--border-light)", padding: "52px 0 28px" }}>
      <div className="wrap">
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr repeat(5, 1fr)", gap: 28 }} className="footer-grid">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <Image src="/lp/anutech-logo.png" alt="ANUTECH Digital Pvt Ltd" width={108} height={36} style={{ objectFit: "contain", height: 36, width: "auto" }} />
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.55, color: "var(--text-secondary)", maxWidth: 260, margin: "0 0 14px" }}>
              Anutech Digital Pvt Ltd, Rohini, Delhi. Google Premier Partner since 2014. Maker of ResellerOS.
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
      <style jsx>{`
        @media (max-width: 979px) {
          .footer-grid { grid-template-columns: 1fr 1fr !important; }
        }
      `}</style>
    </footer>
  );
}

/**
 * R-230 (6 Oct 2026): on a phone the floating boxes (AI chat launcher, WhatsApp pill, consent
 * banner) stacked over the bottom of the page — on /checkout that is the Pay button. Where the
 * visitor is paying or has just paid, the AI launcher and WhatsApp pill do not float at all:
 * the page itself is the whole task.
 */
export function hideFloatingOn(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return ["/checkout", "/done"].some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export function WhatsAppButton() {
  const pathname = usePathname();
  /* R-078 (4 Oct 2026): the floating button linked to the placeholder 919800000000 on every
     page, and sat over the Google Ads landing page price. Hidden until the real number is set
     in site/lib/config.ts (WHATSAPP_NUMBER), which flips WHATSAPP_READY. */
  if (!WHATSAPP_READY || hideFloatingOn(pathname)) return null;
  return (
    <a
      href={WHATSAPP_URL}
      target="_blank"
      rel="noopener"
      aria-label="WhatsApp us"
      style={{
        position: "fixed", right: 22, bottom: 22, zIndex: 90,
        display: "inline-flex", alignItems: "center", gap: 9,
        background: "var(--dark)", color: "#fff", borderRadius: 999, padding: "12px 18px",
        fontSize: 14, fontWeight: 600, boxShadow: "var(--shadow-panel)",
        transition: "background .15s ease",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--primary)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "var(--dark)")}
    >
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: "var(--bar-ok)" }} />
      WhatsApp us
    </a>
  );
}

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
