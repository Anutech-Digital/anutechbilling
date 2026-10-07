"use client";

/**
 * Google Workspace plans and pricing (/google-workspace/pricing) — Pardeep, 4 Oct 2026.
 *
 * Laid out the way Google's own India pricing page is (term switch, one card per plan, then
 * the full feature comparison), because buyers arrive from that page and should find the
 * same plans in the same order. Google's palette inside the block (Pardeep asked for it), but
 * it is OUR page, not a copy of theirs: ANUTECH header, footer and logo around it, our words,
 * INR + GST, and what we add (setup, migration, local support).
 *
 * Prices come from the live catalogue (passed in by the server page). A plan without a
 * flexible price says "annual only" rather than inventing one. Base is not shown: resellers
 * cannot sell it.
 */
import { useMemo, useState, type ReactNode } from "react";
import Link from "@/site/components/ui/SiteLink";
import { buyWorkspaceHref } from "@/lib/checkout/buy-link";
import { FIRST_YEAR_PER_USER, OFFER_MIN_USERS, offerPercentOff } from "@/site/lib/workspace-offer";
import { CONTACT_FOR_PRICING, PLUS_EDITION } from "@/lib/catalog/public-price-policy";
import { WHATSAPP_URL, SLA } from "@/site/lib/config";

export type PlanKey = "starter" | "standard" | "plus" | "enterprise";
export interface PricedPlan {
  key: PlanKey;
  /** Edition name the quote/trial pages know ("GW Business Starter"); null = talk to us. */
  edition: string | null;
  annual: number | null;   // ₹ / user / month on the yearly plan
  monthly: number | null;  // ₹ / user / month, flexible
}

const PLAN_TEXT: Record<PlanKey, { name: string; for: string; highlights: string[]; tag?: string }> = {
  starter: {
    name: "Business Starter",
    for: "Professional email and the essentials",
    highlights: ["30 GB pooled storage per user", "Custom email on your domain", "Meet calls up to 100 people", "Gemini AI in Gmail"],
  },
  standard: {
    name: "Business Standard",
    for: "Growing teams that meet and share a lot",
    tag: "Most popular",
    highlights: ["2 TB pooled storage per user", "Meet up to 150 people + recordings", "Gemini in Docs, Sheets, Meet and Drive", "Appointment booking and eSignature"],
  },
  plus: {
    name: "Business Plus",
    for: "Extra security and compliance",
    highlights: ["5 TB pooled storage per user", "Meet up to 500 people", "Vault: retention and eDiscovery", "Advanced endpoint management"],
  },
  enterprise: {
    name: "Enterprise",
    for: "Large teams and strict security needs",
    highlights: ["5 TB per user, more on request", "Meet up to 1,000 people", "Enterprise security and endpoint controls", "No user limit"],
  },
};
const ORDER: PlanKey[] = ["starter", "standard", "plus", "enterprise"];

