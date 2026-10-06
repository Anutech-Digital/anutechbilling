"use client";

/**
 * DomainLanding — the /domains conversion redesign ("Domain hosting improvement
 * strategy" handoff, 3 Sep 2026). A purchase path built around one lever:
 *
 *   > The domain is ₹0 when it points at our hosting (yearly plan).
 *
 * It is the commercial sibling of HostingLanding — same editorial language
 * (Instrument Serif display, JetBrains Mono for every number/eyebrow, the amber
 * accent), same self-contained inline styling, and it renders under (marketing)
 * so the shared site chrome (the home menu, utility bar, footer, cart drawer)
 * wraps it exactly as on every other page. So this component renders only its
 * own body (hero → closing CTA).
 *
 * REAL DATA, REAL CART (Pardeep's standing rule):
 *   · Availability + price is the live registry lookup (searchDomains → the same
 *     answer the logged-in app shows). No faked "taken" hashing.
 *   · TLD rate-card prices come from TLDS (catalog.ts).
 *   · Hosting prices come from HOSTING_TIERS — the SAME source the cart's
 *     server-side checkout re-prices against (sku `hosting:<tier>`), so the ₹0
 *     the page shows is the ₹0 the server charges. The domain line carries
 *     sku `domain:<tld>`; the server zeroes it only when a yearly hosting line
 *     is in the same order — the bundle rule is enforced there, never trusted
 *     from the client.
 *
 * Two honesty rules from the handoff are kept deliberately: the renewal price is
 * printed next to every first-year price, and the "Don't add hosting if…" block
 * plus two FAQ answers tell the visitor NOT to buy. Those are what make a
 * default-on hosting selection legitimate.
 */
import { useEffect, useMemo, useState } from "react";
import { domainSans as manrope, domainSerif as serif, domainMono as mono } from "@/lib/fonts";
import { useCart } from "@/site/components/cart/CartProvider";
import { searchDomains, normaliseName, type DomainResult } from "@/site/lib/domain-search";
import { TLDS, type Tld } from "@/site/lib/data/catalog";
import { HOSTING_TIERS } from "@/site/lib/data/hosting-landing-v2";
import {
  MAILBOX_YR,
  ANCHOR_TIER,
  ANCHOR_TLD,
  DOMAIN_NEEDS,
  DONT_ADD_HOSTING,
  DOMAIN_INCLUDED,
  DOMAIN_FAQS,
} from "@/site/lib/data/domains-landing";


const C = {
  ink: "#17120F", ink2: "#4A403A", muted: "#7A6C62", faint: "#9A8B80", onDark: "#C9BAB0",
  paper: "#FDFBF8", tint: "#FBF8F5", card: "#fff", line: "#E8DFD7", lineSoft: "#F3ECE5",
  accent: "#C2410C", accentDark: "#7C2D12", accentLight: "#FB923C", accSurf: "#FFF1E7",
  accSurf2: "#FFF9F4", accBorder: "#FBD3B8", success: "#15803D", successSurf: "#F0FDF4",
  successBorder: "#BBF7D0", dot: "#4ADE80", warn: "#F5A66B", darkCard: "#1E1712", darkBorder: "#33261E",
};
const MONO = "var(--df-mono), 'JetBrains Mono', monospace";
const SERIF = "var(--df-serif), 'Instrument Serif', serif";

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
type Term = "yearly" | "monthly";
type Tab = "register" | "transfer" | "bulk";

/** The TLD table indexed for O(1) reg/renew lookups + fallback pricing. */
const TLD_BY_EXT: Record<string, Tld> = Object.fromEntries(TLDS.map((t) => [t.tld, t]));
const anchorTld = TLD_BY_EXT[ANCHOR_TLD] ?? TLDS[0];

const RATE_FILTERS: { key: string; label: string; groups: Tld["group"][] }[] = [
  { key: "popular", label: "Popular", groups: ["Popular"] },
  { key: "business", label: "Business", groups: ["Business"] },
  { key: "tech", label: "Tech & startup", groups: ["Tech"] },
  { key: "all", label: `All ${TLDS.length}`, groups: ["Popular", "Business", "Tech"] },
];

