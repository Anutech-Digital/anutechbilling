"use client";
/**
 * Sticky header with six hover/keyboard mega-menus (Custom software first since R-155, 5 Oct
 * 2026 — the company leads with it), the cart badge, and the mobile drawer.
 *
 * The IA rule this file enforces comes from the handoff's first paragraph: two audiences
 * that must never be mixed. ResellerOS is a nav item of its own; everything else is a
 * service. The active route paints #1668E3 text plus an inset 2px underline.
 *
 * Keyboard behaviour per README: each top item is a button with aria-expanded; focus or
 * ArrowDown opens its panel, Enter/Space navigates, Escape closes, mouseleave on the whole
 * header closes.
 */
import Image from "next/image";
import Link from "@/site/components/ui/SiteLink";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useCart } from "@/site/components/cart/CartProvider";
import { CLIENT_AREA_URL } from "@/site/lib/config";

interface MenuItem { label: string; note: string; href: string }
interface Menu {
  label: string;
  href: string;
  cols: readonly (readonly MenuItem[])[];
  promo: { tag: string; title: string; body: string; cta: string; href: string; os?: boolean };
}

const MENUS: readonly Menu[] = [
  {
    label: "Custom software", href: "/#software",
    cols: [
      [
        { label: "Office automation", note: "Leads, GST billing, staff, approvals", href: "/#software" },
        { label: "How a project works", note: "Fixed quote, demo every milestone", href: "/#how" },
        { label: "Talk to us", note: "A free first call", href: "/#start" },
      ],
      [
        { label: "Our own software", note: "ResellerOS — we run on it daily", href: "/reselleros" },
        { label: "Questions", note: "Cost, timeline, support", href: "/#faq" },
        { label: "Why us", note: "Us vs the usual way", href: "/why-us" },
      ],
    ],
    promo: { tag: "FREE FIRST CALL", title: "Software built for how your business works", body: "Fixed quote before we start, a working demo at every milestone, GST invoice.", cta: "Tell us what to automate", href: "/#start" },
  },
  {
    label: "Domains", href: "/domains",
    cols: [
      [
        { label: "Search a domain", note: "Live availability, ₹ prices", href: "/domains" },
        { label: "Rate card", note: "Register, renew, transfer — one row", href: "/domains#rates" },
        { label: "Transfer in", note: "We pull auth codes for you", href: "/domains#rates" },
      ],
      [
        { label: "All prices", note: "Every rate on one page", href: "/rates" },
        { label: "WHOIS privacy", note: "Free where the registry permits", href: "/domains#included" },
        { label: "Bulk operations", note: "Whole portfolios in one action", href: "/domains#included" },
      ],
    ],
    promo: { tag: "FROM ₹249/YR", title: "Your name, in rupees", body: "500+ extensions with the renewal price printed next to the first-year price.", cta: "Search a domain", href: "/domains" },
  },
  {
    label: "Hosting", href: "/hosting",
    cols: [
      [
        { label: "Shared hosting", note: "cPanel on NVMe, from ₹49.99/mo", href: "/hosting" },
        { label: "Full specification", note: "All 14 rows, nothing hidden", href: "/hosting#specs" },
        { label: "Migration desk", note: "Free, done by us", href: "/contact" },
      ],
      [
        { label: "System status", note: "90-day uptime per service", href: "/status" },
        { label: "Client area", note: "Your domains and hosting", href: CLIENT_AREA_URL },
        { label: "SSL & security", note: "Free DV on every site", href: "/ssl" },
      ],
    ],
    promo: { tag: "99.9% SLA, CREDITED", title: "Mumbai and Bengaluru, LiteSpeed on NVMe", body: "If a month falls under the SLA we credit it without being asked.", cta: "See hosting plans", href: "/hosting" },
  },
  {
    label: "Email & security", href: "/email",
    cols: [
      [
        { label: "Business email", note: "Mailboxes from ₹79/mo", href: "/email" },
        { label: "Compare editions", note: "GW, M365, Zoho side by side", href: "/email/compare-editions" },
        { label: "Licence calculator", note: "Priced live, GST separate", href: "/email#products" },
      ],
      [
        { label: "Google Workspace", note: "Plans and pricing in INR", href: "/google-workspace/pricing" },
        { label: "Microsoft 365", note: "Licence management by us", href: "/quote" },
        { label: "SSL certificates", note: "DV free, OV/EV when needed", href: "/ssl" },
      ],
    ],
    promo: { tag: "FREE MIGRATION", title: "Forty mailboxes moved overnight", body: "Mail, folders, contacts and calendars — moved by us, nothing lost.", cta: "Get a mailbox quote", href: "/quote" },
  },
  {
    label: "ResellerOS", href: "/reselleros",
    cols: [
      [
        { label: "Subscription management", note: "Seats, terms, pro-rata, MRR", href: "/reselleros" },
        { label: "Pipeline & quotes", note: "Lead → quote → invoice, no re-typing", href: "/reselleros" },
        { label: "Interactive demo", note: "Click through the dashboard", href: "/reselleros" },
      ],
      [
        { label: "Renewals on autopilot", note: "T-30 / T-15 / T-7 / T-0 cadence", href: "/reselleros" },
        { label: "Bank reconciliation", note: "7 Indian bank parsers, Setu AA", href: "/reselleros" },
        { label: "GST & TDS", note: "HSN 998313, CGST §31, 26AS", href: "/reselleros" },
      ],
    ],
    promo: { tag: "FREE DURING BETA", title: "Run your first GST invoice in 10 minutes", body: "Create your tenant, import customers by CSV, send a compliant quote. 14-day trial, no card.", cta: "Start free trial", href: "/reselleros", os: true },
  },
  {
    label: "Wholesale", href: "/reseller",
    cols: [
      [
        { label: "Reseller program", note: "No slabs, no deposit", href: "/reseller" },
        { label: "Margin calculator", note: "Your numbers, our rates", href: "/reseller#margin" },
        { label: "Rate card", note: "Published, not behind a panel", href: "/rates" },
      ],
      [
        { label: "GW / M365 / Zoho resellers", note: "Built by one, in Delhi", href: "/reselleros" },
        { label: "White label", note: "Your brand on the invoice", href: "/reseller" },
        { label: "Why us", note: "Us vs the usual way", href: "/why-us" },
      ],
    ],
    promo: { tag: "₹0 TO JOIN", title: "The price you read today is the price on order one", body: "Published wholesale rates. No advance deposit, no volume slabs.", cta: "See the program", href: "/reseller" },
  },
];

