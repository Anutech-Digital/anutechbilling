"use client";

/**
 * HomeV2 — the email-first page ("Anutech Home v2" handoff, 5 Sep 2026). Since 5 Oct 2026
 * (R-155) it is the Business Email category page at /email, not the home: the home is
 * about the whole company (HomeCompany). On /email it drops the "rest of the catalogue"
 * and ResellerOS bands (the home carries those) and adds Anutech Mail, the ₹79 mailbox
 * the header promises.
 *
 * Originally the email-first home,
 * rebuilt to the handoff's HIGH-FIDELITY design (Pardeep: the zip's home design
 * is much better). Two questions in order — which suite, then which edition —
 * ending in Buy / Start trial / Get a quote.
 *
 * This is a faithful port of the design's own visual language (Archivo + IBM
 * Plex Mono, the blue #1668E3 primary with a GREEN #0F7B4F trust accent on the
 * selected suite and the recommended edition, the exact card spacing, shadows
 * and typography) rendered with inline styles — the same approach as the
 * DomainLanding / HostingLanding pages. It shares the blue services chrome, so
 * it renders only its body; the chrome (utility bar, header, CtaBand, footer,
 * cart drawer) wraps it via the (marketing) layout.
 *
 * REAL DATA only: editions from LICENCE_EDITIONS, features from EDITION_MATRICES,
 * catalogue/trust/reviews from copy.ts. CTAs go to WhatsApp (buy/trial) and
 * /quote — no fake instant licence checkout. Conversion + SEO/AI decisions from
 * the 5 Sep web research (annual-default + absolute-₹ saving, GST/ITC line by
 * the price, comparison table with literal values, FAQ that feeds FAQPage).
 */
import { useEffect, useState } from "react";
import Link from "@/site/components/ui/SiteLink";
import { LICENCE_EDITIONS, EDITION_MATRICES, type LicenceEdition } from "@/site/lib/data/catalog";
import type { MergedEdition } from "@/site/lib/live-catalog";
import { TRUST } from "@/site/lib/data/copy";
import { editionDelta } from "@/site/lib/edition-delta";
import { buyWorkspaceHref } from "@/lib/checkout/buy-link";
import { HOSTING_FROM_MO } from "@/site/lib/data/hosting-landing-v2";
import { WHATSAPP_URL, COMPANY, SLA } from "@/site/lib/config";
import { HOME_FAQS } from "@/site/lib/data/home-faqs";
import { MAIL_OPTIONS } from "@/site/lib/data/copy";
import { MAIL_RATES } from "@/site/lib/data/catalog";
import { CONTACT_FOR_PRICING, PLUS_EDITION } from "@/lib/catalog/public-price-policy";

/* Design tokens — the handoff's exact palette. */
export const C = {
  ink: "#0C1116", ink2: "#2A333D", body: "#4A5560", sec: "#5C6672", faint: "#8A939E",
  blue: "#1668E3", blueDk: "#0A47A0", green: "#0F7B4F", greenT: "#EEF7F0", greenT2: "#E7F4ED",
  surf: "#fff", surfT: "#FBFCFE", sectT: "#F7FAFD", strip: "#F5F7FB", stripBd: "#E6EAF0",
  border: "#D6DCE4", borderL: "#E0E5EC", hair: "#EEF1F5", strong: "#C6CED8", tableHead: "#EEF2F8",
};
export const MONO = "var(--font-mono), 'IBM Plex Mono', monospace";
const BTN_PRIMARY = "linear-gradient(180deg, #1668E3, #0A47A0)";
const SH_CARD = "0 12px 30px -26px rgba(12,17,22,.3)";
const SH_GREEN = "0 20px 46px -30px rgba(15,123,79,.55)";
const SH_BTN = "0 12px 26px -16px rgba(22,104,227,.7)";

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const WA = (text: string) => `${WHATSAPP_URL}?text=${encodeURIComponent(text)}`;

type VendorKey = "gw" | "ms" | "zoho";
type Billing = "annual" | "monthly";

interface Vendor {
  key: VendorKey; name: string; logo: string; logoH: number; desc: string;
  prefix: string; matrix: string | null; popular: string; blurb: string; sub: string;
}
const VENDORS: Vendor[] = [
  { key: "gw", name: "Google Workspace", logo: "/logo-google-workspace-wordmark.png", logoH: 20, desc: "Gmail, Meet and Drive on your own domain", prefix: "GW ", matrix: "Google Workspace", popular: "GW Business Standard",
    blurb: "Google Workspace has three editions — which one?", sub: "The only difference is storage and controls. Gmail, Docs, Meet and Gemini are in all three — up to 300 users." },
  { key: "ms", name: "Microsoft 365", logo: "/logo-microsoft-365-trim.png", logoH: 24, desc: "Outlook, Teams and OneDrive for your team", prefix: "M365 ", matrix: "Microsoft 365", popular: "M365 Business Standard",
    blurb: "Microsoft 365 — Basic or Standard?", sub: "Both include Outlook, Teams and 1 TB OneDrive. Standard adds the desktop Office apps you install on your machine." },
  { key: "zoho", name: "Zoho Workplace", logo: "/logo-zoho-trim.png", logoH: 24, desc: "Cheapest full suite — mail plus Writer, Sheet and Show", prefix: "Zoho", matrix: null, popular: "Zoho Workplace",
    blurb: "Zoho Workplace — one simple edition.", sub: "Mail plus Writer, Sheet and Show, 30 GB per user. The cheapest way onto your own domain with a full office suite." },
];
const LABEL: Record<string, string> = {
  "GW Business Starter": "Business Starter", "GW Business Standard": "Business Standard", "GW Business Plus": "Business Plus",
  "M365 Business Basic": "Business Basic", "M365 Business Standard": "Business Standard", "Zoho Workplace": "Workplace Standard",
};
const DESC: Record<string, string> = {
  "GW Business Starter": "Small team — Gmail, Drive and Meet are enough",
  "GW Business Standard": "Teams that keep more files and meeting recordings",
  "GW Business Plus": "Compliance, Vault and larger meetings",
  "M365 Business Basic": "Web and mobile Office, Outlook and Teams",
  "M365 Business Standard": "Adds the desktop Office apps on your machine",
  "Zoho Workplace": "The full office suite at the lowest price",
};
const ZOHO_FEATURES = ["Custom email on your domain", "Mail, Writer, Sheet, Show, Calendar", "30 GB per user", "IMAP, POP and mobile apps", "Migration done by us, free"];

/** A monthly per-user rate as rupees per user per day, GST included (the hero cards' rule). */
const perDayOf = (monthly: number) => Math.round((monthly * 1.18 * 12) / 365);

/** ALL "Yes"/valued features for an edition (no cap — the card shows a few and
 *  a "See all N features" toggle reveals the rest). */