type Cell = boolean | string;
const COMPARE: { group: string; rows: [string, Cell, Cell, Cell, Cell][] }[] = [
  { group: "Email", rows: [
    ["Custom email (you@yourcompany.com)", true, true, true, true],
    ["Spam and phishing protection", true, true, true, true],
    ["No ads in the inbox", true, true, true, true],
  ] },
  { group: "Storage", rows: [
    ["Pooled storage per user", "30 GB", "2 TB", "5 TB", "5 TB +"],
    ["Drive for desktop", true, true, true, true],
  ] },
  { group: "Meet video calls", rows: [
    ["People per call", "100", "150", "500", "1,000"],
    ["Longest call", "24 hours", "24 hours", "24 hours", "24 hours"],
    ["Recordings saved to Drive", false, true, true, true],
    ["Noise cancellation", false, true, true, true],
  ] },
  { group: "Gemini AI", rows: [
    ["Gemini in Gmail", true, true, true, true],
    ["Gemini in Docs, Sheets, Slides, Meet, Drive and Chat", false, true, true, true],
    ["Gemini app", "Basic", "Expanded", "Expanded", "Expanded"],
    ["NotebookLM", "Basic", "Expanded", "Expanded", "Expanded"],
  ] },
  { group: "Calendar, Docs and more", rows: [
    ["Shared calendars", true, true, true, true],
    ["Appointment booking pages", false, true, true, true],
    ["eSignature in Docs and PDFs", false, true, true, true],
    ["Docs, Sheets, Slides, Forms, Sites", true, true, true, true],
    ["Opens and edits Office files", true, true, true, true],
  ] },
  { group: "Security and admin", rows: [
    ["2-step verification", true, true, true, true],
    ["Group-based policies", true, true, true, true],
    ["Vault (retention, eDiscovery)", false, false, true, true],
    ["Endpoint management", "Fundamental", "Fundamental", "Advanced", "Enterprise"],
    ["Users per account", "Up to 300", "Up to 300", "Up to 300", "No limit"],
  ] },
  { group: "From ANUTECH, on every plan", rows: [
    ["GST invoice in INR (input credit)", true, true, true, true],
    ["Setup: domain, MX records, users", "Free", "Free", "Free", "Free"],
    ["Migration of old mail, contacts, calendar", "Free", "Free", "Free", "Free"],
    ["Support on phone and WhatsApp, Hindi / English", true, true, true, true],
  ] },
];

const FAQ: [string, string][] = [
  ["What is a user?", "One person with their own email address and login. Shared addresses like info@ or sales@ can usually be free aliases or groups instead of paid users — we will set that up for you."],
  ["Annual or flexible — which one?", "Annual is cheaper per month and fixes the price for 12 months; you can add users any time but not reduce them until renewal. Flexible is billed month to month and you can add or remove users whenever you like."],
  ["Do I get a GST invoice?", "Yes. Every order gets a GST invoice in INR from ANUTECH DIGITAL PVT LTD, so a GST-registered business can claim input tax credit."],
  ["Can I change plans later?", "Yes. You can move up to a bigger plan at any time; we handle the change and adjust the bill."],
  [`How does the ${OFFER_MIN_USERS}+ user offer work?`, `A new Google Workspace account with ${OFFER_MIN_USERS} or more users can get Business Starter at ₹${FIRST_YEAR_PER_USER.toLocaleString("en-IN")} per user for the first year, with Google's approval (it is usually given). From the second year it renews at the normal annual price.`],
  ["Why buy through ANUTECH instead of Google directly?", "Same Google product and the same Google data centres. You also get an Indian GST invoice, free setup and migration, and a team you can call or WhatsApp in Hindi or English."],
];

/** "Google" in Google’s letter colours, "Workspace" in grey — the product’s own wordmark style. */
const G_COLOURS = ["#4285F4", "#EA4335", "#FBBC04", "#4285F4", "#34A853", "#EA4335"];
export function WorkspaceWordmark({ size = "1em" }: { size?: string }) {
  return (
    <span className="wp-wordmark" style={{ fontSize: size, whiteSpace: "nowrap" }}>
      {"Google".split("").map((c, i) => <span key={i} style={{ color: G_COLOURS[i] }}>{c}</span>)}
      <span style={{ color: "#5F6368" }}> Workspace</span>
    </span>
  );
}

/** The app row above the title, like Google’s own page: Gmail, Calendar, Drive, Docs, Meet, Gemini. */
export function WorkspaceAppIcons() {
  // eslint-disable-next-line @next/next/no-img-element -- next.config images.unoptimized: next/image would serve it unchanged (R-331)
  const img = (src: string, alt: string) => <img src={src} alt={alt} width={28} height={28} style={{ width: 28, height: 28, objectFit: "contain" }} />;
  return (
    <div className="wp-icons" style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }} aria-label="Gmail, Calendar, Drive, Docs, Meet and Gemini">
      {img("/ic-gmail.png", "Gmail")}
      {img("/ic-calendar.png", "Calendar")}
      {img("/ic-drive.png", "Drive")}
      <svg width="22" height="28" viewBox="0 0 22 28" role="img" aria-label="Docs">
        <path d="M2 0h12l8 8v18a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2z" fill="#4285F4" />
        <path d="M14 0l8 8h-6a2 2 0 0 1-2-2z" fill="#A1C2FA" />
        <rect x="5" y="13" width="12" height="2" rx="1" fill="#fff" /><rect x="5" y="17" width="12" height="2" rx="1" fill="#fff" /><rect x="5" y="21" width="8" height="2" rx="1" fill="#fff" />
      </svg>
      {img("/ic-meet.png", "Meet")}
      {img("/ic-gemini.png", "Gemini")}
    </div>
  );
}

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