const MOBILE_PAGES = [
  { label: "Home", note: "Everything Anutech does", href: "/" },
  { label: "Custom software", note: "Office automation, built for you", href: "/#software" },
  { label: "Domains", note: "500+ extensions, from ₹249/yr", href: "/domains" },
  { label: "Hosting", note: "cPanel on NVMe, from ₹49.99/mo", href: "/hosting" },
  { label: "Business email", note: "Mailboxes from ₹79/mo", href: "/email" },
  { label: "Compare editions", note: "GW, M365 and Zoho side by side", href: "/email/compare-editions" },
  { label: "Google Workspace pricing", note: "Every plan in INR + GST", href: "/google-workspace/pricing" },
  { label: "SSL & security", note: "Free DV on every site", href: "/ssl" },
  { label: "ResellerOS", note: "Software for resellers · free in beta", href: "/reselleros" },
  { label: "Reseller program", note: "No slabs, no deposit", href: "/reseller" },
  { label: "All prices", note: "Every rate on one page", href: "/rates" },
  { label: "Why us", note: "Us vs the usual way", href: "/why-us" },
  { label: "Support", note: "Email and call-back", href: "/contact" },
  { label: "Status", note: "90-day uptime", href: "/status" },
] as const;

export function Header() {
  const [open, setOpen] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const cart = useCart();

  /* Navigation closes everything — a menu left open across a route change reads as broken. */
  useEffect(() => {
    setOpen(null);
    setMobile(false);
  }, [pathname]);

  const active = MENUS.find((m) => m.label === open) ?? null;

  /* /domains and /hosting are the "orange" editorial sections. On them the chrome
     picks up the brand accent (ink + amber) instead of the services blue, so the
     header sits with the page's own palette rather than leaking a second colour
     onto an all-orange page. Every other route keeps the blue services identity. */
  const orange = pathname.startsWith("/domains") || pathname.startsWith("/hosting");
  const accent = orange ? "var(--accent)" : "var(--primary)";
  const activeNav = orange ? "var(--text)" : "var(--primary)";

  return (
    <header
      onMouseLeave={() => setOpen(null)}
      style={{ position: "sticky", top: 0, zIndex: 80, background: "#fff", borderBottom: "1px solid var(--border-light)" }}
    >
      {/* The gap lives in site.css (.site-header-row): 26px, 10px on a phone — at 320px the fixed 26px
          pushed the menu button off the screen and the page scrolled sideways (7 Oct 2026). */}
      <div className="wrap site-header-row" style={{ height: 68, display: "flex", alignItems: "center" }}>
        {/* The marketing home lives at "/", but "/" redirects a logged-in user to
            /dashboard — so for an owner browsing the site, the logo would bounce to
            the app instead of the company home they clicked for. "?preview=1" is the
            root page's built-in bypass: it shows the Anutech Digital home to everyone,
            signed in or not. */}
        <Link href="/?preview=1" style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }} aria-label="Anutech Digital home">
          {/* New ANUTECH logo, the wordmark is in the image (Pardeep, 4 Oct 2026). */}
          <Image src="/lp/anutech-logo.png" alt="ANUTECH Digital Pvt Ltd" width={120} height={40} priority style={{ objectFit: "contain", height: 40, width: "auto" }} />
        </Link>

        <nav className="hide-mobile" style={{ display: "flex", gap: 4, flex: 1 }} aria-label="Main">
          {MENUS.map((m) => {
            /* Exact segment match, not startsWith: "/reselleros".startsWith("/reseller") is
               true, and the first render of the ResellerOS page lit up Wholesale too. */
            const isActive = pathname === m.href || pathname.startsWith(m.href + "/");
            return (
              <div
                key={m.label}
                className="nav-item"
                role="button"
                tabIndex={0}
                aria-expanded={open === m.label}
                onMouseEnter={() => setOpen(m.label)}
                onFocus={() => setOpen(m.label)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push(m.href as never); }
                  else if (e.key === "Escape") setOpen(null);
                  else if (e.key === "ArrowDown") { e.preventDefault(); setOpen(m.label); }
                }}
                style={{
                  padding: "24px 10px", fontSize: 15, fontWeight: isActive ? 600 : 500, cursor: "pointer", whiteSpace: "nowrap",
                  color: isActive ? activeNav : "var(--text)",
                  boxShadow: isActive ? `inset 0 -2px 0 0 ${accent}` : "none",
                }}
              >
                {m.label} <span aria-hidden style={{ fontSize: 10, color: "var(--text-muted)" }}>▾</span>
              </div>
            );
          })}
          <Link
            href="/why-us"
            className="nav-item nav-why"
            style={{
              padding: "24px 10px", fontSize: 15, whiteSpace: "nowrap", fontWeight: pathname === "/why-us" ? 600 : 500,
              color: pathname === "/why-us" ? activeNav : "var(--text)",
              boxShadow: pathname === "/why-us" ? `inset 0 -2px 0 0 ${accent}` : "none",
            }}
          >
            Why us
          </Link>
        </nav>

        <span style={{ flex: 1 }} className="only-mobile" />

        <Link
          href="/cart"
          aria-label={`Cart, ${cart.lines.length} items`}
          style={{
            display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600,
            padding: "9px 14px", borderRadius: 6, border: "1px solid var(--border-strong)",
          }}
        >
          Cart
          <span
            className="mono"
            style={{
              fontSize: 12, minWidth: 20, textAlign: "center", padding: "1px 6px", borderRadius: 999,
              background: cart.lines.length ? accent : "var(--border-hairline)",
              color: cart.lines.length ? "#fff" : "var(--text-muted)",
            }}
          >
            {cart.lines.length}
          </span>
        </Link>
        {/* Log in to the ResellerOS app / client area — the conventional top-right
            spot, present on every page. "Get a quote" used to sit here as the
            primary CTA but Pardeep had it removed from the header (3 Sep 2026); it
            still lives in the hero, the mega-menu promos and the footer. With it
            gone, Log in is the header's right-side action, so it reads as a button. */}
        <Link href="/login" className="btn btn-sm hide-mobile" aria-label="Log in to ResellerOS"
          style={{ background: orange ? "var(--dark)" : "var(--primary)", borderColor: orange ? "var(--dark)" : "var(--primary)", color: "#fff", whiteSpace: "nowrap" }}>Log in</Link>
        <button
          className="only-mobile"
          aria-label={mobile ? "Close menu" : "Open menu"}
          aria-expanded={mobile}
          onClick={() => setMobile((v) => !v)}
          style={{ background: "none", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "8px 12px", minWidth: 44, minHeight: 44, fontSize: 16, cursor: "pointer", flexShrink: 0 }}
        >
          {mobile ? "✕" : "☰"}
        </button>
      </div>

      {active && (
        <div
          style={{
            position: "absolute", left: 0, right: 0, top: "100%", background: "#fff",
            borderBottom: "1px solid var(--border-light)", boxShadow: "var(--shadow-menu)",
            animation: "wDrop .16s ease", zIndex: 79,
          }}
        >
          <div className="wrap" style={{ display: "grid", gridTemplateColumns: "2.2fr 1fr", gap: 32, padding: "28px 48px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
              {active.cols.map((col, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {col.map((item) => (
                    <Link key={item.label} href={item.href as never} style={{ padding: "9px 10px", borderRadius: 6 }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--tint)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <div style={{ fontSize: 15, fontWeight: 500 }}>{item.label}</div>
                      <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{item.note}</div>
                    </Link>
                  ))}
                </div>
              ))}
            </div>
            <div style={{ background: "var(--tint)", border: "1px solid var(--border)", borderRadius: 10, padding: 22 }}>
              <div className="mono-label" style={{ color: active.promo.os ? "var(--accent)" : "var(--primary)", marginBottom: 8 }}>
                {active.promo.tag}
              </div>
              <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 8 }}>{active.promo.title}</div>
              <p className="body" style={{ margin: "0 0 14px" }}>{active.promo.body}</p>
              <Link href={active.promo.href as never} className={`btn btn-sm ${active.promo.os ? "btn-os" : "btn-primary"}`}>
                {active.promo.cta}
              </Link>
              {/* On the ResellerOS menu the promo sells a free trial — so the
                  existing-user path (Log in) sits right under it, the same
                  two-step choice the home ResellerOS card makes. */}
              {active.promo.os && (
                <div style={{ marginTop: 12, fontSize: 13.5 }}>
                  <Link href="/login" style={{ color: "var(--accent)", fontWeight: 600 }}>Already have an account? Log in</Link>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {mobile && (
        <nav aria-label="Mobile" style={{ borderTop: "1px solid var(--border-light)", background: "#fff", animation: "wDrop .16s ease", maxHeight: "70vh", overflowY: "auto" }}>
          {MOBILE_PAGES.map((p) => (
            <Link
              key={p.href}
              href={p.href as never}
              style={{
                display: "block", padding: "13px 20px", borderBottom: "1px solid var(--border-hairline)",
                color: pathname === p.href ? "var(--primary)" : "var(--text)",
              }}
            >
              <span style={{ fontSize: 15, fontWeight: 600 }}>{p.label}</span>
              <span style={{ display: "block", fontSize: 13, color: "var(--text-muted)" }}>{p.note}</span>
            </Link>
          ))}
          {/* Sign-in gets its own emphasised row on mobile — the desktop top-right
              "Log in" is hidden here, so this is where a returning customer finds it. */}
          <Link href="/login" style={{ display: "block", padding: "15px 20px", background: "var(--tint)", color: "var(--primary)", fontWeight: 700, fontSize: 15 }}>
            Log in to ResellerOS →
          </Link>
        </nav>
      )}
    </header>
  );
}
