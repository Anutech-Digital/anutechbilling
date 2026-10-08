"use client";

/**
 * HostingLanding — the conversion-focused /hosting page (redesign, 2 Sep 2026).
 *
 * A faithful build of the "Hosting Page Conversion Redesign" v2 handoff, adapted
 * to the app's real data (see hosting-landing-v2.ts for the three departures:
 * real bandwidth, verified-only claims, real website counts). It renders under
 * (marketing), so the shared site chrome — the home-page menu (a sticky Header),
 * the utility bar and the footer — sits around it on this page as on every other,
 * and the way back to the home page and across to Domains, Email, ResellerOS,
 * etc. is never lost. So this component renders only its own body (hero → final
 * CTA); in-page navigation is the quick-jump strip. "Start free trial" leads to
 * the cart as a ₹0 trial line (no form in between); "Buy now" adds the plan to the cart.
 * Prices come from LANDING_PLANS via HOSTING_TIERS.
 *
 * Responsive is driven off a measured window width (`w`), exactly as the
 * prototype did; SSR and the first client render both use 1200 (desktop), so
 * there is no hydration mismatch, and the layout settles after mount.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { hostingSans as manrope, hostingSerif as serif, hostingMono as mono } from "@/lib/fonts";
import { useCart } from "@/site/components/cart/CartProvider";
import { isTrialPlan, TRIAL_PLAN_ID, TRIAL_PLAN_NAME } from "@/lib/hosting/trial-plan";
import { paidHostingLine } from "@/site/lib/hosting-cart-line";
import {
  HOSTING_TIERS,
  REC_WHY,
  HOSTING_MATRIX,
  HOSTING_TIMELINE,
  MIGRATION_NEED,
  MIGRATION_WEDO,
  HOSTING_WORRIES,
  HOSTING_PROOFS,
  HOSTING_GOOD_FIT,
  HOSTING_BAD_FIT,
  HOSTING_CHANNELS,
  HOSTING_FAQS_V2,
  WHATSAPP_URL,
  TRIAL_DAYS,
} from "@/site/lib/data/hosting-landing-v2";


const C = {
  ink: "#17120F", ink2: "#4A403A", muted: "#7A6C62", faint: "#9A8B80", onDark: "#C9BAB0",
  paper: "#FDFBF8", tint: "#FBF8F5", card: "#fff", line: "#E8DFD7", lineSoft: "#F3ECE5",
  accent: "#C2410C", accentDark: "#7C2D12", accentLight: "#FB923C", accSurf: "#FFF1E7",
  accSurf2: "#FFF9F4", accBorder: "#FBD3B8", success: "#15803D", successSurf: "#F0FDF4",
  successBorder: "#BBF7D0", dot: "#4ADE80", darkCard: "#1E1712", darkBorder: "#33261E",
};
const MONO = "var(--hf-mono), 'JetBrains Mono', monospace";
const SERIF = "var(--hf-serif), 'Instrument Serif', serif";

const inr = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return "₹" + r.toLocaleString("en-IN", { minimumFractionDigits: r % 1 ? 2 : 0, maximumFractionDigits: 2 });
};
const gst = (n: number) => inr(n * 1.18);

export function HostingLanding() {
  const [billing, setBilling] = useState<"Monthly" | "Yearly">("Yearly");
  const [sites, setSites] = useState<string | null>(null);
  const [traffic, setTraffic] = useState<string | null>(null);
  const [openFaq, setOpenFaq] = useState(0);
  const [showMatrix, setShowMatrix] = useState(false);
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
  const yearly = billing === "Yearly";

  // Recommender
  let rec: string | null = null, recWhy = "";
  if (sites && traffic) {
    if (sites === "More than 5" || traffic === "50,000+") {
      rec = "Plus";
      recWhy = sites === "More than 5" ? REC_WHY["Plus-sites"] : REC_WHY["Plus-traffic"];
    } else if (sites === "Just one" && traffic === "Under 5,000") {
      rec = "Starter"; recWhy = REC_WHY.Starter;
    } else {
      rec = "Standard"; recWhy = REC_WHY.Standard;
    }
  }

  const plans = HOSTING_TIERS.map((p) => {
    const isRec = p.name === rec;
    const isTop = isRec || (!rec && p.isPopular);
    const total = yearly ? p.yearlyTotal : p.monthly;
    return {
      ...p,
      badge: isRec ? "BEST FIT" : (!rec && p.isPopular ? "MOST CHOSEN" : null),
      isTop,
      priceLabel: inr(yearly ? p.yearlyMo : p.monthly),
      billingLine: yearly ? `Billed annually · ${inr(p.yearlyTotal)} + GST` : `Billed monthly · ${inr(p.monthly)} + GST`,
      renewLine: `${inr(yearly ? p.yearlyMo : p.monthly)}/mo — the same price, not a first-year rate`,
      payToday: `Pay today ${gst(total)} incl. 18% GST`,
    };
  });
  /* One add-to-cart for both card layouts (trial plan: secondary button; others:
     the main one), so the two can never charge differently. */
  const addPlanToCart = (p: (typeof plans)[number]) => cart.add(paidHostingLine(p, yearly));
  /* "Start free trial" goes straight to the cart (Pardeep, 24 Sep 2026: no page in
     between). A ₹0 trial line on the billing cycle being viewed; checkout then asks
     for the details and starts the trial with no payment step. Any earlier trial
     line is removed first, so switching Monthly/Yearly and clicking again never
     leaves two trials or a "2 ×" trial in the cart. */
  const router = useRouter();
  const startTrialInCart = () => {
    for (const l of cart.lines) if ((l.sku || "").startsWith("hosting-trial:")) cart.remove(l.key);
    cart.add({
      label: `${TRIAL_PLAN_NAME} hosting — 15-day free trial`,
      detail: `No card · then ${TRIAL_PLAN_NAME} billed ${yearly ? "yearly" : "monthly"} if you keep it`,
      unitPrice: 0,
      unit: "trial",
      cycle: yearly ? "yearly" : "monthly",
      sku: `hosting-trial:${TRIAL_PLAN_ID}`,
    });
    cart.closeDrawer();
    router.push("/cart" as never);
  };
  const anchor = plans.find((p) => p.badge) ?? plans[1];
  const anchorBase = HOSTING_TIERS.find((t) => t.name === anchor.name)!;

  const costRows = HOSTING_TIERS.map((p) => {
    const y = p.yearlyTotal * 3, m = p.monthly * 36;
    return { name: p.name, yearly: gst(y), monthly: gst(m), save: gst(m - y) };
  });

  // Shared style fragments
  const eyebrow = (color = C.accent): React.CSSProperties => ({ fontFamily: MONO, fontSize: 12, letterSpacing: ".1em", color, fontWeight: 700 });
  const h2: React.CSSProperties = { marginTop: 12, fontSize: "clamp(30px,4.6vw,42px)", lineHeight: 1.1, letterSpacing: "-.035em", fontWeight: 800 };
  const wrap: React.CSSProperties = { maxWidth: 1200, margin: "0 auto" };
  const chip = (active: boolean): React.CSSProperties => ({
    border: `1.5px solid ${active ? C.accent : C.line}`, background: active ? C.accSurf : "#fff",
    color: active ? C.accentDark : C.ink2, padding: "12px 16px", borderRadius: 999, fontSize: 14.5,
    fontWeight: 700, minHeight: 46, whiteSpace: "nowrap", cursor: "pointer",
  });
  const twoCol = w < 820 ? "minmax(0,1fr)" : "repeat(2,minmax(0,1fr))";
  const threeCol = mob ? "minmax(0,1fr)" : mid ? "repeat(2,minmax(0,1fr))" : "repeat(3,minmax(0,1fr))";
  const tripleCol = mob ? "minmax(0,1fr)" : "repeat(3,minmax(0,1fr))";
  const quadGrid: React.CSSProperties = {
    marginTop: 28, display: "grid",
    gridTemplateColumns: mob ? "minmax(0,1fr)" : `repeat(${mid ? 2 : 4},minmax(0,1fr))`, gap: mob ? 14 : 16,
  };
  return (
    <div className={`hlp ${manrope.variable} ${serif.variable} ${mono.variable}`}
      style={{ fontFamily: "var(--hf-sans), system-ui, sans-serif", background: C.paper, color: C.ink, maxWidth: "100%", overflowX: "hidden" }}>
      <style dangerouslySetInnerHTML={{ __html: `
        .hlp a { color:${C.accent}; text-decoration:none; }
        .hlp a:hover { color:${C.accentDark}; text-decoration:underline; }
        .hlp *:focus-visible { outline:2.5px solid ${C.accent}; outline-offset:2px; }
        @keyframes hlpPulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.35;transform:scale(.8)} }
        @keyframes hlpRise { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
        .hlp-orange:hover { background:${C.accentDark} !important; text-decoration:none !important; color:#fff !important; }
        .hlp-dark:hover { background:${C.accent} !important; text-decoration:none !important; color:#FDFBF8 !important; }
        .hlp-orange2:hover { background:#EA580C !important; text-decoration:none !important; color:#fff !important; }
        .hlp-outline:hover { border-color:${C.ink} !important; color:${C.ink} !important; text-decoration:none !important; }
        .hlp-pill:hover { border-color:${C.accent} !important; text-decoration:none !important; }
        .hlp-ghostdark:hover { border-color:#FDFBF8 !important; color:#FDFBF8 !important; text-decoration:none !important; }
      ` }} />

      {/* The announcement strip, the home-page menu (site Header, sticky) and the
          footer all come from the marketing layout, so they appear on EVERY page
          and the way back to the main site is never lost. This page renders only
          its own body below; the quick-jump strip handles in-page navigation. */}

      {/* 3. Hero */}
      <section style={{ padding: "clamp(38px,6vw,66px) 20px clamp(40px,5vw,54px)", borderBottom: `1px solid ${C.line}` }}>
        <div style={{ ...wrap, display: "grid", gridTemplateColumns: w < 880 ? "minmax(0,1fr)" : "minmax(0,1.15fr) minmax(0,.85fr)", gap: w < 880 ? 32 : w < 1060 ? 32 : 56, alignItems: w < 880 ? "start" : "center" }}>
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 9, background: C.accSurf, border: `1px solid ${C.accBorder}`, color: C.accentDark, padding: "7px 13px", borderRadius: 999, fontSize: 12.5, fontWeight: 700, fontFamily: MONO }}>{TRIAL_DAYS}-DAY FREE TRIAL ON {TRIAL_PLAN_NAME.toUpperCase()} · NO CARD NEEDED</div>
            <h1 style={{ marginTop: 20, fontSize: "clamp(34px,4.4vw,56px)", lineHeight: 1.07, letterSpacing: "-.035em", fontWeight: 800 }}>
              Launch Your<br />Business Website<br />
              <span style={{ fontFamily: SERIF, fontWeight: 400, fontStyle: "italic", color: C.accent }}>FREE for {TRIAL_DAYS} Days.</span>
            </h1>
            <p style={{ marginTop: 18, fontSize: 18, lineHeight: 1.55, color: C.ink2, maxWidth: "min(100%,560px)", textWrap: "pretty" } as React.CSSProperties}>
              Enterprise-grade web hosting powered by Google Cloud. Free SSL, daily backups, free migration and support from real people — and the trial needs no credit card, so your old host stays live until you approve the move.
            </p>
            <div style={{ marginTop: 26, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button type="button" onClick={startTrialInCart} className="hlp-orange" style={{ background: C.accent, color: "#fff", padding: "16px 24px", borderRadius: 12, fontSize: 16, fontWeight: 700, minHeight: 52, display: "inline-flex", alignItems: "center", border: 0, cursor: "pointer", fontFamily: "inherit" }}>Start the free {TRIAL_PLAN_NAME} trial</button>
              <a href="#move" className="hlp-outline" style={{ background: "#fff", border: `1px solid ${C.line}`, color: C.ink, padding: "16px 24px", borderRadius: 12, fontSize: 16, fontWeight: 700, minHeight: 52, display: "inline-flex", alignItems: "center" }}>See how migration works</a>
            </div>
            <ul style={{ marginTop: 24, display: "flex", gap: "8px 22px", flexWrap: "wrap", listStyle: "none", padding: 0, margin: "24px 0 0" }}>
              {["No credit card", "Full features during trial", "30-day refund on yearly"].map((t) => (
                <li key={t} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14.5, fontWeight: 600, color: C.ink2 }}><span style={{ color: C.success, fontWeight: 800 }}>✓</span>{t}</li>
              ))}
            </ul>
          </div>

          {/* Honest numbers card */}
          <div style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 18, padding: "clamp(22px,3vw,28px)", boxShadow: "0 20px 50px -34px rgba(23,18,15,.4)" }}>
            <div style={{ fontFamily: MONO, fontSize: 11.5, letterSpacing: ".09em", color: C.muted, fontWeight: 700 }}>THE HONEST NUMBERS</div>
            <div style={{ marginTop: 16, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: "clamp(34px,4vw,44px)", fontWeight: 800, letterSpacing: "-.04em" }}>{anchor.priceLabel}</span>
              <span style={{ fontSize: 15, color: C.muted, fontWeight: 600 }}>/month, {anchor.name} plan</span>
            </div>
            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              {[
                ["Billed", yearly ? `${inr(anchorBase.yearlyTotal)} + GST once a year` : `${inr(anchorBase.monthly)} + GST every month`],
                ["You pay today", `${gst(yearly ? anchorBase.yearlyTotal : anchorBase.monthly)} incl. GST`],
                ["Renews at", `${inr(yearly ? anchorBase.yearlyMo : anchorBase.monthly)}/mo — same price`],
              ].map(([k, v], i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14.5, paddingBottom: 10, borderBottom: `1px dashed ${C.line}` }}><span style={{ color: C.muted }}>{k}</span><span style={{ fontWeight: 700, textAlign: "right" }}>{v}</span></div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14.5 }}><span style={{ color: C.muted }}>Charged during trial</span><span style={{ fontWeight: 700, color: C.success }}>₹0</span></div>
            </div>
            <p style={{ marginTop: 16, fontSize: 13.5, lineHeight: 1.5, color: C.muted }}>Domains, business email and Google Workspace are separate line items — never bundled into the headline price. <a href="/rates">See the full rate card</a>.</p>
          </div>
        </div>
      </section>

      {/* 4. Quick-jump */}
      <section style={{ padding: "22px 20px", background: C.tint, borderBottom: `1px solid ${C.line}` }}>
        <div style={wrap}>
          <div style={{ fontSize: 13.5, color: C.muted, fontWeight: 600 }}>Deciding on hosting comes down to four questions. Jump to any of them:</div>
          <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
            {[["#choose", "Which plan do I need?"], ["#cost", "What will it really cost?"], ["#move", "How hard is moving?"], ["#worries", "What if something goes wrong?"]].map(([href, t]) => (
              <a key={href} href={href} className="hlp-pill" style={{ background: "#fff", border: `1px solid ${C.line}`, color: C.ink, padding: "11px 15px", borderRadius: 999, fontSize: 14, fontWeight: 700 }}>{t}</a>
            ))}
          </div>
        </div>
      </section>

      {/* 5. Choose */}
      <section id="choose" style={{ padding: "clamp(50px,7vw,76px) 20px", borderBottom: `1px solid ${C.line}` }}>
        <div style={wrap}>
          <div style={eyebrow()}>STEP 1 — WHICH PLAN</div>
          <h2 style={{ ...h2, maxWidth: 700 }}>Answer two questions instead of reading three feature lists.</h2>

          <div style={{ marginTop: 26, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 18, padding: "clamp(20px,3vw,28px)" }}>
            <div style={{ display: "grid", gridTemplateColumns: twoCol, gap: 22 }}>
              <div>
                <div style={{ fontFamily: MONO, fontSize: 11.5, letterSpacing: ".08em", color: C.muted, fontWeight: 700 }}>HOW MANY WEBSITES?</div>
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {["Just one", "2 to 5", "More than 5"].map((o) => <button key={o} onClick={() => setSites(o)} style={chip(sites === o)}>{o}</button>)}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: MONO, fontSize: 11.5, letterSpacing: ".08em", color: C.muted, fontWeight: 700 }}>VISITORS PER MONTH?</div>
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {["Under 5,000", "5,000–50,000", "50,000+"].map((o) => <button key={o} onClick={() => setTraffic(o)} style={chip(traffic === o)}>{o}</button>)}
                </div>
              </div>
            </div>
            {rec ? (
              <div style={{ marginTop: 22, background: C.accSurf, border: `1px solid ${C.accBorder}`, borderRadius: 14, padding: 20, display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                  <div style={{ fontSize: 18.5, fontWeight: 800, letterSpacing: "-.02em", color: C.accentDark }}>{rec} is the plan to start on</div>
                  <p style={{ marginTop: 7, fontSize: 15, lineHeight: 1.55, color: C.ink2 }}>{recWhy}</p>
                </div>
                <button onClick={() => { setSites(null); setTraffic(null); }} style={{ background: "transparent", border: `1px solid ${C.accBorder}`, color: C.accentDark, padding: "12px 15px", borderRadius: 10, fontSize: 13.5, fontWeight: 700, whiteSpace: "nowrap", minHeight: 46, cursor: "pointer" }}>Start over</button>
              </div>
            ) : (
              <p style={{ marginTop: 18, fontSize: 14.5, color: C.muted, lineHeight: 1.55 }}>Still unsure? Start a free trial on {TRIAL_PLAN_NAME} — the account and everything you build in it carry over when you move up to Standard or Plus. Those two have no trial.</p>
            )}
          </div>

          {/* Billing toggle */}
          <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
            <div style={{ display: "inline-flex", background: "#F3ECE5", borderRadius: 12, padding: 4 }}>
              {(["Monthly", "Yearly"] as const).map((b) => {
                const active = (b === "Yearly") === yearly;
                return <button key={b} onClick={() => setBilling(b)} style={{ border: 0, borderRadius: 9, padding: "12px 18px", fontSize: 14, fontWeight: 700, minHeight: 46, whiteSpace: "nowrap", cursor: "pointer", background: active ? C.ink : "transparent", color: active ? C.paper : C.muted }}>{b === "Yearly" ? "Yearly · save 50%" : "Monthly"}</button>;
              })}
            </div>
          </div>

          {/* Plan cards */}
          <div style={mob
            ? { margin: "26px -20px 0", padding: "4px 20px 18px", display: "flex", gap: 14, overflowX: "auto", scrollSnapType: "x mandatory", WebkitOverflowScrolling: "touch", alignItems: "start" } as React.CSSProperties
            : { marginTop: 18, display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: mid ? 14 : 20, alignItems: "start" }}>
            {plans.map((p) => (
              <div key={p.name} style={{
                background: "#fff", border: p.isTop ? `1.5px solid ${C.accent}` : `1px solid ${C.line}`, borderRadius: 18,
                padding: mob ? 22 : 24, boxShadow: p.isTop ? "0 26px 60px -34px rgba(194,65,12,.5)" : "0 10px 30px -24px rgba(23,18,15,.28)",
                ...(mob ? { scrollSnapAlign: "center", minWidth: "min(86vw,340px)" } : {}),
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", minHeight: 26 }}>
                  <div style={{ fontFamily: MONO, fontSize: 11.5, letterSpacing: ".09em", color: C.muted, fontWeight: 700 }}>{p.tag}</div>
                  {p.badge && <div style={{ background: C.accent, color: "#fff", fontSize: 11, fontWeight: 800, letterSpacing: ".06em", padding: "5px 10px", borderRadius: 999, whiteSpace: "nowrap" }}>{p.badge}</div>}
                </div>
                <h3 style={{ marginTop: 14, fontSize: 26, fontWeight: 800, letterSpacing: "-.03em" }}>{p.name}</h3>
                <p style={{ marginTop: 6, fontSize: 14.5, color: C.ink2, lineHeight: 1.45, minHeight: 42 }}>{p.fit}</p>
                <div style={{ marginTop: 16, display: "flex", alignItems: "baseline", gap: 7 }}>
                  <span style={{ fontSize: 38, fontWeight: 800, letterSpacing: "-.04em" }}>{p.priceLabel}</span>
                  <span style={{ fontSize: 14.5, color: C.muted, fontWeight: 600 }}>/month</span>
                </div>
                <div style={{ marginTop: 6, fontSize: 13.5, color: C.muted, lineHeight: 1.5 }}>{p.billingLine}<br /><span style={{ color: C.ink, fontWeight: 600 }}>Renews at {p.renewLine}</span></div>
                <div style={{ marginTop: 10, background: C.tint, border: `1px solid ${C.line}`, borderRadius: 9, padding: "9px 12px", fontFamily: MONO, fontSize: 12.5 }}>{p.payToday}</div>
                <div style={{ marginTop: 16, display: "grid", gap: 8 }}>
                  {isTrialPlan(p.name) ? (
                    <>
                      <button type="button" onClick={startTrialInCart} className={p.isTop ? "hlp-orange" : "hlp-dark"} style={{ textAlign: "center", padding: 15, borderRadius: 11, fontSize: 15, fontWeight: 700, color: "#fff", minHeight: 50, background: p.isTop ? C.accent : C.ink, border: 0, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontFamily: "inherit" }}>Start free trial on {p.name}</button>
                      <button type="button" onClick={() => addPlanToCart(p)} className="hlp-outline" style={{ textAlign: "center", padding: 12, borderRadius: 11, fontSize: 14, fontWeight: 700, color: C.ink2, border: `1px solid ${C.line}`, background: "#fff", minHeight: 46, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>Buy now, skip the trial</button>
                    </>
                  ) : (
                    <>
                      {/* Only Starter has a free trial (owner, 24 Sep 2026) — monthly and
                          yearly alike. This plan is bought, so buying is the main action. */}
                      <button type="button" onClick={() => addPlanToCart(p)} className={p.isTop ? "hlp-orange" : "hlp-dark"} style={{ textAlign: "center", padding: 15, borderRadius: 11, fontSize: 15, fontWeight: 700, color: "#fff", minHeight: 50, background: p.isTop ? C.accent : C.ink, border: 0, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>Buy {p.name}</button>
                      <div style={{ textAlign: "center", fontSize: 13, lineHeight: 1.45, color: C.muted, minHeight: 46, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 6px" }}>
                        <span>No free trial on {p.name}. <button type="button" onClick={startTrialInCart} style={{ color: C.accentDark, fontWeight: 700, background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", textDecoration: "underline" }}>Try {TRIAL_PLAN_NAME} free</button> and move up later.</span>
                      </div>
                    </>
                  )}
                </div>
                <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px dashed ${C.line}`, display: "grid", gap: 10 }}>
                  {[["NVMe storage", p.storage], ["Websites", p.sites], ["Bandwidth", p.bandwidth]].map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 14.5 }}><span style={{ color: C.muted }}>{k}</span><span style={{ fontWeight: 700, fontFamily: MONO }}>{v}</span></div>
                  ))}
                </div>
                <div style={{ marginTop: 16, background: C.accSurf2, border: `1px solid ${C.accBorder}`, borderRadius: 10, padding: 12 }}>
                  <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: ".08em", color: C.accentDark, fontWeight: 700 }}>MOVE UP WHEN</div>
                  <p style={{ marginTop: 5, fontSize: 13.5, lineHeight: 1.45, color: C.ink2 }}>{p.outgrow}</p>
                </div>
              </div>
            ))}
          </div>
          {mob && <div style={{ marginTop: 12, textAlign: "center", fontFamily: MONO, fontSize: 11.5, letterSpacing: ".06em", color: C.accent, fontWeight: 700 }}>Swipe to compare all three plans →</div>}

          {/* Feature table */}
          <div style={{ marginTop: 24, textAlign: "center" }}>
            <button onClick={() => setShowMatrix((v) => !v)} className="hlp-outline" style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 12, padding: "14px 22px", fontSize: 15, fontWeight: 700, color: C.ink, minHeight: 48, cursor: "pointer" }}>{showMatrix ? "Hide the full feature table" : "See the full feature table"}</button>
          </div>
          {showMatrix && (
            <div style={{ marginTop: 18, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 16, overflowX: "auto" }}>
              <div style={{ minWidth: 560 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1.6fr .8fr .8fr .8fr", background: C.ink, color: C.paper }}>
                  <div style={{ padding: "14px 18px", fontFamily: MONO, fontSize: 12, letterSpacing: ".06em" }}>FEATURE</div>
                  {["Starter", "Standard", "Plus"].map((t) => <div key={t} style={{ padding: "14px 12px", fontSize: 14, fontWeight: 700, textAlign: "center" }}>{t}</div>)}
                </div>
                {HOSTING_MATRIX.map((m) => (
                  <div key={m.k} style={{ display: "grid", gridTemplateColumns: "1.6fr .8fr .8fr .8fr", borderBottom: `1px solid ${C.lineSoft}`, alignItems: "center" }}>
                    <div style={{ padding: "13px 18px", fontSize: 14.5, fontWeight: 600 }}>{m.k}</div>
                    {[m.a, m.b, m.c].map((v, i) => <div key={i} style={{ padding: "13px 12px", fontSize: 14, textAlign: "center", color: C.ink2, fontFamily: MONO }}>{v}</div>)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 6. Cost */}
      <section id="cost" style={{ padding: "clamp(50px,7vw,76px) 20px", background: C.tint, borderBottom: `1px solid ${C.line}` }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={eyebrow()}>STEP 2 — REAL COST</div>
          <h2 style={{ ...h2, maxWidth: 720 }}>Three years of hosting, GST included, both billing options.</h2>
          <p style={{ marginTop: 14, fontSize: 16.5, lineHeight: 1.55, color: C.ink2, maxWidth: 680, textWrap: "pretty" } as React.CSSProperties}>Monthly billing costs more over time — we&apos;d rather show you the arithmetic than hide it. These are our list prices at 18% GST; nothing here is an introductory rate that jumps later.</p>
          <div style={{ marginTop: 28, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 16, overflowX: "auto" }}>
            <div style={{ minWidth: 620 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", background: C.ink, color: C.paper }}>
                <div style={{ padding: "14px 18px", fontFamily: MONO, fontSize: 12, letterSpacing: ".06em" }}>PLAN</div>
                <div style={{ padding: "14px 14px", fontSize: 13.5, fontWeight: 700, textAlign: "right" }}>3 yrs, billed yearly</div>
                <div style={{ padding: "14px 14px", fontSize: 13.5, fontWeight: 700, textAlign: "right" }}>3 yrs, billed monthly</div>
                <div style={{ padding: "14px 18px 14px 14px", fontSize: 13.5, fontWeight: 700, textAlign: "right", color: C.accentLight }}>You keep</div>
              </div>
              {costRows.map((r) => (
                <div key={r.name} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", borderBottom: `1px solid ${C.lineSoft}`, alignItems: "center" }}>
                  <div style={{ padding: "16px 18px", fontSize: 15.5, fontWeight: 700 }}>{r.name}</div>
                  <div style={{ padding: "16px 14px", fontSize: 15, textAlign: "right", fontFamily: MONO, fontWeight: 700 }}>{r.yearly}</div>
                  <div style={{ padding: "16px 14px", fontSize: 15, textAlign: "right", fontFamily: MONO, color: C.faint }}>{r.monthly}</div>
                  <div style={{ padding: "16px 18px 16px 14px", fontSize: 15, textAlign: "right", fontFamily: MONO, fontWeight: 700, color: C.success }}>{r.save}</div>
                </div>
              ))}
            </div>
          </div>
          <p style={{ marginTop: 14, fontSize: 13.5, color: C.muted, lineHeight: 1.55 }}>Figures are 36 months of the current list price with 18% GST applied. Domain registration, business email and Google Workspace are billed separately — <a href="/rates">see the rate card</a> or <a href="/quote">ask for a written quote</a> with your exact requirement.</p>
        </div>
      </section>

      {/* 7. Trial timeline (dark) */}
      <section style={{ padding: "clamp(46px,6vw,60px) 20px", background: C.ink, color: C.paper }}>
        <div style={wrap}>
          <h2 style={{ fontSize: "clamp(28px,4vw,36px)", letterSpacing: "-.03em", fontWeight: 800 }}>What happens on each day of the trial.</h2>
          <div style={quadGrid}>
            {HOSTING_TIMELINE.map((t) => (
              <div key={t.d} style={{ border: `1px solid ${C.darkBorder}`, background: C.darkCard, borderRadius: 14, padding: 22 }}>
                <div style={{ fontFamily: MONO, fontSize: 11.5, letterSpacing: ".08em", color: C.accentLight, fontWeight: 700 }}>{t.d}</div>
                <div style={{ marginTop: 9, fontSize: 17, fontWeight: 800, letterSpacing: "-.02em" }}>{t.t}</div>
                <p style={{ marginTop: 7, fontSize: 14.5, lineHeight: 1.55, color: C.onDark }}>{t.b}</p>
              </div>
            ))}
          </div>
          <p style={{ marginTop: 20, fontSize: 14.5, color: C.onDark }}>No card is stored during the trial, so no automatic charge is possible at the end of it.</p>
        </div>
      </section>

      {/* 8. Move */}
      <section id="move" style={{ padding: "clamp(50px,7vw,76px) 20px", borderBottom: `1px solid ${C.line}` }}>
        <div style={wrap}>
          <div style={eyebrow()}>STEP 3 — MOVING YOUR SITE</div>
          <h2 style={{ ...h2, maxWidth: 720 }}>Free migration means we do it, not that we send you a guide.</h2>
          <div style={{ marginTop: 30, display: "grid", gridTemplateColumns: twoCol, gap: 20 }}>
            <div style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 16, padding: 26 }}>
              <div style={{ fontSize: 18, fontWeight: 800 }}>What we need from you</div>
              <ul style={{ marginTop: 14, display: "grid", gap: 11, listStyle: "none", padding: 0 }}>
                {MIGRATION_NEED.map((n) => <li key={n.n} style={{ display: "flex", gap: 10, fontSize: 15, lineHeight: 1.5, color: C.ink2 }}><span style={{ fontFamily: MONO, color: C.accent, fontWeight: 700 }}>{n.n}</span>{n.t}</li>)}
              </ul>
              <p style={{ marginTop: 14, fontSize: 14, color: C.muted, lineHeight: 1.5 }}>That&apos;s the whole ask. No exports, no zip files, no downtime window to schedule.</p>
            </div>
            <div style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 16, padding: 26 }}>
              <div style={{ fontSize: 18, fontWeight: 800 }}>What we do</div>
              <ul style={{ marginTop: 14, display: "grid", gap: 11, listStyle: "none", padding: 0 }}>
                {MIGRATION_WEDO.map((t) => <li key={t} style={{ display: "flex", gap: 10, fontSize: 15, lineHeight: 1.5, color: C.ink2 }}><span style={{ color: C.success, fontWeight: 800 }}>✓</span>{t}</li>)}
              </ul>
            </div>
          </div>
          <div style={{ marginTop: 20, background: C.accSurf, border: `1px solid ${C.accBorder}`, borderRadius: 16, padding: 24, display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 320px", minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.accentDark }}>If the copy isn&apos;t right, nothing switches</div>
              <p style={{ marginTop: 7, fontSize: 15, lineHeight: 1.55, color: C.ink2 }}>We only change DNS after you have checked the migrated site. Until then your live website keeps serving from your current host, exactly as it does today.</p>
            </div>
            <a href={WHATSAPP_URL} className="hlp-dark" style={{ background: C.ink, color: C.paper, padding: "15px 20px", borderRadius: 11, fontSize: 15, fontWeight: 700, whiteSpace: "nowrap", minHeight: 50, display: "inline-flex", alignItems: "center" }}>Ask about my site</a>
          </div>
        </div>
      </section>

      {/* 9. Worries */}
      <section id="worries" style={{ padding: "clamp(50px,7vw,76px) 20px", background: C.tint, borderBottom: `1px solid ${C.line}` }}>
        <div style={wrap}>
          <div style={eyebrow()}>STEP 4 — WHAT IF</div>
          <h2 style={{ ...h2, maxWidth: 720 }}>The six worries people actually have before switching host.</h2>
          <div style={{ marginTop: 30, display: "grid", gridTemplateColumns: threeCol, gap: 16 }}>
            {HOSTING_WORRIES.map((wr) => (
              <div key={wr.q} style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 14, padding: 22 }}>
                <div style={{ fontSize: 16.5, fontWeight: 800, letterSpacing: "-.02em", color: C.ink }}>{wr.q}</div>
                <p style={{ marginTop: 8, fontSize: 14.5, lineHeight: 1.55, color: C.ink2 }}>{wr.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 10. Proof + testimonials */}
      <section id="proof" style={{ padding: "clamp(50px,7vw,76px) 20px", borderBottom: `1px solid ${C.line}` }}>
        <div style={wrap}>
          <div style={eyebrow()}>DON&apos;T TAKE OUR WORD</div>
          <h2 style={{ ...h2, maxWidth: 720 }}>Check us before you pay us.</h2>
          <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: tripleCol, gap: 16 }}>
            {HOSTING_PROOFS.map((pf) => (
              <div key={pf.k} style={{ border: `1px solid ${C.line}`, background: "#fff", borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".08em", color: C.muted, fontWeight: 700 }}>{pf.k}</div>
                <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-.01em", lineHeight: 1.4 }}>{pf.v}</div>
                <a href={pf.href} style={{ marginTop: "auto", fontSize: 14, fontWeight: 700 }}>{pf.a} →</a>
              </div>
            ))}
          </div>
          {/* Testimonials removed 27 Sep 2026: the three quotes here were placeholders with
              invented names, which is misleading advertising. Real, consented reviews go
              here — Marketing → Google reviews collects them. */}
        </div>
      </section>

      {/* 11. Fit check */}
      <section style={{ padding: "clamp(50px,7vw,76px) 20px", borderBottom: `1px solid ${C.line}` }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <h2 style={{ ...h2, marginTop: 0 }}>We&apos;d rather you know before you pay.</h2>
          <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: twoCol, gap: 20 }}>
            <div style={{ background: C.successSurf, border: `1px solid ${C.successBorder}`, borderRadius: 16, padding: 26 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.success }}>A good fit if you are</div>
              <ul style={{ marginTop: 14, display: "grid", gap: 10, listStyle: "none", padding: 0 }}>
                {HOSTING_GOOD_FIT.map((g) => <li key={g} style={{ display: "flex", gap: 10, fontSize: 15, lineHeight: 1.5 }}><span style={{ color: C.success, fontWeight: 800 }}>✓</span>{g}</li>)}
              </ul>
            </div>
            <div style={{ background: C.tint, border: `1px solid ${C.line}`, borderRadius: 16, padding: 26 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.muted }}>Not the right product if</div>
              <ul style={{ marginTop: 14, display: "grid", gap: 10, listStyle: "none", padding: 0 }}>
                {HOSTING_BAD_FIT.map((b) => <li key={b} style={{ display: "flex", gap: 10, fontSize: 15, lineHeight: 1.5, color: C.ink2 }}><span style={{ color: C.faint, fontWeight: 800 }}>—</span>{b}</li>)}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* 12. Contact channels */}
      <section style={{ padding: "clamp(50px,7vw,76px) 20px", background: C.tint, borderBottom: `1px solid ${C.line}` }}>
        <div style={wrap}>
          <h2 style={{ ...h2, marginTop: 0 }}>Talk to a person first. That&apos;s normal here.</h2>
          <div style={quadGrid}>
            {HOSTING_CHANNELS.map((ch) => (
              <div key={ch.t} style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-.02em" }}>{ch.t}</div>
                <p style={{ fontSize: 14.5, lineHeight: 1.5, color: C.ink2 }}>{ch.d}</p>
                <a href={ch.href} style={{ marginTop: "auto", fontSize: 14.5, fontWeight: 700 }}>{ch.a} →</a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 13. FAQ */}
      <section id="faq" style={{ padding: "clamp(50px,7vw,76px) 20px", borderBottom: `1px solid ${C.line}` }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <h2 style={{ fontSize: "clamp(30px,4.6vw,42px)", letterSpacing: "-.035em", fontWeight: 800 }}>Everything else, answered plainly.</h2>
          <div style={{ marginTop: 28, borderTop: `1px solid ${C.line}` }}>
            {HOSTING_FAQS_V2.map((f, i) => (
              <div key={f.q} style={{ borderBottom: `1px solid ${C.line}` }}>
                <button onClick={() => setOpenFaq((o) => (o === i ? -1 : i))} aria-expanded={openFaq === i}
                  style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 18, background: "transparent", border: 0, padding: "21px 4px", textAlign: "left", fontSize: 17.5, fontWeight: 700, letterSpacing: "-.015em", color: C.ink, minHeight: 56, cursor: "pointer" }}>
                  {f.q}
                  <span style={{ fontFamily: MONO, fontSize: 20, color: C.accent, flexShrink: 0 }}>{openFaq === i ? "−" : "+"}</span>
                </button>
                {openFaq === i && <p style={{ padding: "0 40px 24px 4px", fontSize: 16, lineHeight: 1.62, color: C.ink2, textWrap: "pretty" } as React.CSSProperties}>{f.a}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 14. Final CTA */}
      <section style={{ padding: "clamp(56px,7vw,84px) 20px clamp(70px,8vw,96px)" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto", background: C.accSurf, border: `1px solid ${C.accBorder}`, borderRadius: 22, padding: "clamp(32px,5vw,56px) clamp(22px,4vw,48px)", textAlign: "center" }}>
          <h2 style={{ fontSize: "clamp(30px,5vw,44px)", lineHeight: 1.08, letterSpacing: "-.04em", fontWeight: 800 }}>Try it with your real website. <span style={{ fontFamily: SERIF, fontStyle: "italic", fontWeight: 400, color: C.accent }}>Then decide.</span></h2>
          <p style={{ marginTop: 16, fontSize: 17.5, color: C.ink2, maxWidth: 560, marginLeft: "auto", marginRight: "auto", lineHeight: 1.55 }}>{TRIAL_DAYS} days on {TRIAL_PLAN_NAME}, every feature, no credit card, and our team does the migration while your current site stays live.</p>
          <div style={{ marginTop: 26, display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={startTrialInCart} className="hlp-dark" style={{ background: C.ink, color: C.paper, padding: "16px 28px", borderRadius: 12, fontSize: 16, fontWeight: 700, minHeight: 52, display: "inline-flex", alignItems: "center", border: 0, cursor: "pointer", fontFamily: "inherit" }}>Start the free {TRIAL_PLAN_NAME} trial</button>
            <a href="/quote" className="hlp-outline" style={{ background: "#fff", color: C.ink, border: `1px solid ${C.line}`, padding: "16px 28px", borderRadius: 12, fontSize: 16, fontWeight: 700, minHeight: 52, display: "inline-flex", alignItems: "center" }}>Get a written quote</a>
          </div>
          <div style={{ marginTop: 20, fontSize: 13, color: C.muted, fontFamily: MONO, letterSpacing: ".04em" }}>NO CARD · CANCEL ANYTIME · GST INVOICE ON EVERY ORDER</div>
        </div>
      </section>

    </div>
  );
}