function featuresFor(v: Vendor, i: number): string[] {
  if (!v.matrix) return ZOHO_FEATURES;
  const m = EDITION_MATRICES[v.matrix];
  if (!m) return [];
  const out: string[] = [];
  for (const row of m.rows) {
    const [label, ...cells] = row;
    if (/price|user cap/i.test(label)) continue;
    const cell = cells[i];
    if (cell && cell !== "—") out.push(cell === "Yes" ? label : `${label}: ${cell}`);
  }
  return out;
}

/** R-347: migration timing from SLA.migration (was "overnight"). */
const MIGRATION_CELL = `✓ ₹0, done by us, ${SLA.migration}`;

/** Cross-vendor comparison — the handoff's own copy (GW vs M365 vs Zoho). Cells
 *  lead with a marker: ✓ included · ✕ not included · ₹ costs extra. Bill-per-user
 *  is computed live from the entry edition of each suite. */
const CROSS_ROWS: readonly { label: string; gw: string; ms: string; zoho: string }[] = [
  { label: "Storage per user", gw: "30 GB · 2 TB on Standard · 5 TB on Plus", ms: "50 GB mailbox + 1 TB OneDrive", zoho: "30 GB mailbox + WorkDrive" },
  { label: "Mail on your own domain", gw: "✓ Gmail", ms: "✓ Outlook", zoho: "✓ Zoho Mail" },
  { label: "Desktop Word / Excel", gw: "✕ Browser and mobile only", ms: "✓ From Business Standard (₹770)", zoho: "✕ Browser and mobile" },
  { label: "Meetings", gw: "Meet: 100 · 150 on Standard · 500 on Plus", ms: "Teams: meetings and webinars", zoho: "Zoho Meeting: fine for a small team" },
  { label: "Compliance / audit tools", gw: "✓ Vault, in Business Plus (price on request)", ms: "₹ Purchased separately", zoho: "✕ Not in this plan" },
  { label: "User limit", gw: "Up to 300; Enterprise after that", ms: "Up to 300 on Business plans", zoho: "No practical limit" },
  { label: "Where the data sits", gw: "Google, India region pricing", ms: "Microsoft's regions", zoho: "Zoho's Indian datacentre" },
  { label: "Migration and support", gw: MIGRATION_CELL, ms: MIGRATION_CELL, zoho: MIGRATION_CELL },
];

/** "The rest of the catalogue" — the handoff's four cards, wired to the app's
 *  real pages. `gst` is "+ GST 18%" or "No charge" per the design. `icon` keys a
 *  simple line-art glyph that fills a tinted 16:9 band (consistent across all
 *  four — no half-empty photo slots). */
export const CATALOGUE_V2: readonly { name: string; href: string; from: string; unit: string; gst: string; body: string; tags: string[]; cta: string; icon: "globe" | "server" | "lock" | "tag"; img?: string }[] = [
  { name: "Domains", href: "/domains", from: "₹249", unit: "from · first year", gst: "+ GST 18%", body: "500+ extensions, register and renew price on one row.", tags: ["500+ TLDS", "FREE DNS", "WHOIS PRIVACY"], cta: "See domain rates", icon: "globe", img: "/domain-search.jpg" },
  { name: "Web hosting", href: "/hosting", from: HOSTING_FROM_MO, unit: "from · /mo, billed yearly", gst: "+ GST 18%", body: "cPanel and LiteSpeed on NVMe, Mumbai and Bengaluru.", tags: ["CPANEL", "LITESPEED", "99.9% SLA"], cta: "See hosting plans", icon: "server", img: "/cat-hosting.png" },
  { name: "SSL & security", href: "/ssl", from: "₹0", unit: "free DV", gst: "No charge", body: "Free DV on every hosted site; wildcard and OV when needed.", tags: ["DV", "OV", "WILDCARD"], cta: "See SSL options", icon: "lock", img: "/cat-ssl.jpg" },
  { name: "Reseller program", href: "/reseller", from: "₹0", unit: "to join", gst: "No charge", body: "Published wholesale rates. No slabs, no advance deposit.", tags: ["NO DEPOSIT", "ONE RATE", "WHITE LABEL"], cta: "See the rate card", icon: "tag", img: "/cat-reseller.png" },
];
const CAT_ICON: Record<string, string> = {
  globe: "M12 2a10 10 0 100 20 10 10 0 000-20zM2 12h20M12 2c2.5 2.7 4 6.3 4 10s-1.5 7.3-4 10c-2.5-2.7-4-6.3-4-10s1.5-7.3 4-10z",
  server: "M4 5h16v5H4zM4 14h16v5H4zM7.5 7.5h.01M7.5 16.5h.01",
  lock: "M6 10V8a6 6 0 1112 0v2M5 10h14v10H5zM12 14v3",
  tag: "M20.6 13.4 12 22l-9-9V4h9l8.6 8.6a1.4 1.4 0 010 2zM7.5 7.5h.01",
};

/** Migration — the handoff's "we do three, you do one" four-step section that
 *  carries the real Google Workspace inbox image. */
const MIG_STEPS: readonly { n: string; title: string; body: string; who: string }[] = [
  { n: "01", title: "Just tell us this much", body: "How many people, where mail runs today, and which domain. Ten minutes — no file or list to prepare.", who: "You" },
  { n: "02", title: "We prepare everything first", body: "We create every mailbox, its aliases and forwarding, and test that your mail doesn't land in spam (SPF, DKIM, DMARC).", who: "We" },
  { n: "03", title: "The switch happens at night, after your office hours", body: "Old mail, folders, contacts and calendar are copied, then we point the domain at the new mail. Your team does nothing.", who: "We" },
  { n: "04", title: "We stay with you on WhatsApp the next morning", body: "The team logs in; if someone's password or phone isn't set up we fix it right there. Invoice afterwards, not before.", who: "We" },
];

const wrap = (extra?: React.CSSProperties): React.CSSProperties => ({ maxWidth: 1180, margin: "0 auto", padding: "0 48px", ...extra });
const eyebrow: React.CSSProperties = { fontFamily: MONO, fontSize: 10.5, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: C.blue };
const monoNum = (extra?: React.CSSProperties): React.CSSProperties => ({ fontFamily: MONO, fontVariantNumeric: "tabular-nums", ...extra });