export function WorkspacePricing({ plans, head, intro }: {
  plans: PricedPlan[];
  /** Title block — kept on screen with the term and users controls while the page scrolls. */
  head?: ReactNode;
  intro?: ReactNode;
}) {
  const [term, setTerm] = useState<"annual" | "monthly">("annual");
  const [users, setUsers] = useState(1);
  /* Phones compare ONE plan at a time (a 4-column table there needs side-scrolling and
     reads as noise — Pardeep, 4 Oct). Desktop always shows every column. */
  const [cmp, setCmp] = useState(0);
  const byKey = useMemo(() => new Map(plans.map((p) => [p.key, p])), [plans]);
  /* R-328 (7 Oct 2026, Pardeep): Business Plus shows no price — Google's own page does not
     either. Whatever figure a caller passes, the card says "Contact us for pricing" and
     offers a quote / WhatsApp, never Buy now. */
  const shown = ORDER.map((k) => byKey.get(k)).filter((p): p is PricedPlan => !!p)
    .map((p) => (p.key === "plus" ? { ...p, edition: PLUS_EDITION, annual: null, monthly: null } : p));
  const cols = shown.map((p) => ORDER.indexOf(p.key));

  /* "Save up to N%" — the best annual-vs-flexible saving among plans that have both. */
  const save = Math.max(0, ...shown.map((p) => (p.annual && p.monthly && p.monthly > p.annual ? Math.round((1 - p.annual / p.monthly) * 100) : 0)));
  const starter = byKey.get("starter");
  const starterYear = starter?.annual ? starter.annual * 12 : 0;
  const offPct = offerPercentOff(starterYear);
  const offerOn = term === "annual" && users >= OFFER_MIN_USERS && offPct > 0;

  return (
    <div className="wp-root">
      <style>{CSS}</style>

      {/* Title + term + users stay under the site header while plans scroll (Pardeep, 4 Oct).
          The root wraps the whole component, so this sticks until the FAQ ends. */}
      <div className="wp-top">
      {head}
      <div className="wp-controls">
        <div className="wp-term" role="radiogroup" aria-label="Billing term">
          <button type="button" role="radio" aria-checked={term === "annual"} className={term === "annual" ? "on" : ""} onClick={() => setTerm("annual")}>
            <span className="wp-term-l">Annual<small>Billed annually</small></span>{save > 0 && <span className="wp-save"><span className="wp-long">Save up to </span><span className="wp-short">−</span>{save}%</span>}
          </button>
          <button type="button" role="radio" aria-checked={term === "monthly"} className={term === "monthly" ? "on" : ""} onClick={() => setTerm("monthly")}>
            <span className="wp-term-l"><span className="wp-long">Flexible</span><span className="wp-short">Monthly</span><small>Billed monthly</small></span>
          </button>
        </div>
        <label className="wp-users">
          <span className="wp-users-l">Users</span>
          <button type="button" aria-label="One user fewer" onClick={() => setUsers((n) => Math.max(1, n - 1))}>−</button>
          <input type="number" min={1} max={300} value={users} aria-label="Number of users"
            onChange={(e) => setUsers(Math.max(1, Math.min(300, Number(e.target.value) || 1)))} />
          <button type="button" aria-label="One user more" onClick={() => setUsers((n) => Math.min(300, n + 1))}>+</button>
        </label>
      </div>
      </div>
      <p className="wp-fine">Prices per user per month in INR, excluding 18% GST.</p>
      {intro}

      <div className="wp">

      <div className="wp-cards" style={{ ["--n" as string]: shown.length }}>
        {shown.map((p) => {
          const t = PLAN_TEXT[p.key];
          const rate = term === "annual" ? p.annual : p.monthly;
          const isStarterOffer = p.key === "starter" && offerOn;
          const yearTotal = rate == null ? null : isStarterOffer ? FIRST_YEAR_PER_USER * users : rate * 12 * users;
          const edition = p.edition;
          const onRequest = p.key === "plus";
          /* R-232: the online checkout sells the annual plan only; flexible stays quote-first. */
          const buyHref = edition != null && term === "annual" && p.annual != null ? buyWorkspaceHref(edition, users) : null;
          return (
            <article key={p.key} className={`wp-card${t.tag ? " wp-pop" : ""}`}>
              {t.tag && <span className="wp-tag">{t.tag}</span>}
              <span className="wp-brand"><WorkspaceWordmark /></span>
              <h3>{t.name}</h3>
              <p className="wp-for">{t.for}</p>

              <div className="wp-price">
                {edition == null ? (
                  <b className="wp-talk">Let&apos;s talk</b>
                ) : onRequest ? (
                  <><b className="wp-talk">{CONTACT_FOR_PRICING}</b><small>We send the price for your team {SLA.quote}</small></>
                ) : rate == null ? (
                  <><b className="wp-talk">Annual only</b><small>Switch to Annual to see the price</small></>
                ) : (
                  <><b>{inr(rate)}</b><span>/user/month</span></>
                )}
              </div>
              {edition != null && rate != null && (
                <p className="wp-total">
                  {term === "annual" ? `Billed annually · ${inr(rate * 12)}/user/year` : "Billed monthly"} · {users} {users === 1 ? "user" : "users"}:{" "}
                  <b>{inr(yearTotal ?? 0)}{term === "annual" ? "/year" : ""}</b>{term === "monthly" ? <> <b>{inr(rate * users)}/month</b></> : null}
                </p>
              )}

              {p.key === "starter" && term === "annual" && offPct > 0 && (
                <div className={`wp-offer${offerOn ? " on" : ""}`}>
                  <span className="wp-off">{offPct}% OFF</span>
                  <span>
                    {OFFER_MIN_USERS}+ users, new account: <b>{inr(FIRST_YEAR_PER_USER)}/user</b> for the first year
                    {offerOn ? " — applied above." : <> · <button type="button" className="wp-link" onClick={() => setUsers(OFFER_MIN_USERS)}>See {OFFER_MIN_USERS} users</button></>}
                    <small>With Google&apos;s approval (usually given). Renews at {inr(starterYear)}/user/year.</small>
                  </span>
                </div>
              )}

              <div className="wp-cta">
                {edition == null ? (
                  <Link href="/contact" className="wp-btn wp-primary">Talk to us</Link>
                ) : onRequest ? (
                  <>
                    <Link href={`/quote?${q({ ed: edition, seats: String(users), term })}`} className="wp-btn wp-primary">Get a quote</Link>
                    <a href={`${WHATSAPP_URL}?text=${encodeURIComponent(`Hi Anutech — please send the Google Workspace Business Plus price for ${users} user${users === 1 ? "" : "s"} (${term}).`)}`} target="_blank" rel="noopener" className="wp-btn wp-ghost">Ask on WhatsApp</a>
                  </>
                ) : buyHref ? (
                  /* R-232: ready to pay → Razorpay checkout with this edition and seat count chosen. */
                  <>
                    <Link href={buyHref} className="wp-btn wp-primary">Buy now</Link>
                    <Link href={`/quote?${q({ ed: edition, seats: String(users), term })}`} className="wp-btn wp-ghost">Get a GST quote</Link>
                    <Link href={`/trial?${q({ ed: edition })}`} className="wp-sub">or start a free 14-day trial</Link>
                  </>
                ) : (
                  <>
                    <Link href={`/quote?${q({ ed: edition, seats: String(users), term })}`} className="wp-btn wp-primary">Get this plan</Link>
                    <Link href={`/trial?${q({ ed: edition })}`} className="wp-btn wp-ghost">Free 14-day trial</Link>
                  </>
                )}
              </div>

              <ul className="wp-hl">
                {t.highlights.map((h) => <li key={h}>{h}</li>)}
              </ul>
            </article>
          );
        })}
      </div>

      <section className="wp-compare" aria-labelledby="wp-compare-h">
        <h2 id="wp-compare-h">Compare all features</h2>
        <div className="wp-pick" role="tablist" aria-label="Plan to compare">
          {shown.map((p, i) => (
            <button key={p.key} type="button" role="tab" aria-selected={cmp === i} className={cmp === i ? "on" : ""} onClick={() => setCmp(i)}>
              {PLAN_TEXT[p.key].name.replace(/^Business /, "")}
            </button>
          ))}
        </div>
        <div className="wp-table-wrap">
          <table className="wp-table">
            <thead>
              <tr>
                <th scope="col"><span className="wp-sr">Feature</span></th>
                {shown.map((p, j) => <th key={p.key} scope="col" className={j === cmp ? "" : "wp-m-hide"}><span className="wp-brand"><WorkspaceWordmark /></span>{PLAN_TEXT[p.key].name}</th>)}
              </tr>
            </thead>
            {COMPARE.map((g) => (
              <tbody key={g.group}>
                <tr className="wp-group"><th scope="rowgroup" colSpan={shown.length + 1}>{g.group}<span className="wp-m-only"> · {PLAN_TEXT[shown[cmp]?.key ?? "starter"].name.replace(/^Business /, "")}</span></th></tr>
                {g.rows.map(([label, ...vals]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    {cols.map((i, j) => {
                      const v = vals[i];
                      return (
                        <td key={i} className={j === cmp ? "" : "wp-m-hide"}>
                          {v === true ? <span className="wp-yes" aria-label="Included">✓</span>
                            : v === false ? <span className="wp-no" aria-label="Not included">—</span>
                            : v}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
        <p className="wp-fine">Feature list as published by Google for India, October 2026. Google may change features; we will tell you before your renewal if anything you use changes.</p>
      </section>

      <section className="wp-faq" aria-labelledby="wp-faq-h">
        <h2 id="wp-faq-h">Questions about pricing</h2>
        {FAQ.map(([qq, a]) => (
          <details key={qq}><summary>{qq}</summary><p>{a}</p></details>
        ))}
      </section>
    </div>
    </div>
  );
}

const CSS = `
.wp-root{--wp-blue:#0B57D0;--wp-blue-h:#0842A0;--wp-blue-soft:#D3E3FD;--wp-bg:#F0F4F9;--wp-ink:#1F1F1F;--wp-line:#C4C7C5;--wp-hair:#E1E3E1;--wp-muted:#444746;--wp-green:#146C2E;--wp-green-bg:#C4EED0;color:var(--wp-ink)}
.wp{background:var(--wp-bg);border-radius:28px;padding:24px;margin-top:18px}
.wp-top{position:sticky;top:68px;z-index:30;background:#fff;padding:12px 4px;margin-inline:-4px;box-shadow:0 8px 12px -12px rgba(60,64,67,.35)}
.anutech-site .wp-top h1{margin:10px 0 12px;font-size:clamp(26px,4vw,40px)}
.wp-controls{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between}
.wp-term{display:inline-flex;background:#fff;border:1px solid var(--wp-line);border-radius:999px;padding:4px;gap:4px}
.wp-term button{border:0;background:transparent;border-radius:999px;padding:10px 18px;font:inherit;font-size:15px;font-weight:700;color:var(--wp-muted);cursor:pointer;display:inline-flex;align-items:center;gap:8px;min-height:44px}
.wp-term button.on{background:var(--wp-blue);color:#fff}
.wp-save{white-space:nowrap;font-size:12px;font-weight:800;background:var(--wp-green-bg);color:var(--wp-green);border-radius:999px;padding:2px 8px}
.wp-term button.on .wp-save{background:rgba(255,255,255,.2);color:#fff}
.wp-users{display:inline-flex;align-items:center;gap:6px;font-weight:700}
.wp-users span{margin-right:4px}
.wp-users button{width:40px;height:40px;border-radius:10px;border:1px solid var(--wp-line);background:#fff;font-size:20px;font-weight:800;cursor:pointer;color:var(--wp-ink)}
.wp-users input{width:72px;height:40px;text-align:center;border:1px solid var(--wp-line);border-radius:10px;font:inherit;font-size:16px;font-weight:800}
.wp-users button:focus-visible,.wp-users input:focus-visible,.wp-term button:focus-visible,.wp-faq summary:focus-visible,.wp-link:focus-visible{outline:3px solid var(--wp-blue);outline-offset:2px}
.wp-fine{font-size:13px;color:var(--wp-muted);margin:10px 0 0}
.wp-cards{display:grid;grid-template-columns:repeat(var(--n,4),minmax(0,1fr));gap:16px;margin-top:22px;align-items:stretch}
.wp-card{position:relative;background:#fff;border:1px solid var(--wp-hair);border-radius:24px;padding:24px 20px;display:flex;flex-direction:column;gap:10px}
.wp-pop{border:2px solid var(--wp-blue);box-shadow:0 1px 3px rgba(60,64,67,.15),0 4px 8px 3px rgba(60,64,67,.1)}
.wp-tag{position:absolute;top:-12px;left:20px;background:var(--wp-blue);color:#fff;font-size:12px;font-weight:800;border-radius:999px;padding:3px 12px}
.wp-brand{display:block;font-size:14px;font-weight:600;letter-spacing:-.01em;margin-bottom:-6px}
.wp-table thead .wp-brand{font-size:12px;margin:0 0 2px}
.wp-card h3{margin:0;font-size:24px;font-weight:600;letter-spacing:-.01em}
.wp-for{margin:0;color:var(--wp-muted);font-size:14px;min-height:2.6em}
.wp-price{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;min-height:48px}
.wp-price b{font-size:36px;font-weight:600;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.wp-price span{color:var(--wp-muted);font-weight:600}
.wp-price .wp-talk{font-size:28px}
.wp-price small{flex-basis:100%;color:var(--wp-muted);font-size:13px}
.wp-total{margin:0;font-size:13px;color:var(--wp-muted);font-variant-numeric:tabular-nums}
.wp-total b{color:var(--wp-ink)}
.wp-offer{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.45;background:#FFF6F5;border:1px dashed #F4B4AE;border-radius:12px;padding:10px}
.wp-offer.on{background:#E6F4EA;border-color:#6DD58C}
.wp-offer small{display:block;color:var(--wp-muted);margin-top:2px}
.wp-off{flex:none;background:#B3261E;color:#fff;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:800}
.wp-offer.on .wp-off{background:var(--wp-green)}
.wp-link{border:0;background:none;padding:0;font:inherit;color:var(--wp-blue);font-weight:800;text-decoration:underline;cursor:pointer}
.wp-cta{display:grid;gap:8px;margin-top:4px}
.wp-sub{display:block;text-align:center;font-size:14px;font-weight:700;color:var(--wp-blue);text-decoration:underline;padding:6px 0}.wp-sub:focus-visible{outline:3px solid var(--wp-blue);outline-offset:2px}
.wp-btn{display:flex;align-items:center;justify-content:center;min-height:46px;border-radius:999px;font-weight:800;text-decoration:none;font-size:15px}
.wp-primary{background:var(--wp-blue);color:#fff}.wp-primary:hover{background:var(--wp-blue-h);box-shadow:0 1px 3px rgba(60,64,67,.3)}
.wp-ghost{border:1px solid var(--wp-line);color:var(--wp-blue);background:#fff}.wp-ghost:hover{background:#F8FAFD;border-color:var(--wp-blue)}
.wp-hl{list-style:none;margin:8px 0 0;padding:14px 0 0;border-top:1px solid var(--wp-hair);display:grid;gap:8px;font-size:14px}
.wp-hl li{padding-left:24px;position:relative}
.wp-hl li::before{content:"✓";position:absolute;left:0;color:var(--wp-blue);font-weight:900}
.wp-compare{margin-top:56px}
.wp-compare h2,.wp-faq h2{font-size:32px;font-weight:500;letter-spacing:-.02em;margin:0 0 16px}
.wp-table-wrap{overflow-x:auto;border:1px solid var(--wp-hair);border-radius:24px;background:#fff}
.wp-table{width:100%;border-collapse:collapse;min-width:720px;font-size:14px}
.wp-table thead th{position:sticky;top:0;background:#fff;font-size:15px;font-weight:800;padding:16px 12px;border-bottom:1px solid var(--wp-line);text-align:center}
.wp-table thead th:first-child{text-align:left}
.wp-table th[scope=row]{text-align:left;font-weight:600;padding:12px;width:34%}
.wp-table td{text-align:center;padding:12px;border-top:1px solid var(--wp-hair);font-variant-numeric:tabular-nums}
.wp-table tbody tr:not(.wp-group) th{border-top:1px solid var(--wp-hair)}
.wp-group th{background:#F8FAFD;text-align:left;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--wp-blue);padding:10px 12px}
.wp-yes{color:var(--wp-blue);font-weight:900;font-size:16px}
.wp-no{color:#8E918F}
.wp-term-l{display:inline-flex;flex-direction:column;align-items:flex-start;line-height:1.15}
.wp-term-l small{font-size:12px;font-weight:600;opacity:.8}
.wp-short{display:none}
.wp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.wp-pick{display:none}
.wp-m-only{display:none}
.wp-faq{margin-top:56px;max-width:860px;display:grid;gap:10px}
.wp-faq details{background:#fff;border:1px solid var(--wp-hair);border-radius:16px}
.wp-faq summary{cursor:pointer;padding:16px 18px;font-weight:700;list-style:none}
.wp-faq summary::-webkit-details-marker{display:none}
.wp-faq summary::after{content:"+";float:right;color:var(--wp-blue);font-size:20px;line-height:1}
.wp-faq details[open] summary::after{content:"−"}
.wp-faq p{margin:0;padding:0 18px 16px;color:var(--wp-muted)}
@media(max-width:1000px){.wp-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:620px){.wp{padding:16px 12px;border-radius:20px}.wp-top{padding:8px 4px}.anutech-site .wp-top h1{margin:6px 0 8px;font-size:21px;letter-spacing:-.01em}.wp-controls{gap:8px}.wp-cards{grid-template-columns:1fr}.wp-icons{display:none!important}.wp-term-l small{font-size:10px;white-space:nowrap}.wp-term{gap:2px;padding:3px}.wp-long{display:none}.wp-short{display:inline}.wp-controls{flex-wrap:nowrap;justify-content:space-between}.wp-term button{padding:5px 9px;font-size:14px;min-height:42px;gap:5px}.wp-save{display:none}.wp-users{gap:4px}.wp-users-l{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.wp-users button{width:30px;height:36px}.wp-users input{width:42px;height:36px}.wp-for{min-height:0}
.wp-pick{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;background:#fff;border:1px solid var(--wp-line);border-radius:999px;padding:4px;margin-bottom:12px}
.wp-pick button{border:0;background:transparent;border-radius:999px;min-height:40px;font:inherit;font-size:13px;font-weight:700;color:var(--wp-muted);cursor:pointer}
.wp-pick button.on{background:var(--wp-blue);color:#fff}
.wp-table{min-width:0}.wp-m-hide{display:none}.wp-m-only{display:inline;color:var(--wp-ink)}
.wp-table th[scope=row]{width:auto}.wp-table td{width:42%}
.wp-table thead .wp-brand{display:none}
.wp-compare h2,.wp-faq h2{font-size:24px}}
`;