export function DomainLanding() {
  // ── search ──────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<Tab>("register");
  const [q, setQ] = useState("");
  const [tld, setTld] = useState(ANCHOR_TLD);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [results, setResults] = useState<DomainResult[]>([]);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  // ── offer selection ─────────────────────────────────────────────────────
  const [hostingOn, setHostingOn] = useState(true);
  const [planName, setPlanName] = useState(ANCHOR_TIER);
  const [term, setTerm] = useState<Term>("yearly");
  const [mailOn, setMailOn] = useState(true);
  // ── page ────────────────────────────────────────────────────────────────
  const [filter, setFilter] = useState("popular");
  const [openFaq, setOpenFaq] = useState(0);
  const [transferText, setTransferText] = useState("");
  const [fieldFocus, setFieldFocus] = useState(false); // soft focus ring on the whole search field
  const [w, setW] = useState(1200);
  const cart = useCart();

  useEffect(() => {
    const measure = () => {
      const width = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
      if (width) setW(width);
    };
    window.addEventListener("resize", measure);
    measure();
    return () => window.removeEventListener("resize", measure);
  }, []);
  const mob = w < 760, mid = w < 1010;

  async function runSearch(seed?: string) {
    const base = normaliseName(seed ?? q);
    if (!base) { setSearchErr("Type a name to check."); return; }
    if (seed) setQ(seed);
    setLoading(true); setSearchErr(null); setSearched(true);
    const out = await searchDomains(base);
    setLoading(false);
    if (!out.ok) { setSearchErr(out.message); setResults([]); return; }
    setResults(out.domains);
    // If the picked TLD isn't among the checked set, fall back to the first hit.
    if (!out.domains.some((d) => d.domain.endsWith(tld))) {
      const firstAvail = out.domains.find((d) => d.available) ?? out.domains[0];
      if (firstAvail) {
        const ext = TLDS.find((t) => firstAvail.domain.endsWith(t.tld))?.tld;
        if (ext) setTld(ext);
      }
    }
  }

  // The headline result = the domain matching the selected TLD.
  const primary = useMemo(
    () => results.find((d) => d.domain.endsWith(tld)) ?? results[0],
    [results, tld],
  );
  const alternates = useMemo(
    () => results.filter((d) => d !== primary),
    [results, primary],
  );

  const tier = HOSTING_TIERS.find((t) => t.name === planName) ?? HOSTING_TIERS[0];
  const anchorTier = HOSTING_TIERS.find((t) => t.name === ANCHOR_TIER) ?? HOSTING_TIERS[0];
  const tldRow = TLD_BY_EXT[tld] ?? anchorTld;
  // Real domain price: the live registry price when known, else the rate-card reg.
  const domainReg = primary?.priceKnown ? primary.price : tldRow.reg;
  const domainRenew = tldRow.renew;

  // ── single source of truth for every displayed number ─────────────────────
  const yearly = term === "yearly";
  const bundleFree = hostingOn && yearly; // the only state where the domain is ₹0
  const domainCost = bundleFree ? 0 : domainReg;
  // Whole rupees, as the checkout API charges it (Math.round of the same tier figure).
  const hostingCost = hostingOn ? Math.round(yearly ? tier.yearlyTotal : tier.monthly) : 0;
  const mailboxCost = mailOn ? (bundleFree ? 0 : MAILBOX_YR) : 0;
  const subtotal = domainCost + hostingCost + mailboxCost;
  const total = Math.round(subtotal * 1.18);
  const saved = (bundleFree ? domainReg : 0) + (bundleFree && mailOn ? MAILBOX_YR : 0);
  const available = primary?.available ?? false;

  function addToCart() {
    /* Only a name that is available at a live, known price can be paid for: the
       checkout re-checks both and refuses otherwise, so adding it would only fail later. */
    if (!primary || !primary.available || !primary.priceKnown) return;
    const planId = tier.name.toLowerCase();
    // Domain line — sku lets the server re-price + apply the ₹0 bundle rule.
    cart.add({
      label: primary.domain,
      detail: bundleFree
        ? `Registration, 1 year · free with yearly hosting · renews ${inr(domainRenew)}`
        : `Registration, 1 year · renews ${inr(domainRenew)}`,
      unitPrice: domainCost,
      unit: "year",
      cycle: "yearly",
      sku: `domain:${tld.replace(/^\./, "")}`,
      domain: primary.domain,
      years: 1,
      yearPrices: primary.prices, // R-156: 2/3/5-year terms, when the registry prices them
      bundleFree,
    });
    if (hostingOn) {
      cart.add({
        label: `${tier.name} hosting`,
        detail: yearly
          ? `Billed yearly · renews at the same price · pointed at ${primary.domain}`
          : `Billed monthly · pointed at ${primary.domain}`,
        unitPrice: hostingCost,
        unit: yearly ? "year" : "month",
        cycle: yearly ? "yearly" : "monthly",
        sku: `hosting:${planId}`,
      });
      if (mailOn) {
        cart.add({
          label: `Mailbox on ${primary.domain}`,
          detail: bundleFree ? "Free with the yearly plan" : "Anutech Mail · billed yearly",
          unitPrice: mailboxCost,
          unit: "year",
          cycle: "yearly",
          sku: `mailbox:anutech`,
        });
      }
    }
  }

  /* Rate-card row: pick the extension and search for it. It used to add a
     placeholder "yourname.<tld>" to the cart — a name nobody asked for, at a fixed
     price, which the checkout could neither price live nor register. */
  function addRateRow(t: Tld) {
    setTld(t.tld);
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (normaliseName(q)) void runSearch();
  }

  const shownTlds = TLDS.filter((t) => (RATE_FILTERS.find((f) => f.key === filter)?.groups ?? []).includes(t.group));

  // ── shared style atoms ────────────────────────────────────────────────────
  const wrap = (extra?: React.CSSProperties): React.CSSProperties => ({ maxWidth: 1160, margin: "0 auto", padding: mob ? "0 20px" : "0 28px", ...extra });
  const eyebrow: React.CSSProperties = { fontFamily: MONO, fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase", color: C.accent, fontWeight: 600 };
  const h2: React.CSSProperties = { fontFamily: SERIF, fontWeight: 400, fontSize: mob ? 30 : 40, lineHeight: 1.08, letterSpacing: "-0.01em", color: C.ink, margin: "10px 0 0", textWrap: "balance" as const };
  const cardBox: React.CSSProperties = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14 };
  const priceMono = (extra?: React.CSSProperties): React.CSSProperties => ({ fontFamily: MONO, fontVariantNumeric: "tabular-nums", ...extra });

  return (
    <div className={`${manrope.variable} ${serif.variable} ${mono.variable}`} style={{ fontFamily: "var(--df-sans), 'Manrope', system-ui, sans-serif", color: C.ink2, background: C.paper, paddingBottom: 96 }}>
      {/* ── 2 · SEARCH MODULE (the most important block) ───────────────────── */}
      <section id="search" style={wrap({ paddingTop: mob ? 18 : 22 })}>
        <div style={{ ...cardBox, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 2px rgba(26,22,20,0.04), 0 12px 32px -18px rgba(26,22,20,0.16)" }}>
          {/* tab strip */}
          <div role="tablist" aria-label="Domain actions" style={{ display: "flex", gap: 4, padding: "8px 8px 0", background: C.tint, borderBottom: `1px solid ${C.line}` }}>
            {([["register", "Register a name"], ["transfer", "Transfer in"], ["bulk", "Bulk / portfolio"]] as [Tab, string][]).map(([k, label]) => {
              const on = tab === k;
              return (
                <button key={k} role="tab" aria-selected={on} onClick={() => setTab(k)}
                  style={{ appearance: "none", cursor: "pointer", background: on ? C.card : "transparent", border: on ? `1px solid ${C.line}` : "1px solid transparent", borderBottomColor: on ? C.card : "transparent", marginBottom: -1, borderRadius: "9px 9px 0 0", padding: "11px 18px", fontSize: 14.5, fontWeight: on ? 600 : 500, color: on ? C.ink : C.muted, fontFamily: "inherit" }}>
                  {label}
                </button>
              );
            })}
          </div>

          {/* ── REGISTER ── */}
          {tab === "register" && (
            <div style={{ padding: mob ? "20px 18px 24px" : "26px 28px 28px" }}>
              <form onSubmit={(e) => { e.preventDefault(); void runSearch(); }} style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {/* The field owns the focus indicator — a single soft accent ring on the
                    whole wrapper (input + TLD) via focus-within state. The app's global
                    amber double-ring (globals.css :focus-visible) is suppressed on the
                    controls themselves (boxShadow:none) so it doesn't stack a hard ring
                    inside this soft one. */}
                <div style={{ flex: 1, minWidth: 260, display: "flex", alignItems: "center", border: `1.5px solid ${fieldFocus ? C.accent : C.line}`, borderRadius: 10, background: C.paper, padding: "0 4px 0 16px", boxShadow: fieldFocus ? "0 0 0 3px rgba(194,65,12,0.14)" : "none", transition: "border-color .15s, box-shadow .15s" }}>
                  <input value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setFieldFocus(true)} onBlur={() => setFieldFocus(false)} placeholder="your business name" aria-label="Domain name to search"
                    style={{ flex: 1, border: "none", outline: "none", boxShadow: "none", background: "transparent", padding: "16px 0", fontSize: 19, letterSpacing: "-0.01em", fontFamily: "inherit", color: C.ink, minWidth: 0 }} />
                  <select value={tld} onChange={(e) => setTld(e.target.value)} onFocus={() => setFieldFocus(true)} onBlur={() => setFieldFocus(false)} aria-label="Extension"
                    style={{ border: "none", outline: "none", boxShadow: "none", background: "transparent", fontFamily: MONO, fontSize: 17, color: C.accent, padding: "14px 8px", cursor: "pointer" }}>
                    {TLDS.map((t) => <option key={t.tld} value={t.tld}>{t.tld}</option>)}
                  </select>
                </div>
                <button type="submit" style={{ appearance: "none", cursor: "pointer", background: C.accent, color: "#fff", border: "none", borderRadius: 10, padding: "0 32px", fontSize: 16, fontWeight: 600, fontFamily: "inherit" }}>
                  Check availability
                </button>
              </form>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", marginTop: 14, fontSize: 13.5, color: C.muted }}>
                <span>Try:{" "}
                  <button onClick={() => void runSearch("kalpanaexports")} style={{ appearance: "none", cursor: "pointer", background: C.lineSoft, border: `1px solid ${C.line}`, borderRadius: 20, padding: "5px 13px", fontSize: 13.5, color: C.ink2, fontFamily: "inherit" }}>kalpanaexports</button>
                </span>
                <span>Live registry lookup · renewal price included in every result</span>
              </div>

              {/* result */}
              {loading && (
                <div style={{ marginTop: 24 }}>
                  {[1, 2, 3].map((i) => <div key={i} style={{ height: 46, borderBottom: `1px solid ${C.lineSoft}`, display: "flex", alignItems: "center" }}><div style={{ height: 12, width: `${40 + i * 12}%`, background: C.lineSoft, borderRadius: 4 }} /></div>)}
                  <p style={{ fontSize: 13.5, color: C.muted, marginTop: 12 }}>Checking the registry…</p>
                </div>
              )}
              {!loading && searchErr && <p style={{ marginTop: 22, fontSize: 14, color: C.accentDark }}>{searchErr}</p>}
              {!loading && searched && !searchErr && primary && (
                <ResultBlock
                  C={C} MONO={MONO} SERIF={SERIF} mob={mob} priceMono={priceMono}
                  primary={primary} available={available} tld={tld}
                  domainReg={domainReg} domainRenew={domainRenew}
                  hostingOn={hostingOn} setHostingOn={setHostingOn}
                  planName={planName} setPlanName={setPlanName}
                  term={term} setTerm={setTerm} mailOn={mailOn} setMailOn={setMailOn}
                  tier={tier} domainCost={domainCost} mailboxCost={mailboxCost}
                  bundleFree={bundleFree} total={total} saved={saved}
                  onAdd={addToCart}
                  alternates={alternates} onAddAlt={(d) => { const ext = TLDS.find((t) => d.domain.endsWith(t.tld))?.tld; if (ext) setTld(ext); }}
                />
              )}
            </div>
          )}

          {/* ── TRANSFER ── */}
          {tab === "transfer" && (
            <div style={{ padding: mob ? "22px 18px 26px" : "26px 28px 30px", display: "grid", gridTemplateColumns: mid ? "1fr" : "1fr 1fr", gap: mid ? 28 : 40 }}>
              <div>
                <h3 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 30, color: C.ink, margin: 0 }}>Move a name in. Three things, ten minutes.</h3>
                <p style={{ fontSize: 15, color: C.ink2, lineHeight: 1.6, marginTop: 12 }}>We copy your DNS records first so nothing breaks, then start the transfer. A transfer adds a full year to the registration.</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 18 }}>
                  {["Unlock the domain at your current registrar and get the auth / EPP code.", "Paste the name and code on the right — we copy the DNS across first.", "Approve the registry email. .in is quick; other TLDs take 5–7 days."].map((t, i) => (
                    <div key={t} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 12, alignItems: "start" }}>
                      <span style={{ fontFamily: MONO, fontSize: 12, color: C.accent, border: `1px solid ${C.accBorder}`, borderRadius: 6, padding: "3px 7px" }}>{i + 1}</span>
                      <span style={{ fontSize: 14.5, color: C.ink2 }}>{t}</span>
                    </div>
                  ))}
                </div>
                <div style={{ borderLeft: `2px solid ${C.accent}`, paddingLeft: 14, marginTop: 20 }}>
                  <p style={{ fontSize: 13.5, color: C.ink2, margin: 0 }}><strong>Transferring because the renewal quote went up?</strong> Add hosting with the transfer and the transfer fee is waived — site migrated free while the old host stays live.</p>
                </div>
              </div>
              <div style={{ background: C.tint, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
                <label htmlFor="transfer-domains" style={{ ...eyebrow, color: C.muted, fontSize: 11, display: "block" }}>Domains to move — one per line</label>
                <textarea id="transfer-domains" value={transferText} onChange={(e) => setTransferText(e.target.value)}
                  placeholder={"yourname.in  AUTH-CODE\nanother.com  AUTH-CODE"}
                  style={{ width: "100%", height: 148, marginTop: 10, border: `1px solid ${C.line}`, borderRadius: 8, background: C.card, padding: 12, fontFamily: MONO, fontSize: 13.5, lineHeight: 1.6, resize: "vertical", color: C.ink, outline: "none" }} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, color: C.muted }}>
                    {transferText.trim() ? `${transferText.split("\n").filter((l) => l.trim()).length} domain(s) ready · +1 year each` : "Auth code goes after the name, separated by a space."}
                  </span>
                  <a href="/contact" style={{ background: C.accent, color: "#fff", borderRadius: 9, padding: "12px 22px", fontSize: 14.5, fontWeight: 600, textDecoration: "none" }}>Start transfer</a>
                </div>
                <p style={{ fontSize: 13, color: C.muted, marginTop: 12 }}>No auth codes handy? Send us the list and we&apos;ll pull them with your authorisation, free — portfolios included.</p>
              </div>
            </div>
          )}

          {/* ── BULK ── */}
          {tab === "bulk" && (
            <div style={{ padding: mob ? "22px 18px 26px" : "26px 28px 30px" }}>
              <h3 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 30, color: C.ink, margin: 0 }}>For resellers running a book of names.</h3>
              <p style={{ fontSize: 15, color: C.ink2, lineHeight: 1.6, maxWidth: "62ch", marginTop: 12 }}>Sweep availability across a whole list, price it on wholesale slabs, and host the portfolio too — one GST invoice, one dashboard.</p>
              <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "repeat(3, 1fr)", gap: 14, marginTop: 18 }}>
                {[
                  { t: "Bulk availability sweep", b: "Paste hundreds of names; get a live available/taken map back in one pass.", hot: false },
                  { t: "Wholesale slabs", b: "Reseller pricing that steps down with volume — shown before you commit.", hot: false },
                  { t: "Host the book too", b: "Point the whole portfolio at our hosting and every domain line becomes ₹0.", hot: true },
                ].map((t) => (
                  <div key={t.t} style={{ background: t.hot ? C.accSurf2 : C.tint, border: `1px solid ${t.hot ? C.accBorder : C.line}`, borderRadius: 11, padding: 17 }}>
                    <div style={{ fontSize: 15.5, fontWeight: 700, color: t.hot ? C.accent : C.ink }}>{t.t}</div>
                    <p style={{ fontSize: 13.5, color: t.hot ? C.accentDark : C.muted, lineHeight: 1.55, margin: "6px 0 0" }}>{t.b}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── 1 · HERO + ARITHMETIC ─────────────────────────────────────────── */}
      <section style={wrap({ paddingTop: mob ? 44 : 52, display: "grid", gridTemplateColumns: mid ? "1fr" : "1.15fr 0.85fr", gap: mid ? 36 : 56, alignItems: "start" })}>
        <div>
          <div style={eyebrow}>Why the domain can cost ₹0</div>
          <h1 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: mob ? 44 : 62, lineHeight: 1.02, letterSpacing: "-0.02em", color: C.ink, margin: "14px 0 0", textWrap: "balance" as const }}>
            A domain is a signpost.{" "}
            <span style={{ fontStyle: "italic", color: C.accent }}>Point it at something.</span>
          </h1>
          <p style={{ fontSize: mob ? 16.5 : 18, lineHeight: 1.6, color: C.ink2, maxWidth: "52ch", margin: "18px 0 0" }}>
            A {ANCHOR_TLD} on its own is {inr(anchorTld.reg)}. {ANCHOR_TIER} hosting is {inr(anchorTier.yearlyTotal)}.
            Together it&apos;s {inr(anchorTier.yearlyTotal)} — so hosting adds {inr(anchorTier.yearlyTotal - anchorTld.reg)}, not {inr(anchorTier.yearlyTotal)},
            and the domain line reads ₹0. Register just the name if that&apos;s all you need — it stays available and unpunished.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 22 }}>
            {["The renewal price is shown up front — no year-two surprise", `${15}-day hosting trial, no card asked for`, "We wire the DNS and migrate the site for you"].map((t) => (
              <div key={t} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 14 }}>
                <span style={{ color: C.success, fontWeight: 700 }}>✓</span>
                <span style={{ color: C.ink2 }}>{t}</span>
              </div>
            ))}
          </div>
        </div>
        {/* arithmetic card */}
        <div style={{ ...cardBox, padding: mob ? "20px 20px" : "22px 24px" }}>
          <div style={{ ...eyebrow, color: C.muted, fontSize: 11 }}>The arithmetic, before you start</div>
          <div style={{ marginTop: 12 }}>
            {[
              { l: `${ANCHOR_TLD} domain, on its own`, v: inr(anchorTld.reg), strike: false, bold: false },
              { l: `${ANCHOR_TIER} hosting, 1 year`, v: inr(anchorTier.yearlyTotal), strike: false, bold: false },
              { l: "Bought separately", v: inr(anchorTld.reg + anchorTier.yearlyTotal), strike: true, bold: false },
            ].map((r) => (
              <div key={r.l} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "11px 0", borderBottom: `1px dashed ${C.line}` }}>
                <span style={{ fontSize: 14.5, color: r.strike ? C.faint : C.ink2 }}>{r.l}</span>
                <span style={priceMono({ fontSize: 16, color: r.strike ? C.faint : C.ink, textDecoration: r.strike ? "line-through" : "none" })}>{r.v}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "13px 0 4px" }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>Bought together</span>
              <span style={priceMono({ fontSize: 22, fontWeight: 700, color: C.accent })}>{inr(anchorTier.yearlyTotal)}</span>
            </div>
          </div>
          <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, margin: "8px 0 0" }}>
            Hosting costs {inr(anchorTier.yearlyTotal - anchorTld.reg)} more, not {inr(anchorTier.yearlyTotal)} — so the domain line reads ₹0.
            The renewal, {inr(anchorTld.renew)} + {inr(anchorTier.yearlyTotal)}, is printed on the invoice.
          </p>
        </div>
      </section>

      {/* ── 3 · WHY HOSTING IS IN THE BOX ──────────────────────────────────── */}
      <section style={wrap({ paddingTop: mob ? 48 : 64, display: "grid", gridTemplateColumns: mid ? "1fr" : "1fr 1fr", gap: mid ? 28 : 52, alignItems: "start" })}>
        <div>
          <div style={eyebrow}>Why hosting is in the box</div>
          <h2 style={h2}>A registered domain does nothing on its own.</h2>
          <p style={{ fontSize: 16.5, color: C.ink2, lineHeight: 1.6, marginTop: 14 }}>Buy only the name and you own a signpost pointing at an empty lot — which is fine, if that is what you meant to buy.</p>
        </div>
        <div>
          {DOMAIN_NEEDS.map((r, i) => (
            <div key={r.n} style={{ display: "grid", gridTemplateColumns: "26px 1fr", gap: 12, padding: "14px 0", borderTop: `1px solid ${C.line}`, borderBottom: i === DOMAIN_NEEDS.length - 1 ? `1px solid ${C.line}` : "none" }}>
              <span style={{ fontFamily: MONO, fontSize: 12, color: i === 0 ? C.faint : C.accent }}>{r.n}</span>
              <div>
                <div style={{ fontSize: 15.5, fontWeight: 600, color: C.ink }}>{r.t}</div>
                <p style={{ fontSize: 14, color: C.muted, lineHeight: 1.55, margin: "4px 0 0" }}>{r.b}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── 4 · THE HONEST COUNTER-ARGUMENT ────────────────────────────────── */}
      <section style={wrap({ paddingTop: mob ? 48 : 60 })}>
        <div style={{ background: C.darkCard, color: "#EDE6DE", borderRadius: 18, padding: mob ? "26px 22px" : "34px 36px", display: "grid", gridTemplateColumns: mid ? "1fr" : "1fr 1fr", gap: mid ? 24 : 44 }}>
          <div>
            <div style={{ ...eyebrow, color: "#FFB388" }}>The honest counter-argument</div>
            <h3 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: mob ? 26 : 32, color: "#fff", margin: "10px 0 0" }}>Don&apos;t add hosting if any of these is you.</h3>
            <p style={{ fontSize: 15, color: "#B9AEA4", lineHeight: 1.6, marginTop: 12 }}>The box is on by default because most people searching a name also need somewhere for the site to live. When you don&apos;t, the name alone is the right buy — and we&apos;ll say so.</p>
          </div>
          <div>
            {DONT_ADD_HOSTING.map((r, i) => (
              <div key={r.lead} style={{ padding: "12px 0", borderTop: `1px solid ${C.darkBorder}`, borderBottom: i === DONT_ADD_HOSTING.length - 1 ? `1px solid ${C.darkBorder}` : "none", fontSize: 14.5, color: "#CFC5BB", lineHeight: 1.55 }}>
                <strong style={{ color: "#fff", fontWeight: 600 }}>{r.lead}</strong> {r.rest}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 5 · RATE CARD ──────────────────────────────────────────────────── */}
      <section id="rates" style={wrap({ paddingTop: mob ? 48 : 62, scrollMarginTop: 84 })}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 20, flexWrap: "wrap" }}>
          <div>
            <div style={eyebrow}>Rate card</div>
            <h2 style={h2}>The rate card, in the open.</h2>
          </div>
          <p style={{ fontSize: 14.5, color: C.muted, maxWidth: "38ch", margin: 0 }}>Register, renew and transfer on one row — and the price with a yearly hosting plan, which is always ₹0.</p>
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", margin: "18px 0 14px" }}>
          {RATE_FILTERS.map((f) => {
            const on = filter === f.key;
            return (
              <button key={f.key} aria-pressed={on} onClick={() => setFilter(f.key)}
                style={{ appearance: "none", cursor: "pointer", background: on ? C.ink : C.card, color: on ? "#fff" : C.ink2, border: `1px solid ${on ? C.ink : C.line}`, borderRadius: 20, padding: "7px 15px", fontSize: 13.5, fontWeight: 500, fontFamily: "inherit" }}>
                {f.label}
              </button>
            );
          })}
        </div>
        <div style={{ ...cardBox, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
              <thead>
                <tr style={{ background: C.tint, borderBottom: `1px solid ${C.line}` }}>
                  {["Extension", "Register", "Renew / yr", "Transfer", "With a hosting plan", ""].map((h, i) => (
                    <th key={h + i} style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: i === 4 ? C.accent : C.faint, fontWeight: 600, textAlign: i === 0 || i === 5 ? "left" : "right", padding: "12px 16px" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownTlds.map((t) => (
                  <tr key={t.tld} style={{ borderBottom: `1px solid ${C.lineSoft}` }}>
                    <td style={{ padding: "13px 16px" }}><span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 500, color: C.ink }}>{t.tld}</span><div style={{ fontSize: 12, color: C.muted }}>{t.use}</div></td>
                    <td style={priceMono({ textAlign: "right", padding: "13px 16px", fontSize: 14.5, color: C.ink })}>{inr(t.reg)}</td>
                    <td style={priceMono({ textAlign: "right", padding: "13px 16px", fontSize: 14.5, color: C.muted })}>{inr(t.renew)}</td>
                    <td style={priceMono({ textAlign: "right", padding: "13px 16px", fontSize: 14.5, color: C.muted })}>{inr(t.transfer)}</td>
                    <td style={{ textAlign: "right", padding: "13px 16px" }}>
                      <span style={priceMono({ fontSize: 14.5, fontWeight: 700, color: C.accent })}>₹0</span>
                      <div style={{ fontSize: 12, color: C.muted }}>first year · yearly plan</div>
                    </td>
                    <td style={{ textAlign: "left", padding: "13px 16px" }}>
                      <button onClick={() => addRateRow(t)} style={{ appearance: "none", cursor: "pointer", background: C.accSurf, color: C.accent, border: `1px solid ${C.accBorder}`, borderRadius: 7, padding: "6px 12px", fontSize: 13, fontWeight: 600, fontFamily: "inherit", whiteSpace: "nowrap" }}>Search</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ background: C.tint, padding: "12px 16px", fontSize: 13, color: C.muted }}>Showing {shownTlds.length} of {TLDS.length} extensions — the ones people actually ask for. GST at 18% is stated separately on every invoice.</div>
        </div>
      </section>

      {/* ── 6 · INCLUDED ───────────────────────────────────────────────────── */}
      <section style={wrap({ paddingTop: mob ? 48 : 62 })}>
        <div style={eyebrow}>Included</div>
        <h2 style={{ ...h2, marginBottom: 20 }}>Included with every domain — hosting or not.</h2>
        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : mid ? "1fr 1fr" : "repeat(4, 1fr)", gap: 1, background: C.line, border: `1px solid ${C.line}`, borderRadius: 14, overflow: "hidden" }}>
          {DOMAIN_INCLUDED.map((f) => (
            <div key={f.t} style={{ background: C.card, padding: "20px 22px" }}>
              <div style={{ fontSize: 15.5, fontWeight: 600, color: C.ink }}>{f.t}</div>
              <p style={{ fontSize: 14, color: C.muted, lineHeight: 1.55, margin: "6px 0 0" }}>{f.b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── 7 · FAQ ────────────────────────────────────────────────────────── */}
      <section id="faq" style={wrap({ paddingTop: mob ? 48 : 62, display: "grid", gridTemplateColumns: mid ? "1fr" : "0.72fr 1.28fr", gap: mid ? 24 : 52, scrollMarginTop: 84 })}>
        <div>
          <div style={eyebrow}>Objections</div>
          <h2 style={h2}>The four reasons people skip the hosting box — and two we agree with.</h2>
          <a href="/contact" style={{ display: "inline-block", marginTop: 18, background: C.card, border: `1px solid ${C.line}`, borderRadius: 9, padding: "11px 16px", fontSize: 14, fontWeight: 500, color: C.ink, textDecoration: "none" }}>Talk to a person →</a>
        </div>
        <div>
          {DOMAIN_FAQS.map((f, i) => {
            const open = openFaq === i;
            return (
              <div key={f.q} style={{ borderTop: `1px solid ${C.line}` }}>
                <button onClick={() => setOpenFaq(open ? -1 : i)} aria-expanded={open}
                  style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, background: "transparent", border: "none", cursor: "pointer", padding: "18px 0", textAlign: "left", fontFamily: "inherit" }}>
                  <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", color: open ? C.accent : C.ink }}>{f.q}</span>
                  <span style={{ fontFamily: MONO, fontSize: 19, color: C.accent }}>{open ? "−" : "+"}</span>
                </button>
                {open && <p style={{ fontSize: 15, lineHeight: 1.65, color: C.ink2, padding: "0 40px 20px 0", margin: 0 }}>{f.a}</p>}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── 8 · CLOSING CTA ────────────────────────────────────────────────── */}
      <section style={wrap({ paddingTop: mob ? 48 : 66, paddingBottom: 20 })}>
        <div style={{ border: `1.5px solid ${C.accent}`, background: C.accSurf2, borderRadius: 18, padding: mob ? "26px 22px" : "34px 36px", display: "grid", gridTemplateColumns: mid ? "1fr" : "1.3fr 0.7fr", gap: mid ? 20 : 32, alignItems: "center" }}>
          <div>
            <h2 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: mob ? 28 : 38, color: C.ink, margin: 0 }}>Name, hosting and mailbox — one invoice, one afternoon.</h2>
            <p style={{ fontSize: 15.5, color: C.accentDark, lineHeight: 1.6, margin: "10px 0 0" }}>Search the name, pick a plan, and our team wires the DNS and mailbox the same day. Nothing is charged until you review the cart.</p>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: mid ? "flex-start" : "flex-end" }}>
            <a href="/cart" style={{ background: C.accent, color: "#fff", borderRadius: 10, padding: "15px 24px", fontSize: 15.5, fontWeight: 600, textDecoration: "none" }}>Review my cart</a>
            <a href="/quote" style={{ background: C.card, border: `1px solid ${C.accBorder}`, color: C.ink, borderRadius: 10, padding: "15px 24px", fontSize: 15.5, fontWeight: 600, textDecoration: "none" }}>Get it in writing</a>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ── The availability result: options, plan chooser, alternates ──────────── */
function ResultBlock(p: {
  C: typeof C_TYPE; MONO: string; SERIF: string; mob: boolean; priceMono: (e?: React.CSSProperties) => React.CSSProperties;
  primary: DomainResult; available: boolean; tld: string; domainReg: number; domainRenew: number;
  hostingOn: boolean; setHostingOn: (v: boolean) => void;
  planName: string; setPlanName: (v: string) => void;
  term: Term; setTerm: (v: Term) => void; mailOn: boolean; setMailOn: (v: boolean) => void;
  tier: (typeof HOSTING_TIERS)[number]; domainCost: number; mailboxCost: number;
  bundleFree: boolean; total: number; saved: number; onAdd: () => void;
  alternates: DomainResult[]; onAddAlt: (d: DomainResult) => void;
}) {
  const { C, MONO, SERIF, mob, priceMono, primary, available, domainReg, domainRenew,
    hostingOn, setHostingOn, planName, setPlanName, term, setTerm, mailOn, setMailOn,
    tier, bundleFree, total, saved, onAdd, alternates, onAddAlt } = p;
  const yearly = term === "yearly";

  if (!available) {
    return (
      <div style={{ marginTop: 24, border: `1.5px solid ${C.line}`, borderRadius: 14, overflow: "hidden" }}>
        <div style={{ background: C.lineSoft, padding: "16px 22px", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontFamily: MONO, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", color: C.muted, fontWeight: 600 }}>Taken</span>
          <span style={{ fontFamily: SERIF, fontSize: 22, color: C.ink }}>{primary.domain}</span>
        </div>
        <p style={{ padding: "16px 22px", fontSize: 14, color: C.muted, margin: 0 }}>This one is already registered. Try another spelling or a different extension — the alternates below are checked live too.</p>
        <Alternates C={C} MONO={MONO} priceMono={priceMono} alternates={alternates} onAddAlt={onAddAlt} />
      </div>
    );
  }

  const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

  return (
    <div style={{ marginTop: 24, border: `1.5px solid ${C.successBorder}`, borderRadius: 14, overflow: "hidden" }}>
      {/* header strip */}
      <div style={{ background: C.successSurf, padding: "16px 22px", borderBottom: `1px solid ${C.successBorder}`, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontFamily: MONO, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", color: C.success, fontWeight: 600 }}>Available</span>
        <span style={{ fontFamily: SERIF, fontSize: 23, letterSpacing: "-0.02em", color: C.ink, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={primary.domain}>{primary.domain}</span>
        <span style={priceMono({ fontSize: 13, color: C.success })}>renews {inr(domainRenew)}/yr</span>
      </div>
      <p style={{ padding: "16px 22px 6px", fontSize: 13.5, color: C.muted, margin: 0 }}>Pick one — you can change it any time before you pay.</p>

      {/* two options */}
      <div role="radiogroup" aria-label="Domain options" style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr", gap: 12, padding: "0 22px 4px" }}>
        {/* bundle */}
        <button role="radio" aria-checked={hostingOn} onClick={() => setHostingOn(true)}
          style={{ appearance: "none", cursor: "pointer", textAlign: "left", background: hostingOn ? C.accSurf : C.paper, border: `1.5px solid ${hostingOn ? C.accent : C.line}`, borderRadius: 12, padding: "16px 18px", fontFamily: "inherit" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Dot on={hostingOn} color={C.accent} disabled={C.line} />
            <span style={{ fontFamily: MONO, fontSize: 11, textTransform: "uppercase", color: C.accent, fontWeight: 600 }}>Domain + hosting</span>
            <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 10, textTransform: "uppercase", color: hostingOn ? "#fff" : C.accent, background: hostingOn ? C.accent : C.accSurf, borderRadius: 4, padding: "3px 7px" }}>Recommended</span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 12 }}>
            <span style={priceMono({ fontSize: 29, fontWeight: 700, color: C.accent })}>{bundleFree ? "₹0" : inr(domainReg)}</span>
            {bundleFree && <span style={priceMono({ fontSize: 17, color: C.faint, textDecoration: "line-through" })}>{inr(domainReg)}</span>}
            <span style={{ fontSize: 13, color: C.accentDark }}>for the name</span>
          </div>
          <p style={{ fontSize: 13, color: C.accentDark, margin: "8px 0 0", lineHeight: 1.5 }}>
            + {tier.name} hosting at {inr(yearly ? tier.yearlyMo : tier.monthly)}/mo · {bundleFree ? "mailbox included free, DNS wired the same day" : "renews at the same price"}
          </p>
          {!bundleFree && <p style={{ fontSize: 12.5, fontWeight: 600, color: C.accent, margin: "8px 0 0" }}>You&apos;re on monthly billing — the free domain and free mailbox need a yearly plan.</p>}
        </button>

        {/* solo */}
        <button role="radio" aria-checked={!hostingOn} onClick={() => setHostingOn(false)}
          style={{ appearance: "none", cursor: "pointer", textAlign: "left", background: C.paper, border: `1.5px solid ${!hostingOn ? C.ink : C.line}`, borderRadius: 12, padding: "16px 18px", fontFamily: "inherit" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Dot on={!hostingOn} color={C.ink} disabled={C.line} />
            <span style={{ fontFamily: MONO, fontSize: 11, textTransform: "uppercase", color: C.faint, fontWeight: 600 }}>Domain only</span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 12 }}>
            <span style={priceMono({ fontSize: 29, fontWeight: 500, color: C.ink })}>{inr(domainReg)}</span>
            <span style={{ fontSize: 13, color: C.muted }}>first year + GST</span>
          </div>
          <p style={{ fontSize: 13, color: C.muted, margin: "8px 0 0", lineHeight: 1.5 }}>renews {inr(domainRenew)}/yr · nothing else added. You get the name and DNS control — nothing will load at it until you point it at a host.</p>
        </button>
      </div>

      {/* plan chooser (bundle only) */}
      {hostingOn && (
        <div style={{ margin: "12px 22px 0", borderTop: `1px dashed ${C.line}`, paddingTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14.5, fontWeight: 600, color: C.ink }}>Which plan should {primary.domain} point at?</span>
            <div style={{ display: "flex", background: C.lineSoft, borderRadius: 8, padding: 3 }}>
              {(["yearly", "monthly"] as Term[]).map((t) => {
                const on = term === t;
                return (
                  <button key={t} onClick={() => setTerm(t)} aria-pressed={on}
                    style={{ appearance: "none", cursor: "pointer", background: on ? C.card : "transparent", boxShadow: on ? "0 1px 2px rgba(26,22,20,0.12)" : "none", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 13, fontWeight: on ? 600 : 500, color: on ? C.ink : C.muted, fontFamily: "inherit" }}>
                    {t === "yearly" ? "Yearly · domain free" : "Monthly"}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "repeat(3, 1fr)", gap: 10, marginTop: 12 }}>
            {HOSTING_TIERS.map((t) => {
              const on = planName === t.name;
              return (
                <button key={t.name} onClick={() => setPlanName(t.name)} aria-pressed={on}
                  style={{ appearance: "none", cursor: "pointer", textAlign: "left", background: on ? C.accSurf : C.card, border: `1.5px solid ${on ? C.accent : C.line}`, borderRadius: 11, padding: "13px 14px", fontFamily: "inherit" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Dot on={on} color={C.accent} disabled={C.line} small />
                    <span style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{t.name}</span>
                    {t.isPopular && <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9.5, textTransform: "uppercase", color: C.accent }}>Most chosen</span>}
                  </div>
                  <div style={priceMono({ fontSize: 17, fontWeight: 700, color: C.ink, marginTop: 6 })}>{inr(yearly ? t.yearlyMo : t.monthly)}<span style={{ fontSize: 12, fontWeight: 400, color: C.muted }}>/mo</span></div>
                  <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>{t.storage} · {t.bandwidth} bandwidth</div>
                </button>
              );
            })}
          </div>
          {/* mailbox */}
          <div style={{ display: "flex", alignItems: "center", gap: 13, background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", marginTop: 12 }}>
            <Switch on={mailOn} onToggle={() => setMailOn(!mailOn)} color={C.accent} off={C.line} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14.5, fontWeight: 600, color: C.ink }}>Add one mailbox on {primary.domain} — {bundleFree ? "free with the plan" : `${inr(MAILBOX_YR_CONST)}/yr`}</div>
              <div style={{ fontSize: 13, color: C.muted }}>you@{primary.domain}, Anutech Mail. Follows the plan — drops if you switch to domain-only.</div>
            </div>
          </div>
        </div>
      )}

      {/* action row */}
      <div style={{ padding: "16px 22px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13.5, color: C.muted, maxWidth: "40ch" }}>
          Nothing is charged yet — change the plan, drop the mailbox or remove hosting any time before you pay.
          {saved > 0 && <> <strong style={{ color: C.success }}>Bundle value included −{inr(saved)}.</strong></>}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ textAlign: "right" }}>
            <div style={priceMono({ fontSize: 20, fontWeight: 700, color: C.ink })}>{inr(total)}</div>
            <div style={{ fontSize: 11.5, color: C.faint }}>total incl. 18% GST</div>
          </div>
          <button onClick={onAdd} style={{ appearance: "none", cursor: "pointer", background: C.ink, color: "#fff", border: "none", borderRadius: 10, padding: "14px 26px", fontSize: 15.5, fontWeight: 600, fontFamily: "inherit" }}>
            {hostingOn ? "Add to cart →" : "Add the name only →"}
          </button>
        </div>
      </div>

      <Alternates C={C} MONO={MONO} priceMono={priceMono} alternates={alternates} onAddAlt={onAddAlt} />
    </div>
  );
}

function Alternates(p: { C: typeof C_TYPE; MONO: string; priceMono: (e?: React.CSSProperties) => React.CSSProperties; alternates: DomainResult[]; onAddAlt: (d: DomainResult) => void }) {
  const { C, MONO, priceMono, alternates, onAddAlt } = p;
  if (!alternates.length) return null;
  const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
  return (
    <div style={{ padding: "4px 22px 20px" }}>
      <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: C.faint, margin: "12px 0 10px" }}>Same name, other extensions</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(232px, 1fr))", gap: 10 }}>
        {alternates.map((d) => (
          <div key={d.domain} style={{ display: "flex", alignItems: "center", gap: 10, background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: "13px 15px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.ink }} title={d.domain}>{d.domain}</div>
              <div style={priceMono({ fontSize: 12, color: C.muted })}>{d.available ? (d.priceKnown ? `${inr(d.price)} · ₹0 with hosting` : "price on request") : "taken · WHOIS"}</div>
            </div>
            {d.available ? (
              <button onClick={() => onAddAlt(d)} style={{ appearance: "none", cursor: "pointer", background: C.accSurf, color: C.accent, border: `1px solid ${C.accBorder}`, borderRadius: 7, padding: "6px 12px", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>Pick</button>
            ) : (
              <span style={{ fontSize: 13, color: C.faint, background: C.lineSoft, borderRadius: 7, padding: "6px 12px" }}>Taken</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Dot({ on, color, disabled, small }: { on: boolean; color: string; disabled: string; small?: boolean }) {
  const s = small ? 16 : 18;
  return <span aria-hidden style={{ width: s, height: s, borderRadius: "50%", flexShrink: 0, border: on ? `${small ? 5 : 6}px solid ${color}` : `1.5px solid ${disabled}`, background: "#fff", boxSizing: "border-box" }} />;
}

function Switch({ on, onToggle, color, off }: { on: boolean; onToggle: () => void; color: string; off: string }) {
  return (
    <button role="switch" aria-checked={on} onClick={onToggle}
      style={{ appearance: "none", cursor: "pointer", width: 52, height: 30, borderRadius: 20, border: "none", background: on ? color : off, position: "relative", flexShrink: 0, transition: "background .16s" }}>
      <span style={{ position: "absolute", top: 3, left: on ? 25 : 3, width: 24, height: 24, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.24)", transition: "left .16s" }} />
    </button>
  );
}

/* Type-only aliases so the sub-components can name the palette/const without re-importing. */
const C_TYPE = {} as {
  ink: string; ink2: string; muted: string; faint: string; onDark: string; paper: string; tint: string; card: string;
  line: string; lineSoft: string; accent: string; accentDark: string; accentLight: string; accSurf: string; accSurf2: string;
  accBorder: string; success: string; successSurf: string; successBorder: string; dot: string; warn: string; darkCard: string; darkBorder: string;
};
const MAILBOX_YR_CONST = MAILBOX_YR;