export function HomeV2({ editions, page = "email" }: { editions?: MergedEdition[]; page?: "email" | "home" } = {}) {
  const onEmail = page === "email";
  const [vendorKey, setVendorKey] = useState<VendorKey>("gw");
  const [billing, setBilling] = useState<Billing>("annual");
  const [seats, setSeats] = useState(1);
  const [compareOpen, setCompareOpen] = useState(false);
  const [featuresOpen, setFeaturesOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [openFaq, setOpenFaq] = useState(0);
  const [w, setW] = useState(1200);

  useEffect(() => {
    const m = () => setW(Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0));
    window.addEventListener("resize", m); m();
    return () => window.removeEventListener("resize", m);
  }, []);
  const mob = w < 980;

  // Deep links: /#compare and /#features open + scroll to those sections, so the
  // nav/footer/hero links (and a shared URL) land in the right place.
  useEffect(() => {
    const openFromHash = () => {
      const h = window.location.hash;
      if (h === "#compare") setCompareOpen(true);
      if (h === "#features") setFeaturesOpen(true);
      if (h === "#compare" || h === "#features") {
        setTimeout(() => document.querySelector(h)?.scrollIntoView({ behavior: "smooth" }), 60);
      }
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  const vendor = VENDORS.find((v) => v.key === vendorKey)!;
  const annual = billing === "annual";
  const rateOf = (e: LicenceEdition) => (annual ? e.annual : e.monthly);

  // Live GW rates (from the app catalogue) override the placeholders; fall back
  // to placeholders if the page didn't pass any. Same source the /quote uses.
  const LIST: readonly LicenceEdition[] = editions && editions.length ? editions : LICENCE_EDITIONS;
  const editionsFor = (v: Vendor) => LIST.filter((e) => e.name.startsWith(v.prefix));

  const allAnnual = LIST.map((e) => e.annual);
  const heroMin = Math.min(...allAnnual), heroMax = Math.max(...allAnnual);
  const maxSavePct = Math.max(...LIST.map((e) => Math.round((1 - e.annual / e.monthly) * 100)));

  const vendorEditions = editionsFor(vendor);
  const popularEd = vendorEditions.find((e) => e.name === vendor.popular) ?? vendorEditions[0];
  const savePerYear = (popularEd.monthly - popularEd.annual) * 12;
  const savePct = Math.round((1 - popularEd.annual / popularEd.monthly) * 100);

  return (
    <div style={{ background: C.surf, color: C.body, fontFamily: "var(--font-sans), 'Archivo', system-ui, sans-serif" }}>
      {/* ── HERO: pick a suite ─────────────────────────────────────────────── */}
      <section style={wrap({ padding: "34px 48px 6px", textAlign: "center" })}>
        <div style={eyebrow}>Google Premier Partner · Delhi · Since 2014</div>
        <h1 style={{ fontSize: mob ? 30 : 38, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1.06, margin: "12px auto", maxWidth: 900, color: C.ink, textWrap: "balance" as const }}>
          Business mail and Office — in rupees, supported on WhatsApp.
        </h1>
        <p style={{ fontSize: 16.5, lineHeight: 1.55, color: C.body, margin: "0 auto 6px", maxWidth: 760, textWrap: "pretty" as const }}>
          <b style={{ fontWeight: 600, color: C.ink }}>From {inr(heroMin)} to {inr(heroMax)}/user/mo</b> — Google Workspace, Microsoft 365 and Zoho, all three rates published on this page. Pick one to see the price for your team.
        </p>
        <p style={{ fontSize: 13.5, fontWeight: 600, color: C.green, margin: "0 auto 20px" }}>
          Annual billing saves up to {maxSavePct}% · GST invoice in ₹, input-credit eligible.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "repeat(3, minmax(0,1fr))", gap: 12, maxWidth: 860, margin: "0 auto 14px", textAlign: "left" }}>
          {VENDORS.map((v) => {
            const from = Math.min(...editionsFor(v).map((e) => e.annual));
            const perDay = Math.round((from * 1.18 * 12) / 365);
            const on = v.key === vendorKey;
            const rec = v.key === "gw";
            return (
              <button key={v.key} onClick={() => { setVendorKey(v.key); document.getElementById("products")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} aria-pressed={on}
                style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", textAlign: "left", fontFamily: "inherit", padding: "16px 18px", borderRadius: 12, cursor: "pointer",
                  background: on ? C.greenT : C.surf, border: `1px solid ${on ? C.green : C.borderL}`, boxShadow: on ? SH_GREEN : SH_CARD }}>
                <span style={{ display: "flex", alignItems: "center", width: "100%", minHeight: 20, marginBottom: 2 }}>
                  {rec && <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: C.green, background: C.greenT2, padding: "3px 7px", borderRadius: 999, whiteSpace: "nowrap" }}>Most teams pick this</span>}
                </span>
                <span style={{ display: "flex", alignItems: "center", width: "100%", minHeight: 24 }}>
                  <img src={v.logo} alt={v.name} style={{ display: "block", height: v.logoH, width: "auto", maxWidth: "100%", objectFit: "contain" }} />
                </span>
                <span style={{ display: "flex", alignItems: "baseline", gap: 5, marginTop: 9 }}>
                  <span style={monoNum({ fontSize: 26, fontWeight: 500, letterSpacing: "-0.03em", color: C.ink })}>from {inr(from)}</span>
                  <span style={{ fontSize: 12, color: C.sec }}>/user/mo + GST</span>
                </span>
                <span style={{ display: "block", fontSize: 12, color: C.sec, marginTop: 2 }}>≈ {inr(perDay)} per user a day, GST included</span>
                <span style={{ display: "block", fontSize: 12.5, lineHeight: 1.4, color: C.ink2, marginTop: 9, minHeight: 36 }}>{v.desc}</span>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.blue, marginTop: 10 }}>See editions →</span>
              </button>
            );
          })}
        </div>
        <p style={{ fontSize: 13, color: C.sec, margin: 0 }}>
          Not sure? <a href={WA("Hi Anutech — here's our current email bill, can you compare and quote?")} target="_blank" rel="noopener" style={{ color: C.green, fontWeight: 600 }}>Send your current bill on WhatsApp</a> — we compare and reply in writing.{"  "}
          <button onClick={() => { setCompareOpen(true); setTimeout(() => document.getElementById("compare")?.scrollIntoView({ behavior: "smooth" }), 30); }} style={{ background: "none", border: "none", cursor: "pointer", color: C.blue, fontWeight: 600, fontSize: 13, fontFamily: "inherit" }}>Compare editions side by side →</button>
        </p>
      </section>

      {/* ── PRODUCT: pick an edition ───────────────────────────────────────── */}
      <section id="products" style={wrap({ padding: "44px 48px 8px", scrollMarginTop: 12 })}>
        {/* sticky strip */}
        <div style={{ position: "sticky", top: 69, zIndex: 60, display: "grid", gridTemplateColumns: mob ? "1fr" : "auto 1fr auto", alignItems: "center", gap: 18, padding: "10px 14px", background: C.strip, border: `1px solid ${C.stripBd}`, borderRadius: 14, backdropFilter: "blur(6px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
            <span style={{ fontSize: 14, color: C.ink2 }}>Users</span>
            <span style={{ display: "inline-flex", alignItems: "center", background: C.surf, border: `1px solid #DDE3EB`, borderRadius: 8, overflow: "hidden" }}>
              <input value={seats} inputMode="numeric" aria-label="Number of users"
                onChange={(e) => setSeats(Math.max(1, Math.min(5000, Number(e.target.value.replace(/\D/g, "")) || 1)))}
                style={{ width: 52, textAlign: "center", fontFamily: MONO, fontSize: 14, padding: "7px 0", border: "none", outline: "none", color: C.ink, background: C.surf }} />
              <span style={{ display: "flex", flexDirection: "column", borderLeft: `1px solid ${C.hair}` }}>
                <button onClick={() => setSeats((s) => Math.min(5000, s + 1))} aria-label="One more user" style={{ fontFamily: "inherit", fontSize: 9, lineHeight: 1, padding: "3px 7px", border: "none", background: C.surf, color: C.sec, cursor: "pointer" }}>▲</button>
                <button onClick={() => setSeats((s) => Math.max(1, s - 1))} aria-label="One less user" style={{ fontFamily: "inherit", fontSize: 9, lineHeight: 1, padding: "3px 7px", border: "none", borderTop: `1px solid ${C.hair}`, background: C.surf, color: C.sec, cursor: "pointer" }}>▼</button>
              </span>
            </span>
            <span style={{ fontSize: 12, color: C.sec, whiteSpace: "nowrap" }}>prices update as you type</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minWidth: 0 }}>
            <img src={vendor.logo} alt={vendor.name} style={{ display: "block", height: vendor.logoH, width: "auto", maxWidth: "100%", objectFit: "contain" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 13.5, lineHeight: 1.35, color: C.ink2 }}>
              <b style={{ fontWeight: 600, color: C.ink, whiteSpace: "nowrap" }}>{annual ? "Annual" : "Monthly"}</b>{" "}
              <span style={{ color: C.green }}>{annual ? `saves ${savePct}% · ${inr(savePerYear)}/user/yr` : "flexible"}</span>
            </span>
            <button onClick={() => setBilling(annual ? "monthly" : "annual")} role="switch" aria-checked={annual} aria-label="Annual commitment"
              style={{ display: "flex", alignItems: "center", justifyContent: annual ? "flex-end" : "flex-start", width: 42, height: 22, flex: "none", padding: 3, border: "none", borderRadius: 999, cursor: "pointer", background: annual ? C.green : C.strong }}>
              <span aria-hidden style={{ width: 16, height: 16, flex: "none", borderRadius: 999, background: "#fff", boxShadow: "0 1px 3px rgba(12,17,22,.3)" }} />
            </button>
          </div>
        </div>

        <div style={{ height: 18 }} />

        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : ".82fr 2.18fr", gap: mob ? 24 : 36, alignItems: "stretch" }}>
          {/* left explainer */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ ...eyebrow, marginBottom: 10 }}>Premier Partner · Since 2014</div>
            <h2 style={{ fontSize: 27, fontWeight: 700, letterSpacing: "-0.035em", lineHeight: 1.1, margin: "0 0 10px", color: C.ink, textWrap: "balance" as const }}>{vendor.blurb}</h2>
            <p style={{ fontSize: 14.5, lineHeight: 1.5, color: C.body, margin: "0 0 14px", textWrap: "pretty" as const }}>{vendor.sub}</p>
            <p style={{ fontSize: 12.5, color: C.sec, margin: "auto 0 0", paddingTop: 16, borderTop: `1px solid ${C.borderL}` }}>
              <b style={{ fontWeight: 600, color: C.ink }}>Set users and billing above</b> — totals update live. Every rate is + 18% GST, invoiced in ₹ by {COMPANY.short} — input-credit eligible. Nothing is charged until you approve.
            </p>
          </div>

          {/* edition trio */}
          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : `repeat(${Math.min(vendorEditions.length + (vendor.key === "gw" ? 1 : 0), 3)}, minmax(0,1fr))`, gap: 16, alignItems: "stretch" }}>
            {vendorEditions.map((e, i) => {
              const rate = rateOf(e);
              const pop = e.name === vendor.popular;
              const feats = featuresFor(vendor, i);
              const lowerName = i > 0 ? (LABEL[vendorEditions[i - 1].name] ?? vendorEditions[i - 1].name) : null;
              const shown = i > 0 ? editionDelta(featuresFor(vendor, i - 1), feats) : feats;
              const total = annual ? `${inr(e.annual * 12 * seats)}/yr` : `${inr(e.monthly * seats)}/mo`;
              /* R-120: Google editions go to the Razorpay checkout; M365 / Zoho have no online
                 buy yet and keep the WhatsApp request. */
              /* R-157: online payment is yearly only (the checkout writes an annual commitment), so
                 with Monthly picked the card offers a monthly quote instead of a Buy that would charge
                 a year. The quote link carries edition, users and term so nothing is typed twice. */
              const quoteHref = `/quote?ed=${encodeURIComponent(e.name)}&seats=${seats}&term=${annual ? "annual" : "monthly"}`;
              const onlinePay = buyWorkspaceHref(e.name, seats);
              const payHref = annual ? onlinePay : null;
              const buyHref = payHref ?? (onlinePay ? quoteHref : null) ?? WA(`Hi Anutech — I'd like to buy ${vendor.name} ${LABEL[e.name] ?? e.name} for ${seats} user${seats > 1 ? "s" : ""} (${annual ? "annual" : "monthly"}). Please send the payment link.`);
              return (
                <div key={e.name} style={{ position: "relative", display: "flex", flexDirection: "column", padding: 20, border: `1px solid ${pop ? C.green : C.border}`, borderRadius: 12, background: pop ? C.greenT : C.surf, boxShadow: pop ? SH_GREEN : SH_CARD }}>
                  {/* Card order (2 Oct 2026): who it is for → the price, big → what N users cost →
                      one primary action that says where it goes → what this edition ADDS over the
                      one below (editionDelta), so the eye finds what the extra rupees buy. */}
                  {pop && (
                    <span style={{ position: "absolute", top: -10, left: 20, fontFamily: MONO, fontSize: 9, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "#fff", background: C.green, padding: "3px 8px", borderRadius: 999 }}>Most teams pick this</span>
                  )}
                  <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em", color: C.ink }}>{LABEL[e.name] ?? e.name}</div>
                  <p style={{ fontSize: 12.5, lineHeight: 1.45, color: C.sec, margin: "4px 0 14px", minHeight: 36 }}>{DESC[e.name] ?? e.note}</p>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
                    <span style={monoNum({ fontSize: 30, fontWeight: 600, letterSpacing: "-0.04em", color: C.ink })}>{inr(rate)}</span>
                    <span style={{ fontSize: 12, color: C.sec }}>/user/mo + GST</span>
                  </div>
                  <div style={{ fontSize: 12, color: C.sec, marginTop: 4 }}>≈ {inr(perDayOf(rate))} per user a day, GST included</div>
                  <div style={{ fontSize: 12.5, color: C.ink2, marginTop: 8, padding: "7px 10px", background: pop ? "#fff" : C.sectT, borderRadius: 8 }}>
                    <b style={{ fontWeight: 600 }}>{total}</b> for {seats} user{seats > 1 ? "s" : ""} + GST
                  </div>
                  <a href={buyHref} {...(payHref || onlinePay ? {} : { target: "_blank", rel: "noopener" })} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 14, fontWeight: 600, padding: "11px 8px", borderRadius: 8, background: BTN_PRIMARY, color: "#fff", border: "none", marginTop: 14, boxShadow: SH_BTN, textDecoration: "none" }}>
                    {payHref || !onlinePay ? <><CartIcon /> Buy now</> : "Get a monthly quote"}
                  </a>
                  <p style={{ fontSize: 11, color: C.sec, textAlign: "center", margin: "6px 0 0" }}>
                    {payHref ? "Pay online · billed yearly · GST invoice in ₹" : onlinePay ? "Monthly (flexible) is quoted · online payment is yearly" : "Opens WhatsApp · we send the payment link · GST invoice in ₹"}
                  </p>
                  <div style={{ height: 1, background: C.hair, margin: "16px 0 12px" }} />
                  {lowerName && (
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.ink, marginBottom: 8 }}>Everything in {lowerName}, plus:</div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                    {(expanded[e.name] ? shown : shown.slice(0, 5)).map((f) => (
                      <span key={f} style={{ display: "flex", gap: 9, fontSize: 12.5, lineHeight: 1.4, color: C.ink2 }}>
                        <svg aria-hidden viewBox="0 0 24 24" width="15" height="15" fill="none" stroke={C.blue} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", marginTop: 1 }}><path d="M20 6 9 17l-5-5" /></svg>
                        <span>{f}</span>
                      </span>
                    ))}
                    {shown.length > 5 && (
                      <button onClick={() => setExpanded((x) => ({ ...x, [e.name]: !x[e.name] }))} aria-expanded={!!expanded[e.name]}
                        style={{ alignSelf: "flex-start", fontFamily: "inherit", fontSize: 12, fontWeight: 600, color: C.blue, background: "none", border: "none", padding: "2px 0", cursor: "pointer" }}>
                        {expanded[e.name] ? "Show fewer" : `See all ${shown.length}`}
                      </button>
                    )}
                  </div>
                  {/* secondary actions as links — one primary button per card */}
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: "auto", paddingTop: 16, fontSize: 12.5, fontWeight: 600 }}>
                    <Link href={`/trial?ed=${encodeURIComponent(e.name)}&seats=${seats}`} style={{ color: C.blue, textDecoration: "none" }}>Try free →</Link>
                    <Link href={quoteHref as never} style={{ color: C.blue, textDecoration: "none" }}>Get a written quote →</Link>
                  </div>
                </div>
              );
            })}
            {/* R-328 (7 Oct 2026): Business Plus has no published price — like Google's own page.
                Same card shape, "Contact us for pricing", quote + WhatsApp; never Buy now. */}
            {vendor.key === "gw" && (() => {
              const plusDelta = editionDelta(featuresFor(vendor, 1), featuresFor(vendor, 2));
              const quoteHref = `/quote?ed=${encodeURIComponent(PLUS_EDITION)}&seats=${seats}&term=${annual ? "annual" : "monthly"}`;
              return (
                <div style={{ position: "relative", display: "flex", flexDirection: "column", padding: 20, border: `1px solid ${C.border}`, borderRadius: 12, background: C.surf, boxShadow: SH_CARD }}>
                  <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em", color: C.ink }}>{LABEL[PLUS_EDITION]}</div>
                  <p style={{ fontSize: 12.5, lineHeight: 1.45, color: C.sec, margin: "4px 0 14px", minHeight: 36 }}>{DESC[PLUS_EDITION]}</p>
                  <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", color: C.ink, lineHeight: 1.2 }}>{CONTACT_FOR_PRICING}</div>
                  <div style={{ fontSize: 12, color: C.sec, marginTop: 4 }}>We send the price for {seats} user{seats > 1 ? "s" : ""} {SLA.quote}</div>
                  <Link href={quoteHref as never} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 14, fontWeight: 600, padding: "11px 8px", borderRadius: 8, background: BTN_PRIMARY, color: "#fff", border: "none", marginTop: 14, boxShadow: SH_BTN, textDecoration: "none" }}>
                    Get a quote
                  </Link>
                  <a href={WA(`Hi Anutech — please send the Google Workspace Business Plus price for ${seats} user${seats > 1 ? "s" : ""} (${annual ? "annual" : "monthly"}).`)} target="_blank" rel="noopener" style={{ fontSize: 12.5, fontWeight: 600, color: C.green, textAlign: "center", margin: "8px 0 0", textDecoration: "none" }}>
                    Ask on WhatsApp
                  </a>
                  <div style={{ height: 1, background: C.hair, margin: "16px 0 12px" }} />
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.ink, marginBottom: 8 }}>Everything in {LABEL["GW Business Standard"]}, plus:</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                    {plusDelta.slice(0, 5).map((f) => (
                      <span key={f} style={{ display: "flex", gap: 9, fontSize: 12.5, lineHeight: 1.4, color: C.ink2 }}>
                        <svg aria-hidden viewBox="0 0 24 24" width="15" height="15" fill="none" stroke={C.blue} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", marginTop: 1 }}><path d="M20 6 9 17l-5-5" /></svg>
                        <span>{f}</span>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      </section>

      {/* ── FEATURES: full feature list for the selected suite ─────────────── */}
      <section id="features" style={{ background: C.sectT, borderTop: `1px solid ${C.hair}`, scrollMarginTop: 80 }}>
        <div style={wrap({ padding: "34px 48px" })}>
          <button onClick={() => setFeaturesOpen((v) => !v)} aria-expanded={featuresOpen} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, fontFamily: "inherit" }}>
            <div style={eyebrow}>Feature comparison</div>
            <h2 style={{ fontSize: 27, fontWeight: 700, letterSpacing: "-0.035em", color: C.ink, margin: "8px 0 0" }}>{vendor.name} — every feature, edition by edition <span style={{ color: C.blue }}>{featuresOpen ? "▲" : "▼"}</span></h2>
            <p style={{ fontSize: 14, color: C.sec, margin: "6px 0 0" }}>The complete list — <span style={{ color: C.green }}>✓ included</span>, a value where it differs, <span style={{ color: C.faint }}>— not in this edition</span>. GST 18% is billed separately.</p>
          </button>
          {featuresOpen && vendor.matrix && EDITION_MATRICES[vendor.matrix] && (() => {
            const m = EDITION_MATRICES[vendor.matrix];
            return (
              <>
                <div style={{ border: `1px solid ${C.borderL}`, borderRadius: 12, overflow: "hidden", marginTop: 16, background: C.surf }}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
                      <thead>
                        <tr style={{ background: C.tableHead }}>
                          <th style={{ textAlign: "left", padding: "13px 16px", width: 200, fontFamily: MONO, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: C.sec, borderBottom: `1px solid #DFE5EE` }}>Feature</th>
                          {m.cols.map((c, ci) => {
                            const ed = editionsFor(vendor)[ci];
                            return (
                              <th key={c} style={{ textAlign: "left", padding: "11px 16px", borderLeft: `1px solid #DFE5EE`, borderBottom: `1px solid #DFE5EE` }}>
                                <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{c}</div>
                                {ed && <div style={monoNum({ fontSize: 12, color: C.sec })}>{inr(rateOf(ed))}/user/mo</div>}
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {m.rows.filter((row) => !/price per seat/i.test(row[0])).map((row) => (
                          <tr key={row[0]} style={{ borderTop: `1px solid ${C.hair}` }}>
                            <td style={{ padding: "11px 16px", fontSize: 13, fontWeight: 600, color: C.ink, background: C.surfT }}>{row[0]}</td>
                            {row.slice(1).map((cell, j) => (
                              <td key={j} style={{ padding: "11px 16px", fontSize: 13, fontFamily: cell === "Yes" || cell === "—" ? "inherit" : MONO, color: cell === "—" ? C.faint : cell === "Yes" ? C.green : C.ink, fontWeight: cell === "Yes" ? 700 : 400, borderLeft: `1px solid ${C.hair}` }}>
                                {cell === "Yes" ? "✓" : cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {m.note && <p style={{ fontSize: 13, color: C.sec, padding: "12px 16px", margin: 0, borderTop: `1px solid ${C.hair}` }}><b style={{ color: C.ink, fontWeight: 600 }}>Good to know:</b> {m.note}</p>}
                </div>
                <p style={{ fontSize: 13, color: C.sec, marginTop: 12 }}>Switch the suite in the strip above to compare {vendor.key === "gw" ? "Microsoft 365 or Zoho" : "another suite"} instead. <button onClick={() => document.getElementById("products")?.scrollIntoView({ behavior: "smooth" })} style={{ background: "none", border: "none", cursor: "pointer", color: C.blue, fontWeight: 600, fontSize: 13, fontFamily: "inherit" }}>Back to plans →</button></p>
              </>
            );
          })()}
          {featuresOpen && !vendor.matrix && (
            <p style={{ fontSize: 14, color: C.body, marginTop: 12 }}>Zoho Workplace is a single Standard edition — mail plus Writer, Sheet and Show, 30 GB per user, on your own domain. Switch to Google Workspace or Microsoft 365 above for their edition-by-edition breakdown, or ask on WhatsApp.</p>
          )}
        </div>
      </section>

      {/* ── COMPARE: all three suites side by side ─────────────────────────── */}
      <section id="compare" style={wrap({ padding: "40px 48px", scrollMarginTop: 80 })}>
        <button onClick={() => setCompareOpen((v) => !v)} aria-expanded={compareOpen} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, fontFamily: "inherit" }}>
          <div style={eyebrow}>Compare editions</div>
          <h2 style={{ fontSize: 27, fontWeight: 700, letterSpacing: "-0.035em", color: C.ink, margin: "8px 0 0" }}>All three suites, side by side <span style={{ color: C.blue }}>{compareOpen ? "▲" : "▼"}</span></h2>
          <p style={{ fontSize: 14, color: C.sec, margin: "6px 0 0" }}>Real values, not adjectives. Markers: <span style={{ color: C.green }}>✓ included</span> · <span style={{ color: "#8A5A0B" }}>₹ costs extra</span> · <span style={{ color: C.faint }}>✕ not included</span>. Every rate is + 18% GST.</p>
        </button>
        {compareOpen && (() => {
          const entry = (p: string) => LIST.find((e) => e.name.startsWith(p))!;
          const bill = (p: string) => inr(Math.round((annual ? entry(p).annual : entry(p).monthly) * 1.18)) + "/user/mo";
          const buy = (name: string) => WA(`Hi Anutech — I'd like to buy ${name}. Please guide me.`);
          const head = [{ k: "gw", name: "Google Workspace", logo: "/logo-google-workspace-wordmark.png", h: 20 }, { k: "ms", name: "Microsoft 365", logo: "/logo-microsoft-365-trim.png", h: 22 }, { k: "zoho", name: "Zoho Workplace", logo: "/logo-zoho-trim.png", h: 22 }];
          const rows: { label: string; sub?: string; cells: string[] }[] = [
            { label: "Bill per user", sub: annual ? "annual commitment" : "flexible monthly", cells: [bill("GW "), bill("M365 "), bill("Zoho")] },
            ...CROSS_ROWS.map((r) => ({ label: r.label, cells: [r.gw, r.ms, r.zoho] })),
          ];
          return (
            <div style={{ border: `1px solid ${C.borderL}`, borderRadius: 12, overflow: "hidden", marginTop: 16 }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
                  <thead>
                    <tr style={{ background: C.tableHead }}>
                      <th style={{ textAlign: "left", padding: "13px 16px", width: 190, fontFamily: MONO, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: C.sec, borderBottom: `1px solid #DFE5EE` }}>What we&apos;re comparing</th>
                      {head.map((v) => (
                        <th key={v.k} style={{ textAlign: "left", padding: "13px 16px", borderLeft: `1px solid #DFE5EE`, borderBottom: `1px solid #DFE5EE` }}>
                          <img src={v.logo} alt={v.name} style={{ height: v.h, width: "auto", objectFit: "contain" }} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.label} style={{ borderTop: `1px solid ${C.hair}` }}>
                        <td style={{ padding: "12px 16px", fontSize: 13.5, fontWeight: 600, color: C.ink, background: C.surfT }}>
                          {r.label}{r.sub && <span style={{ display: "block", fontSize: 11.5, fontWeight: 400, color: C.sec, marginTop: 2 }}>{r.sub}</span>}
                        </td>
                        {r.cells.map((cell, j) => <MarkerCell key={j} text={cell} />)}
                      </tr>
                    ))}
                    <tr style={{ borderTop: `1px solid ${C.hair}`, background: C.surfT }}>
                      <td style={{ padding: "14px 16px", fontSize: 13.5, fontWeight: 600, color: C.ink }}>Made your choice?</td>
                      {head.map((v) => (
                        <td key={v.k} style={{ padding: "12px 16px", borderLeft: `1px solid ${C.hair}` }}>
                          <a href={buy(v.name)} target="_blank" rel="noopener" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12.5, fontWeight: 600, padding: "9px 12px", borderRadius: 8, background: BTN_PRIMARY, color: "#fff", boxShadow: SH_BTN, textDecoration: "none", whiteSpace: "nowrap" }}><CartIcon /> Buy {v.name.split(" ")[0]}</a>
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: 13, color: C.sec, padding: "12px 16px", margin: 0, borderTop: `1px solid ${C.hair}` }}>
                Still unsure? <a href={WA("Hi Anutech — here's our current bill / requirement, which suite works out cheaper?")} target="_blank" rel="noopener" style={{ color: C.green, fontWeight: 600 }}>Send it on WhatsApp</a> — we&apos;ll compare and tell you in writing which works out cheaper.
              </p>
            </div>
          );
        })()}
      </section>

      {/* ── MIGRATION: four steps + the real inbox image ───────────────────── */}
      <section style={{ background: C.surf, borderTop: `1px solid ${C.hair}` }}>
        <div style={wrap({ padding: mob ? "44px 48px" : "56px 48px", display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr", gap: mob ? 32 : 52, alignItems: "center" })}>
          <div>
            <div style={{ ...eyebrow, marginBottom: 10 }}>Moving your old mail</div>
            <h2 style={{ fontSize: mob ? 27 : 31, fontWeight: 700, letterSpacing: "-0.03em", color: C.ink, margin: "0 0 10px", textWrap: "balance" as const }}>Four steps. We do three, you do one.</h2>
            <p style={{ fontSize: 17, lineHeight: 1.55, color: C.body, margin: "0 0 20px" }}>Old mail, folders, contacts and calendar all move to the new system — any number of mailboxes, from any previous provider, for ₹0. The work happens at night so your day isn&apos;t interrupted.</p>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {MIG_STEPS.map((s) => (
                <div key={s.n} style={{ display: "flex", gap: 16, padding: "14px 0", borderTop: `1px solid ${C.hair}` }}>
                  <span style={monoNum({ fontSize: 13, color: C.blue, fontWeight: 500, paddingTop: 2, flex: "none", width: 26 })}>{s.n}</span>
                  <span style={{ flex: 1 }}>
                    <span style={{ display: "block", fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em", color: C.ink, marginBottom: 3 }}>{s.title}</span>
                    <span style={{ display: "block", fontSize: 14, color: C.body, lineHeight: 1.5 }}>{s.body}</span>
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: C.sec, flex: "none", paddingTop: 3 }}>{s.who}</span>
                </div>
              ))}
            </div>
          </div>
          <figure style={{ margin: 0 }}>
            <img src="/googleworkspace-inbox.png" alt="A Google Workspace inbox: Gmail with the company's own labels, plus Chat, Meet and Spaces in the side rail" width={1024} height={640} style={{ width: "100%", height: "auto", border: `1px solid ${C.borderL}`, borderRadius: 10, boxShadow: "0 16px 40px -26px rgba(12,17,22,.3)", display: "block" }} />
            <figcaption style={{ marginTop: 14, fontSize: 13, color: C.sec, display: "flex", flexWrap: "wrap", gap: "4px 10px", alignItems: "baseline" }}>
              <span>This is what the team sees in the morning —</span>
              <span style={{ fontFamily: MONO, color: C.ink }}>you@yourcompany.in</span>
              <span>· the same folders, the same old mail.</span>
            </figcaption>
          </figure>
        </div>
      </section>

      {/* ── ANUTECH MAIL — the simple mailbox (email page only) ───────────── */}
      {onEmail && (() => {
        const am = MAIL_OPTIONS.find((m) => m.name === "Anutech Mail");
        if (!am) return null;
        return (
          <section id="anutech-mail" style={{ background: C.sectT, borderTop: `1px solid ${C.hair}` }}>
            <div style={wrap({ padding: "40px 48px", display: "grid", gridTemplateColumns: mob ? "1fr" : "1.2fr 1fr", gap: mob ? 18 : 40, alignItems: "center" })}>
              <div>
                <div style={{ ...eyebrow, marginBottom: 10 }}>Only need mail?</div>
                <h2 style={{ fontSize: mob ? 25 : 28, fontWeight: 700, letterSpacing: "-0.03em", color: C.ink, margin: "0 0 8px", textWrap: "balance" as const }}>Anutech Mail — a plain mailbox on your domain</h2>
                <p style={{ fontSize: 15, lineHeight: 1.55, color: C.body, margin: 0, maxWidth: 560 }}>No Docs or Meet, just reliable email hosted in India. Right for teams that live in Outlook or their phone and need nothing else.</p>
              </div>
              <div style={{ background: C.surf, border: `1px solid ${C.borderL}`, borderRadius: 12, padding: "18px 20px", boxShadow: SH_CARD }}>
                <span style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
                  <span style={monoNum({ fontSize: 26, fontWeight: 500, letterSpacing: "-0.03em", color: C.ink })}>{inr(MAIL_RATES["Anutech Mail"] ?? 79)}</span>
                  <span style={{ fontSize: 12, color: C.sec }}>/mailbox/mo + GST</span>
                </span>
                <ul style={{ listStyle: "none", margin: "10px 0 14px", padding: 0, display: "grid", gap: 5 }}>
                  {am.lines.map((l) => <li key={l} style={{ fontSize: 13.5, color: C.ink2 }}><span style={{ color: C.green, fontWeight: 700 }}>✓</span> {l}</li>)}
                </ul>
                <Link href="/quote" style={{ display: "inline-block", background: BTN_PRIMARY, color: "#fff", borderRadius: 8, padding: "10px 18px", fontSize: 14, fontWeight: 600, textDecoration: "none", boxShadow: SH_BTN }}>Get a mailbox quote →</Link>
              </div>
            </div>
          </section>
        );
      })()}

      {/* ── CATALOGUE — the rest of what we sell (old home only) ──────────── */}
      {!onEmail && (
      <section id="catalogue" style={{ background: C.sectT, borderTop: `1px solid ${C.hair}`, scrollMarginTop: 80 }}>
        <div style={wrap({ padding: "44px 48px 48px" })}>
          <div style={eyebrow}>The rest of the catalogue</div>
          <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em", color: C.ink, margin: "8px 0 6px", textWrap: "balance" as const }}>Domains, hosting, SSL — same published-price rule</h2>
          <p style={{ fontSize: 15, color: C.body, margin: "0 0 22px" }}>Every rate on the card, GST 18% billed separately, renewal price shown up front.</p>
          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4,1fr)", gap: 16 }}>
            {CATALOGUE_V2.map((c) => (
              <Link key={c.name} href={c.href as never} style={{ display: "flex", flexDirection: "column", background: C.surf, border: `1px solid ${C.borderL}`, borderRadius: 11, padding: "16px 17px 14px", boxShadow: SH_CARD, textDecoration: "none", color: "inherit" }}>
                {/* 16:9 icon band */}
                <span style={{ display: "flex", alignItems: "center", justifyContent: "center", position: "relative", aspectRatio: "16/9", margin: "-16px -17px 12px", overflow: "hidden", background: "linear-gradient(135deg, #F2F6FB, #E8ECF1)", borderBottom: `1px solid ${C.hair}`, borderRadius: "11px 11px 0 0" }}>
                  {c.img
                    ? <img src={c.img} alt="" loading="lazy" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                    : <CatScene kind={c.icon} />}
                </span>
                <span style={{ fontSize: 14.5, fontWeight: 700, letterSpacing: "-0.01em", color: C.ink, minHeight: 19 }}>{c.name}</span>
                <span style={{ display: "flex", alignItems: "baseline", gap: 5, marginTop: 9 }}>
                  <span style={monoNum({ fontSize: 22, fontWeight: 500, letterSpacing: "-0.02em", color: C.ink })}>{c.from}</span>
                  <span style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: C.sec }}>{c.unit}</span>
                </span>
                <span style={{ fontSize: 11.5, color: c.gst === "No charge" ? C.green : C.sec, marginTop: 2, fontWeight: c.gst === "No charge" ? 600 : 400 }}>{c.gst}</span>
                <span style={{ fontSize: 12.5, lineHeight: 1.45, color: C.sec, marginTop: 10, minHeight: 54 }}>{c.body}</span>
                <span style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 2, minHeight: 44, alignContent: "flex-start" }}>
                  {c.tags.map((t) => (
                    <span key={t} style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 500, letterSpacing: "0.09em", textTransform: "uppercase", color: C.body, background: "#F2F6FB", border: "1px solid #E4EAF2", padding: "3px 7px", borderRadius: 999, whiteSpace: "nowrap" }}>{t}</span>
                  ))}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: "auto", paddingTop: 12, borderTop: `1px solid ${C.hair}`, fontSize: 12.5, fontWeight: 600, color: C.blue }}>{c.cta} <span aria-hidden>→</span></span>
              </Link>
            ))}
          </div>
        </div>
      </section>
      )}

      {/* ── TRUST ──────────────────────────────────────────────────────────── */}
      <section style={{ background: C.sectT, borderTop: `1px solid ${C.borderL}` }}>
        <div style={wrap({ padding: "44px 48px" })}>
          {/* 2 Oct 2026: the three "Google review" cards below this were sample text (the names
              are the app's test fixtures), not reviews anyone wrote — removed until real ones,
              linked to their source, replace them. */}
          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4,1fr)", gap: 16 }}>
            {TRUST.map((f) => (
              <div key={f.label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em", color: ("primary" in f && f.primary) ? C.blue : C.ink }}>{f.value}</div>
                <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: C.sec, marginTop: 4 }}>{f.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ────────────────────────────────────────────────────────────── */}
      <section id="faq" style={wrap({ padding: "44px 48px", maxWidth: 820 })}>
        <div style={{ ...eyebrow, textAlign: "center" }}>Questions</div>
        <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em", color: C.ink, margin: "8px 0 18px", textAlign: "center", textWrap: "balance" as const }}>The five things buyers ask us first</h2>
        {HOME_FAQS.map((f, i) => {
          const open = openFaq === i;
          return (
            <div key={f.q} style={{ borderTop: `1px solid ${C.borderL}` }}>
              <button onClick={() => setOpenFaq(open ? -1 : i)} aria-expanded={open} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, background: "none", border: "none", cursor: "pointer", padding: "18px 0", textAlign: "left", fontFamily: "inherit" }}>
                <span style={{ fontSize: 16.5, fontWeight: 600, color: open ? C.blue : C.ink }}>{f.q}</span>
                <span style={{ fontFamily: MONO, fontSize: 19, color: C.blue }}>{open ? "−" : "+"}</span>
              </button>
              {open && <p style={{ fontSize: 15, lineHeight: 1.6, color: C.body, padding: "0 0 20px", margin: 0 }}>{f.a}</p>}
            </div>
          );
        })}
      </section>

      {/* ── RESELLEROS (old home only — the new home has its own) ─────────── */}
      {!onEmail && (
      <section style={{ background: "#FFF6F0", borderTop: "1px solid #F5D9C6" }}>
        <div style={wrap({ padding: "40px 48px" })}>
          <div style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: "#C2410C", marginBottom: 10 }}>For resellers</div>
          <h2 style={{ fontSize: 27, fontWeight: 700, letterSpacing: "-0.03em", color: C.ink, margin: "0 0 8px" }}>Resell this for a living? Run it on ResellerOS.</h2>
          <p style={{ fontSize: 15, lineHeight: 1.55, color: C.body, margin: "0 0 16px", maxWidth: 640 }}>Our own software: subscriptions and seats, GST quotes and invoices, renewals on autopilot, bank reconciliation — free during beta.</p>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <Link href="/reselleros" style={{ background: "#C2410C", color: "#fff", borderRadius: 8, padding: "12px 20px", fontSize: 14, fontWeight: 600, textDecoration: "none" }}>Explore ResellerOS →</Link>
            <Link href="/login" style={{ fontWeight: 600, color: "#C2410C" }}>Already a member? Log in</Link>
          </div>
        </div>
      </section>
      )}
    </div>
  );
}

/** A designed graphic band for catalogue cards with no photo — richer than a
 *  lone icon, in the same flat-illustration spirit as the domains image. */
export function CatScene({ kind }: { kind: string }) {
  const blue = "#1668E3", soft = "#B9D0F5", fill = "#DCE8FB";
  if (kind === "lock") {
    return (
      <svg aria-hidden viewBox="0 0 120 68" width="58%" style={{ maxWidth: 190 }} fill="none">
        <circle cx="20" cy="18" r="3" fill={soft} /><circle cx="100" cy="22" r="3" fill={soft} />
        <circle cx="24" cy="50" r="2.5" fill={soft} /><circle cx="98" cy="48" r="2.5" fill={soft} />
        <path d="M60 8 84 16v18c0 14-10 22-24 28-14-6-24-14-24-28V16Z" fill={fill} stroke={blue} strokeWidth="2.4" strokeLinejoin="round" />
        <path d="M50 34l7 7 15-16" stroke={blue} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "tag") {
    return (
      <svg aria-hidden viewBox="0 0 120 68" width="60%" style={{ maxWidth: 190 }} fill="none">
        <rect x="16" y="18" width="44" height="7" rx="3.5" fill={soft} />
        <rect x="16" y="31" width="36" height="7" rx="3.5" fill={fill} />
        <rect x="16" y="44" width="28" height="7" rx="3.5" fill={fill} />
        <g stroke={blue} strokeWidth="2.4" strokeLinejoin="round">
          <path d="M104 34 82 56 68 42 90 20h14v14Z" fill={fill} />
          <circle cx="95" cy="29" r="3.2" fill="#fff" />
        </g>
      </svg>
    );
  }
  return <svg aria-hidden viewBox="0 0 24 24" width="42" height="42" fill="none" stroke={blue} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.85 }}><path d={CAT_ICON[kind]} /></svg>;
}

/** A comparison cell that colours a leading ✓ / ✕ / ₹ marker. */
function MarkerCell({ text }: { text: string }) {
  const m = text.match(/^([✓✕₹])\s*(.*)$/);
  const color = m ? (m[1] === "✓" ? C.green : m[1] === "₹" ? "#8A5A0B" : C.faint) : C.ink2;
  return (
    <td style={{ padding: "12px 16px", fontSize: 13, lineHeight: 1.4, color: C.ink2, borderLeft: `1px solid ${C.hair}`, verticalAlign: "top" }}>
      {m ? (<><span style={{ color, fontWeight: 700 }}>{m[1]}</span> {m[2]}</>) : text}
    </td>
  );
}

function CartIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
      <circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" /><path d="M2 3h2.2l2.6 12.2h12.1L21.5 7H6" />
    </svg>
  );
}
