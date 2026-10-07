"use client";

/**
 * Google Ads landing page — Google Workspace (R-139, 4 Oct 2026).
 *
 * Layout and copy follow Pardeep's brief (Google_Workspace_Landing_Page_1.zip): own small
 * header, hero with photo, apps strip, benefits beside the offer card, trust, final CTA,
 * footer, and an enquiry modal. What the audit changed, and why:
 *   • PRICE from the live catalogue (₹270/user/month = ₹3,240/year, Business Starter) — the
 *     brief's "₹3,080 our price / ₹3,240 Google price / save ₹160" used the WHOLESALE cost as
 *     the selling price. No strike-through: we sell at Google's list price.
 *   • The FORM creates the lead in the app first (with the ad's gclid/utm), then offers
 *     WhatsApp. The brief only opened WhatsApp, so a visitor without it was a lost lead and
 *     no ad could be credited.
 *   • PHOTO cropped: the original carried cut-off text at the edge and a baked-in
 *     "24/7 Support" claim (support is Mon–Sat 10–19).
 *   • Real Gmail / Drive / Meet / Calendar icons instead of letters.
 *   • BUY NOW opens the same form while online Workspace checkout is paused (Pardeep,
 *     4 Oct 2026, until all prices are in the catalogue). Flip BUY_ONLINE to send it to
 *     checkout.
 * The plan is a prop (lib/lp-plans.ts): one page per Workspace plan, the Starter offer only
 * on Starter. Hero copy is an optional prop so ad variants can bring their own.
 *
 * LANGUAGE (R-396, 7 Oct 2026): every visible word comes from lp-copy.ts in English or
 * Hinglish. English by default; the page (server) reads `?lang=hi` and passes `lang`, so an
 * ad linking to the Hinglish page renders Hinglish with no flash. The "English | Hinglish"
 * toggle in the header switches it and remembers the choice (localStorage, try/catch).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buyWorkspaceHref } from "@/lib/checkout/buy-link";
import { WHATSAPP_NUMBER, WHATSAPP_READY, COMPANY } from "@/site/lib/config";
import { useTurnstile } from "@/components/shared/turnstile";
import { pickAdParams, withAdParams, rememberLanding } from "@/site/lib/ad-attribution";
import { reportLeadConversion } from "@/site/lib/google-ads";
import { FIRST_YEAR_PER_USER, OFFER_MIN_USERS } from "@/site/lib/workspace-offer";
import { LP_PLANS, type LpPlan } from "@/site/lib/lp-plans";
import { CONTACT_FOR_PRICING } from "@/lib/catalog/public-price-policy";
import {
  LP_DEFAULT_LANG, LP_LANG_STORE, LP_TEXT, parseLpLang,
  type LpDict, type LpLang, type Rich, type WorkspaceAdCopy,
} from "./lp-copy";

export type { WorkspaceAdCopy, LpLang } from "./lp-copy";

/** One row of the category page's plan grid: the plan and its live yearly ₹/user/month. */
export interface LpPlanPrice { plan: LpPlan; annual: number | null }

/** Online checkout for Workspace — off until every edition's price is confirmed (see header). */
const BUY_ONLINE = false;

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const PHONE_SHOWN = WHATSAPP_NUMBER.replace(/^91/, "");
const waLink = (text: string) => `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
const RichText = ({ r }: { r: Rich }) => <>{r[0]}<b>{r[1]}</b>{r[2]}</>;

const APPS: { name: string; icon?: string; tile?: { bg: string; label: string } }[] = [
  { name: "Gmail", icon: "/ic-gmail.png" },
  { name: "Drive", icon: "/ic-drive.png" },
  { name: "Meet", icon: "/ic-meet.png" },
  { name: "Docs", tile: { bg: "#4285F4", label: "D" } },
  { name: "Sheets", tile: { bg: "#34A853", label: "S" } },
  { name: "Slides", tile: { bg: "#F9AB00", label: "P" } },
  { name: "Calendar", icon: "/ic-calendar.png" },
];

export function WorkspaceAdLanding({
  annualPerSeatMo, plan = LP_PLANS.starter, copy, allPlans, lang: initialLang = LP_DEFAULT_LANG,
}: {
  /** The plan's ₹ per user per month on the yearly plan (live catalogue); null = talk to us. */
  annualPerSeatMo: number | null;
  plan?: LpPlan;
  copy?: WorkspaceAdCopy;
  /** Category page only: every plan, shown as a grid under the price card. */
  allPlans?: readonly LpPlanPrice[];
  /** From the page's `?lang=` (server side) so the first paint is already in that language. */
  lang?: LpLang;
}) {
  const [lang, setLang] = useState<LpLang>(initialLang);
  const t = LP_TEXT[lang];
  const planText = t.plans[plan.key];
  const text = copy ?? (plan.category ? t.categoryHero : planText.hero);
  const priced = annualPerSeatMo != null && annualPerSeatMo > 0;
  const hasOffer = plan.offer && priced;
  const [ad, setAd] = useState<URLSearchParams>(new URLSearchParams());
  const [landing, setLanding] = useState("");
  const [modal, setModal] = useState<null | "buy" | "trial">(null);
  /** Category page: the plan a grid card asked about (null = this page's own plan). */
  const [modalPlan, setModalPlan] = useState<LpPlan | null>(null);
  const [users, setUsers] = useState(1);
  const [exitOffer, setExitOffer] = useState(false);

  /* Language: the URL's ?lang= wins (the server already rendered it); otherwise the visitor's
     last choice on this device. Storage can throw (private mode, blocked site data). */
  useEffect(() => {
    const fromUrl = parseLpLang(new URLSearchParams(window.location.search).get("lang"));
    if (fromUrl) { setLang(fromUrl); return; }
    let saved: LpLang | null = null;
    try { saved = parseLpLang(window.localStorage.getItem(LP_LANG_STORE)); } catch { saved = null; }
    if (saved) setLang(saved);
  }, []);
  const chooseLang = useCallback((next: LpLang) => {
    setLang(next);
    try { window.localStorage.setItem(LP_LANG_STORE, next); } catch { /* private mode */ }
    /* A ?lang= in the address would undo the choice on reload — keep it in step. */
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.has("lang")) {
        u.searchParams.set("lang", next === "hinglish" ? "hi" : "en");
        window.history.replaceState(window.history.state, "", u.toString());
      }
    } catch { /* ignore */ }
  }, []);

  /* Desktop only: the pointer leaving through the top of the window is the classic "about to
     close the tab" signal. Shown once per visit, never on phones, never over an open form. */
  useEffect(() => {
    if (window.matchMedia("(max-width: 900px)").matches) return;
    let shown = false;
    try { shown = sessionStorage.getItem("anutech.lp.exit.v1") === "1"; } catch { /* private mode */ }
    if (shown) return;
    const onOut = (e: MouseEvent) => {
      if (e.clientY > 8 || e.relatedTarget) return;
      document.removeEventListener("mouseout", onOut);
      try { sessionStorage.setItem("anutech.lp.exit.v1", "1"); } catch { /* ignore */ }
      setExitOffer(true);
    };
    const tm = setTimeout(() => document.addEventListener("mouseout", onOut), 8000);   // not on a quick bounce
    return () => { clearTimeout(tm); document.removeEventListener("mouseout", onOut); };
  }, []);
  useEffect(() => {
    if (!exitOffer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExitOffer(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [exitOffer]);

  useEffect(() => {
    let store: Storage | null = null;
    try { store = window.sessionStorage; } catch { store = null; }
    const first = rememberLanding(window.location.href, store);
    setLanding(first);
    setAd(pickAdParams(first.includes("?") ? first.slice(first.indexOf("?")) : ""));
  }, []);

  const checkoutHref = useMemo(() => withAdParams((plan.edition ? buyWorkspaceHref(plan.edition, users) : null) ?? "/buy/workspace", ad), [ad, plan.edition, users]);
  const yearly = (annualPerSeatMo ?? 0) * 12;              // list price = renewal price
  const offerYear = Math.min(FIRST_YEAR_PER_USER, yearly);
  const offerMo = offerYear / 12;
  const offPct = Math.round((1 - offerYear / yearly) * 100);
  const offerOn = hasOffer && users >= OFFER_MIN_USERS;
  const perUserYear = offerOn ? offerYear : yearly;
  const wa = waLink(t.wa.want(plan.name));

  /** Enterprise has no list price, so no checkout: the button asks for a quote instead. */
  const buyOnline = BUY_ONLINE && priced && !!plan.edition;
  const buyLabel = priced ? t.btn.buyNow : t.btn.getQuote;
  const BuyButton = ({ className = "" }: { className?: string }) =>
    buyOnline
      ? <a className={`gw-btn gw-buy ${className}`} href={checkoutHref}>{t.btn.buyNow} <span aria-hidden>→</span></a>
      : <button type="button" className={`gw-btn gw-buy ${className}`} onClick={() => setModal("buy")}>{buyLabel} <span aria-hidden>→</span></button>;
  const TrialButton = ({ className = "" }: { className?: string }) =>
    <button type="button" className={`gw-btn gw-trial ${className}`} onClick={() => setModal("trial")}>{t.btn.startTrial} <span aria-hidden>→</span></button>;
  const compare = t.compare.rows(plan.storage, plan.meetPeople);
  const faqs = t.faq.items({ plan: plan.name, usersLimit: planText.usersLimit, offer: plan.offer, offerPrice: inr(FIRST_YEAR_PER_USER) });

  return (
    <div className="gw" lang={t.htmlLang} data-lang={lang}>
      <style>{CSS}</style>

      <header className="gw-top">
        <div className="gw-wrap gw-nav">
          {/* eslint-disable-next-line @next/next/no-img-element -- next.config images.unoptimized: next/image would serve it unchanged (R-331) */}
          <a href="#top" aria-label="ANUTECH Digital"><img src="/lp/anutech-logo.png" alt="ANUTECH Digital Pvt Ltd" className="gw-logo" width={210} height={70} /></a>
          <nav className="gw-links" aria-label={t.nav.onThisPage}>
            <a href="#features">{t.nav.features}</a>{allPlans && <a href="#plans">{t.nav.plans}</a>}<a href="#offer">{t.nav.price}</a><a href="#compare">{t.nav.compare}</a><a href="#faq">{t.nav.faq}</a>
          </nav>
          <div className="gw-nav-actions">
            <div className="gw-lang" role="group" aria-label={t.langToggleLabel}>
              <button type="button" lang="en" aria-pressed={lang === "en"} onClick={() => chooseLang("en")}>English</button>
              <button type="button" lang="hi-Latn" aria-pressed={lang === "hinglish"} onClick={() => chooseLang("hinglish")}>Hinglish</button>
            </div>
            {WHATSAPP_READY && <a className="gw-mini gw-mini-wa" href={wa} target="_blank" rel="noopener">{t.btn.whatsapp}</a>}
            <a className="gw-mini gw-mini-primary" href="#offer">{hasOffer ? t.nav.viewOffer : t.nav.seePrice}</a>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="gw-hero">
          <div className="gw-wrap gw-hero-grid">
            <div>
              <span className="gw-eyebrow">✓ {text.eyebrow}</span>
              <h1 className="gw-h1"><span className="gw-google">Google</span> {text.h1Rest}</h1>
              <h2 className="gw-h2">{text.h2}</h2>
              <p className="gw-copy">{text.sub}</p>
              <div className="gw-buttons">
                <BuyButton />
                <TrialButton />
                {WHATSAPP_READY && <a className="gw-btn gw-wa" href={wa} target="_blank" rel="noopener">{t.btn.whatsapp} {PHONE_SHOWN}</a>}
              </div>
              <ul className="gw-ticks">
                {t.hero.ticks.map((x) => <li key={x}>{x}</li>)}
              </ul>
              <p className="gw-note">
                {hasOffer
                  ? <RichText r={t.hero.noteOffer(OFFER_MIN_USERS, inr(offerMo))} />
                  : priced ? <RichText r={t.hero.notePrice(plan.name, inr(annualPerSeatMo!))} /> : <>{t.hero.noteQuote(plan.name)}</>}
                {" "}· {COMPANY.partnerLine}
              </p>
              <CallbackForm t={t} landing={landing} plan={plan} />
            </div>
            <div className="gw-visual">
              {hasOffer ? (
              <aside className="gw-promo" aria-label={t.promo.offerAria}>
                <span className="gw-promo-tag">{t.promo.tagOffer(OFFER_MIN_USERS)}</span>
                <div className="gw-promo-main">
                  <div className="gw-promo-zero" aria-hidden><b>{offPct}%</b><small>{t.promo.off}</small></div>
                  <div>
                    <p className="gw-promo-h">{t.promo.firstYear} <s>{inr(yearly)}</s> {inr(offerYear)}<span className="gw-promo-unit">{t.promo.perUser}</span></p>
                    <p className="gw-promo-s"><RichText r={t.promo.offerBody} /></p>
                  </div>
                </div>
                <div className="gw-promo-foot">
                  <button type="button" className="gw-promo-btn" onClick={() => { setUsers((n) => Math.max(n, OFFER_MIN_USERS)); setModal("buy"); }}>{t.promo.offerBtn} <span aria-hidden>→</span></button>
                </div>
              </aside>
              ) : (
              <aside className="gw-promo" aria-label={t.promo.plainAria}>
                <span className="gw-promo-tag">{plan.name}</span>
                <div className="gw-promo-main">
                  <div className="gw-promo-zero" aria-hidden><b>₹0</b><small>{t.promo.setup}</small></div>
                  <div>
                    <p className="gw-promo-h">{t.promo.plainHead}</p>
                    <p className="gw-promo-s"><RichText r={t.promo.plainBody} /></p>
                  </div>
                </div>
                <div className="gw-promo-foot">
                  <button type="button" className="gw-promo-btn" onClick={() => setModal(priced ? "buy" : "trial")}>{priced ? t.promo.startNow : t.promo.getQuote} <span aria-hidden>→</span></button>
                </div>
              </aside>
              )}
              {/* eslint-disable-next-line @next/next/no-img-element -- next.config images.unoptimized: next/image would serve it unchanged (R-331) */}
              <img className="gw-photo" src="/lp/gw-hero.jpg" alt={t.hero.photoAlt} width={400} height={458} fetchPriority="high" decoding="async" />
              <div className="gw-float">{t.hero.float}<small>{t.hero.floatSmall}</small></div>
            </div>
          </div>
        </section>

        <div className="gw-strip" aria-label={t.strip.aria}>
          <div className="gw-wrap gw-strip-row">
            <span>✓ {t.strip.trial}</span><span>✓ {t.strip.setup}</span><span>✓ {t.strip.gst}</span>
            <span>✓ {COMPANY.partnerLine}</span><span>✓ {t.strip.support}</span>
          </div>
        </div>

        <section className="gw-wrap gw-apps-sec" id="features">
          <ul className="gw-apps" aria-label={t.apps.aria}>
            {APPS.map((a, i) => (
              <li key={a.name}>
                {a.icon
                  // eslint-disable-next-line @next/next/no-img-element -- next.config images.unoptimized: next/image would serve it unchanged (R-331)
                  ? <img src={a.icon} alt="" width={44} height={44} />
                  : <span className="gw-tile" style={{ background: a.tile!.bg }} aria-hidden>{a.tile!.label}</span>}
                <b>{a.name}</b><span>{t.apps.what[i]}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="gw-wrap gw-sec">
          <div className="gw-kicker">{t.steps.kicker}</div>
          <h3 className="gw-h3">{t.steps.h3}</h3>
          <ol className="gw-steps">
            {t.steps.items(COMPANY.hours).map(([b, s], i) => (
              <li key={b}><span>{i + 1}</span><b>{b}</b><small>{s}</small></li>
            ))}
          </ol>
        </section>

        <section className="gw-wrap gw-offer" id="offer">
          <div className="gw-card gw-benefits">
            <div className="gw-kicker">{t.benefits.kicker}</div>
            <h3 className="gw-h3">{t.benefits.h3}</h3>
            <p className="gw-copy">{t.benefits.copy}</p>
            <ul className="gw-blist">
              {planText.benefits.map(([b, l]) => (
                <li key={b}><span className="gw-check" aria-hidden>✓</span><span><b>{b}</b><small>{l}</small></span></li>
              ))}
            </ul>
          </div>

          <aside className="gw-card gw-pricing" aria-label={t.price.aria}>
            <div className="gw-tag">{plan.name}</div>
            {priced ? (<>
            <div className="gw-price">{inr(annualPerSeatMo!)}<small>{t.price.perUserMonth}</small></div>
            <div className="gw-year">{t.price.perYear(inr(yearly))}</div>
            </>) : (
            /* R-328: Business Plus has no published price (Google shows none either). */
            plan.key === "plus"
              ? <div className="gw-price gw-price-talk">{CONTACT_FOR_PRICING}<small>{t.price.quoteInADay}</small></div>
              : <div className="gw-price gw-price-talk">{t.price.letsTalk}<small>{t.price.quoteInADay}</small></div>
            )}
            {hasOffer && (() => {
              const [pre, list, offer, post] = t.price.offerYear(inr(yearly), inr(offerYear), inr(offerMo));
              return (
            <div className="gw-offer-box">
              <div className="gw-offer-line"><span className="gw-off-badge">{t.price.offBadge(offPct)}</span> {t.price.offerLine(OFFER_MIN_USERS)}</div>
              <div className="gw-year">{pre}<s>{list}</s> <b>{offer}</b>{post}</div>
              <div className="gw-renew">{t.price.renew(inr(yearly))}</div>
            </div>
              );
            })()}
            <ul className="gw-incl">
              {planText.includes.map((l) => <li key={l}>{l}</li>)}
              <li>{t.price.gstLine} · {COMPANY.partnerLine}</li>
            </ul>
            {priced && (
            <div className="gw-calc">
              <label htmlFor="gw-users">{t.price.usersQ}</label>
              <div className="gw-calc-row">
                <button type="button" aria-label={t.price.fewer} onClick={() => setUsers((n) => Math.max(1, n - 1))}>−</button>
                <input id="gw-users" type="number" min={1} max={300} value={users}
                  onChange={(e) => setUsers(Math.max(1, Math.min(300, Number(e.target.value) || 1)))} />
                <button type="button" aria-label={t.price.more} onClick={() => setUsers((n) => Math.min(300, n + 1))}>+</button>
              </div>
              <dl className="gw-calc-out">
                <div><dt>{t.price.firstYear}</dt><dd>{inr(perUserYear * users)}</dd></div>
                <div><dt>{t.price.firstYearGst}</dt><dd><b>{inr(Math.round(perUserYear * users * 1.18))}</b></dd></div>
                {offerOn && <div className="gw-calc-save"><dt>{t.price.saving(offPct)}</dt><dd>{inr((yearly - offerYear) * users)}</dd></div>}
                <div><dt>{t.price.fromSecond}</dt><dd>{inr(yearly * users)}{t.price.perYearGst}</dd></div>
              </dl>
              {hasOffer && !offerOn && (
                <button type="button" className="gw-calc-nudge" onClick={() => setUsers(OFFER_MIN_USERS)}>
                  {t.price.nudge(OFFER_MIN_USERS, offPct)}
                </button>
              )}
            </div>
            )}
            <div className="gw-price-actions">
              <BuyButton className="gw-full" />
              <TrialButton className="gw-full" />
              {WHATSAPP_READY && <a className="gw-btn gw-wa gw-full" href={waLink(t.wa.buy(plan.name))} target="_blank" rel="noopener">{t.btn.callWhatsapp} {PHONE_SHOWN}</a>}
            </div>
            <p className="gw-secure">{t.price.secure}</p>
          </aside>
        </section>

        {allPlans && (
        <section className="gw-wrap gw-sec" id="plans">
          <div className="gw-kicker">{t.grid.kicker}</div>
          <h3 className="gw-h3">{t.grid.h3}</h3>
          <ul className="gw-plans">
            {allPlans.map(({ plan: p, annual }) => (
              <li key={p.key} className={`gw-plan${p.offer ? " gw-plan-hot" : ""}`}>
                {p.offer && <span className="gw-plan-flag">{t.grid.flag(OFFER_MIN_USERS, inr(FIRST_YEAR_PER_USER))}</span>}
                <b className="gw-plan-name">{p.name}</b>
                <div className="gw-plan-price">
                  {annual != null && annual > 0 ? <>{inr(annual)}<small>{t.grid.perMonth}</small></> : <>{t.grid.quote}<small>{t.grid.quoteSub}</small></>}
                </div>
                <small className="gw-plan-year">{annual != null && annual > 0 ? t.grid.yearlyGst : p.key === "plus" ? CONTACT_FOR_PRICING : t.grid.over300}</small>
                <ul className="gw-plan-facts">
                  <li>{p.storage}</li>
                  <li>{p.meetPeople}</li>
                  <li>{t.plans[p.key].highlight}</li>
                </ul>
                <button type="button" className="gw-btn gw-buy gw-full" onClick={() => { setModalPlan(p); setModal("buy"); }}>
                  {annual != null && annual > 0 ? t.grid.choose : t.grid.getQuote}
                </button>
                <a className="gw-plan-more" href={withAdParams(p.path, ad)}>{t.grid.more(p.name)}</a>
              </li>
            ))}
          </ul>
          <p className="gw-copy gw-plans-note">{t.grid.note}</p>
        </section>
        )}

        <section className="gw-wrap gw-sec" id="compare">
          <div className="gw-kicker">{t.compare.kicker}</div>
          <h3 className="gw-h3">{t.compare.h3}</h3>
          <div className="gw-table-wrap">
            <table className="gw-table">
              <thead><tr><th scope="col"><span className="gw-sr">{t.compare.feature}</span></th><th scope="col">{t.compare.freeGmail}</th><th scope="col">{t.compare.workspace}</th></tr></thead>
              <tbody>
                {compare.map(([k, a, b]) => (
                  <tr key={k}><th scope="row">{k}</th><td data-label={t.compare.freeGmail}>{a}</td><td data-label={t.compare.workspace}><span className="gw-yes" aria-hidden>✓</span> {b}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="gw-wrap gw-sec">
          <div className="gw-kicker">{t.why.kicker}</div>
          <h3 className="gw-h3">{t.why.h3}</h3>
          <div className="gw-why">
            {t.why.items(COMPANY.hours).map(([b, l]) => (
              <div key={b} className="gw-card gw-why-card"><b>{b}</b><p>{l}</p></div>
            ))}
          </div>
        </section>

        <section className="gw-wrap gw-sec" id="faq">
          <div className="gw-kicker">{t.faq.kicker}</div>
          <h3 className="gw-h3">{t.faq.h3}</h3>
          <div className="gw-faq">
            {faqs.map(([q, a]) => (
              <details key={q} className="gw-card"><summary>{q}</summary><p>{a}</p></details>
            ))}
          </div>
        </section>

        <section className="gw-wrap gw-final">
          <div className="gw-cta">
            <div className="gw-cta-copy">
              <h3 className="gw-h3">{t.cta.h3}</h3>
              <p>{t.cta.p}</p>
              <div className="gw-cta-actions">
                <TrialButton />
                {WHATSAPP_READY && <a className="gw-btn gw-wa" href={wa} target="_blank" rel="noopener">{t.btn.whatsapp} {PHONE_SHOWN}</a>}
              </div>
            </div>
            <div className="gw-cta-form"><CallbackForm t={t} landing={landing} plan={plan} /></div>
          </div>
        </section>
      </main>

      <footer className="gw-foot">
        <div className="gw-wrap gw-foot-row">
          <b>ANUTECH DIGITAL PVT LTD</b>
          <span>{t.foot.line}{WHATSAPP_READY ? ` · ${t.foot.callWa}: ${PHONE_SHOWN}` : ""} · {COMPANY.supportEmail}</span>
        </div>
      </footer>

      {exitOffer && !modal && (
        <div className="gw-modal" role="dialog" aria-modal="true" aria-labelledby="gw-exit-title" onClick={(e) => { if (e.target === e.currentTarget) setExitOffer(false); }}>
          <div className="gw-modal-card">
            <button type="button" className="gw-close" aria-label={t.btn.close} onClick={() => setExitOffer(false)}>×</button>
            <div className="gw-kicker">{t.exit.kicker}</div>
            <h3 id="gw-exit-title" className="gw-h3">{t.exit.h3}</h3>
            <p className="gw-copy">{t.exit.p}</p>
            <CallbackForm t={t} landing={landing} plan={plan} compact />
          </div>
        </div>
      )}

      <div className="gw-sticky" aria-label={t.sticky.aria}>
        <button type="button" className="gw-btn gw-buy" onClick={() => { if (buyOnline) window.location.href = checkoutHref; else setModal("buy"); }}>{buyLabel}</button>
        <button type="button" className="gw-btn gw-trial" onClick={() => setModal("trial")}>{t.btn.freeTrial}</button>
        {WHATSAPP_READY && <a className="gw-btn gw-wa" href={wa} target="_blank" rel="noopener">{t.btn.whatsapp}</a>}
      </div>

      {modal && <EnquiryModal t={t} kind={modal} landing={landing} plan={modalPlan ?? plan} defaultUsers={users} onClose={() => { setModal(null); setModalPlan(null); }} />}
    </div>
  );
}

/** Two fields — name + mobile — straight into the pipeline (api/public/callback). */
function CallbackForm({ t, landing, plan, compact = false }: { t: LpDict; landing: string; plan: LpPlan; compact?: boolean }) {
  const ts = useTurnstile();
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const c = t.callback;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ts.ready) { setErr(c.spamCheck); setState("error"); return; }
    const f = new FormData(e.currentTarget);
    const fullName = String(f.get("fullName") ?? "").trim();
    const phone = String(f.get("phone") ?? "").trim();
    setState("sending"); setErr("");
    try {
      const res = await fetch("/api/public/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ts.headers },
        body: JSON.stringify({ fullName, phone, plan: plan.category ? "any" : plan.key, pageUrl: landing || window.location.href, pageReferrer: document.referrer || undefined }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(typeof j?.error === "string" ? j.error : c.failed);
      }
      setName(fullName); setState("done");
      void reportLeadConversion();
    } catch (x) {
      setErr(x instanceof Error ? x.message : c.failed); setState("error");
    }
  }

  if (state === "done") {
    return (
      <div className={`gw-cb gw-cb-done${compact ? " gw-cb-compact" : ""}`} role="status">
        <b>{c.thanks(name.split(" ")[0] ?? "")}</b>
        <span>{COMPANY.hours}{WHATSAPP_READY ? c.waNow : ""}</span>
        {WHATSAPP_READY && <a className="gw-btn gw-wa" href={waLink(t.wa.callback(name, plan.category ? "" : plan.name))} target="_blank" rel="noopener">{t.btn.whatsapp} {PHONE_SHOWN}</a>}
      </div>
    );
  }
  return (
    <form className={`gw-cb${compact ? " gw-cb-compact" : ""}`} onSubmit={submit} aria-label={c.aria}>
      {!compact && <b className="gw-cb-title">{c.title}</b>}
      <div className="gw-cb-row">
        <label className="gw-sr" htmlFor={compact ? "cb-name-x" : "cb-name"}>{c.name}</label>
        <input id={compact ? "cb-name-x" : "cb-name"} name="fullName" required minLength={2} placeholder={c.namePlaceholder} autoComplete="name" />
        <label className="gw-sr" htmlFor={compact ? "cb-phone-x" : "cb-phone"}>{c.mobile}</label>
        <input id={compact ? "cb-phone-x" : "cb-phone"} name="phone" type="tel" required minLength={10} inputMode="tel" placeholder={c.mobile} autoComplete="tel" />
        <button type="submit" className="gw-btn gw-trial" disabled={state === "sending"}>{state === "sending" ? "…" : c.send}</button>
      </div>
      {ts.widget}
      {state === "error" && <p className="gw-err" role="alert">{err}</p>}
    </form>
  );
}

function EnquiryModal({ t, kind, landing, plan, defaultUsers, onClose }: { t: LpDict; kind: "buy" | "trial"; landing: string; plan: LpPlan; defaultUsers: number; onClose: () => void }) {
  const ts = useTurnstile();
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const [sent, setSent] = useState<{ name: string; users: number } | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const q = t.enquiry;

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && card.current) {        // keep focus inside the dialog
        const f = card.current.querySelectorAll<HTMLElement>("button, input, a[href]");
        if (!f.length) return;
        const a = f[0], z = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ts.ready) { setErr(q.spamCheck); setState("error"); return; }
    const f = new FormData(e.currentTarget);
    const users = Math.max(1, Math.min(300, Number(f.get("users")) || 1));
    const body = {
      fullName: String(f.get("fullName") ?? "").trim(),
      companyName: String(f.get("companyName") ?? "").trim(),
      email: String(f.get("email") ?? "").trim(),
      phone: String(f.get("phone") ?? "").trim(),
      seats: users,
      tierId: plan.key,
      billing: "annual",
      /* Internal note for the sales team (not shown to the visitor) — stays English. */
      message: kind === "buy" ? `Google Ads landing page: wants to BUY ${plan.name}` : `Google Ads landing page: 14-day free trial request (${plan.name})`,
      /* R-157: a trial is a trial (no priced quote is emailed), and a 30+ Starter enquiry on an
         offer page is the first-year offer, which needs Google approval before it is quoted. */
      ...(kind === "trial" ? { trial: true } : {}),
      ...(kind === "buy" && plan.offer && users >= OFFER_MIN_USERS ? { offer: "starter-30" } : {}),
      pageUrl: landing || window.location.href,
      pageReferrer: document.referrer || undefined,
    };
    setState("sending"); setErr("");
    try {
      const res = await fetch("/api/public/enquiry/workspace", {
        method: "POST", headers: { "Content-Type": "application/json", ...ts.headers }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(typeof j?.error === "string" ? j.error : q.failed);
      }
      setSent({ name: body.fullName, users }); setState("done");
      void reportLeadConversion();   // no-op until GOOGLE_ADS_SEND_TO is set
    } catch (x) {
      setErr(x instanceof Error ? x.message : q.failed); setState("error");
    }
  }

  return (
    <div className="gw-modal" role="dialog" aria-modal="true" aria-labelledby="gw-modal-title" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="gw-modal-card" ref={card}>
        <button type="button" className="gw-close" aria-label={t.btn.close} onClick={onClose}>×</button>
        {state === "done" && sent ? (
          <div role="status">
            <div className="gw-kicker">{q.doneKicker}</div>
            <h3 id="gw-modal-title" className="gw-h3">{q.doneH(sent.name.split(" ")[0] ?? "")}</h3>
            <p className="gw-copy">{q.doneP(COMPANY.hours)}</p>
            {WHATSAPP_READY && (
              <a className="gw-btn gw-wa gw-full" target="_blank" rel="noopener"
                href={waLink(t.wa.enquiry(sent.name, sent.users))}>
                {q.doneWa}
              </a>
            )}
          </div>
        ) : (
          <>
            <div className="gw-kicker">{kind === "buy" ? `Google Workspace ${plan.name}` : q.trialKicker}</div>
            <h3 id="gw-modal-title" className="gw-h3">{kind === "buy" ? q.buyH : q.trialH}</h3>
            <p className="gw-copy">{kind === "buy" ? q.buyP : q.trialP}</p>
            <form className="gw-form" onSubmit={submit}>
              <label>{q.name}<input ref={first} name="fullName" required minLength={2} autoComplete="name" /></label>
              <label>{q.company}<input name="companyName" required minLength={2} autoComplete="organization" /></label>
              <label>{q.email}<input name="email" type="email" required autoComplete="email" /></label>
              <label>{q.mobile}<input name="phone" type="tel" required minLength={10} inputMode="tel" autoComplete="tel" /></label>
              <label>{q.users}<input name="users" type="number" min={1} max={300} defaultValue={defaultUsers} /></label>
              {ts.widget}
              {state === "error" && <p className="gw-err" role="alert">{err}{q.tryAgain}</p>}
              <button type="submit" className="gw-btn gw-trial gw-full" disabled={state === "sending"}>
                {state === "sending" ? q.sending : q.submit}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

const CSS = `
.gw{--blue:#0b57d0;--ink:#172b4d;--muted:#5b6a83;--line:#e7edf7;--bg:#f7fbff;--shadow:0 18px 50px rgba(16,42,86,.12);
  font-family:var(--font-sans),Archivo,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg);line-height:1.55;overflow-x:clip}
.gw *{box-sizing:border-box}
.gw img{max-width:100%;height:auto}
.gw a{color:inherit;text-decoration:none}
.gw-wrap{width:min(1180px,calc(100% - 32px));margin:0 auto}
.gw-top{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.92);backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}
.gw-nav{min-height:72px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.gw-logo{width:190px;height:auto;display:block}
.gw-nav-actions{display:flex;gap:8px;align-items:center}
.gw-lang{display:inline-flex;border:1px solid #c9d3e3;border-radius:999px;padding:2px;background:#fff}
.gw .gw-lang button{border:0;background:transparent;border-radius:999px;padding:0 10px;min-height:36px;font:inherit;font-size:13px;font-weight:700;color:#475467;cursor:pointer}
.gw .gw-lang button[aria-pressed="true"]{background:#e8f0fe;color:#0b57d0}
.gw .gw-lang button:focus-visible{outline:3px solid #0b57d0;outline-offset:1px}
.gw-links{display:flex;gap:22px;font-size:14px;font-weight:700;color:#475467;margin-left:auto;margin-right:12px}
.gw-links a{color:inherit;text-decoration:none}.gw-links a:hover{color:var(--blue)}
.gw-links a:focus-visible{outline:3px solid #0b57d0;outline-offset:3px;border-radius:4px}
.gw-strip{border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:#fff}
.gw-strip-row{display:flex;justify-content:center;flex-wrap:wrap;gap:8px 26px;padding:14px 0;font-size:13.5px;font-weight:700;color:#344054}
.gw .gw-mini{padding:10px 15px;border-radius:999px;font-weight:800;border:1px solid var(--line);background:#fff;font-size:14px;white-space:nowrap}
.gw .gw-mini-primary{background:var(--blue);color:#fff;border-color:var(--blue)}
.gw-hero{padding:48px 0 24px;background:radial-gradient(circle at 88% 8%,rgba(66,133,244,.16),transparent 34%),linear-gradient(180deg,#fff,#f5faff)}
.gw-hero-grid{display:grid;grid-template-columns:1.05fr .95fr;align-items:center;gap:40px}
.gw-hero-grid>*{min-width:0}
.gw-eyebrow{display:inline-flex;gap:8px;padding:8px 13px;border:1px solid #dbe8ff;border-radius:999px;background:#fff;color:var(--blue);font-weight:800;font-size:13px}
.gw-h1{font-size:clamp(40px,5.4vw,70px);line-height:1;letter-spacing:-.04em;margin:18px 0;color:#15294f;text-wrap:balance}
.gw-google{background:linear-gradient(90deg,#4285f4 0 28%,#ea4335 28% 43%,#fbbc05 43% 57%,#34a853 57% 73%,#4285f4 73%);-webkit-background-clip:text;background-clip:text;color:transparent}
.gw-h2{font-size:clamp(22px,2.6vw,32px);line-height:1.15;margin:0 0 14px;color:#1647a3;text-wrap:balance}
.gw-h3{font-size:clamp(26px,3vw,38px);line-height:1.1;margin:8px 0 10px;text-wrap:balance}
.gw-copy{font-size:17px;color:var(--muted);max-width:62ch;margin:0}
.gw-buttons{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}
.gw .gw-btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:54px;padding:0 22px;border-radius:14px;font-weight:800;font-size:16px;border:0;cursor:pointer;box-shadow:0 8px 22px rgba(11,87,208,.12);font-family:inherit;transition:transform .2s,box-shadow .2s}
.gw .gw-btn:hover{transform:translateY(-2px)}
.gw .gw-btn:focus-visible,.gw .gw-mini:focus-visible,.gw-close:focus-visible{outline:3px solid #0a3d91;outline-offset:2px}
.gw .gw-buy{background:linear-gradient(135deg,#ff3b30,#d81b2a);color:#fff}
.gw .gw-trial{background:linear-gradient(135deg,#0b57d0,#3f7fe8);color:#fff}
.gw .gw-wa{background:#15803d;color:#fff}
.gw .gw-full{width:100%}
.gw .gw-btn[disabled]{opacity:.6;cursor:default;transform:none}
.gw-note{margin-top:12px;font-size:13px;color:#6b7a92}
.gw-visual{position:relative;display:grid;gap:18px}
.gw-promo{position:relative;overflow:hidden;color:#fff;border-radius:24px;padding:18px 20px;background:linear-gradient(135deg,#0b57d0 0%,#1a73e8 55%,#34a853 130%);box-shadow:0 18px 40px rgba(11,87,208,.28)}
.gw-promo::after{content:"";position:absolute;right:-40px;top:-40px;width:150px;height:150px;border-radius:50%;background:rgba(255,255,255,.12)}
.gw-promo-tag{display:inline-block;background:#fbbc04;color:#202124;font-size:11px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;padding:4px 10px;border-radius:999px}
.gw-promo-main{display:flex;gap:14px;align-items:center;margin-top:10px;position:relative;z-index:1}
.gw-promo-zero{flex:none;width:76px;height:76px;border-radius:50%;background:#fff;color:#0b57d0;display:grid;place-content:center;text-align:center;line-height:1;box-shadow:0 0 0 5px rgba(255,255,255,.25);transform:rotate(-8deg)}
.gw-promo-zero b{font-size:26px;font-weight:900}.gw-promo-zero small{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#3c4a5e}
.gw-promo-h{margin:0;font-size:20px;font-weight:900;line-height:1.2}
.gw-promo-s{margin:4px 0 0;font-size:14px;opacity:.92}
.gw-promo-h s{opacity:.7;font-weight:700;font-size:.8em}.gw-promo-unit{font-size:.7em;font-weight:700}
.gw-offer-line{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:800;color:#14532d;margin:6px 0 4px}
.gw-off-badge{background:#d93025;color:#fff;border-radius:999px;padding:3px 10px;font-size:12px;letter-spacing:.04em}
.gw-year s,.gw-renew{color:#6b7a92}.gw-year b{color:var(--ink)}
.gw-renew{font-size:13px;margin-top:2px}
.gw-offer-box{margin:12px 0 4px;padding:10px 12px;border:1px dashed #f4b4ae;background:#fff6f5;border-radius:14px}
.gw-offer-box .gw-offer-line{margin-top:0}
.gw .gw-calc-nudge{margin-top:10px;width:100%;background:#fff6f5;border:1px dashed #d93025;color:#b42318;border-radius:12px;padding:10px;font:inherit;font-size:13px;font-weight:800;cursor:pointer;min-height:44px}
.gw-calc-save dt,.gw-calc-save dd{color:#0a7a35!important;font-weight:800}
.gw-promo-foot{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-top:14px;padding-top:12px;border-top:1px dashed rgba(255,255,255,.45);font-size:13px;font-weight:700;position:relative;z-index:1}
.gw .gw-promo-btn{background:#fff;color:#0b57d0;border:0;border-radius:999px;padding:10px 18px;font:inherit;font-size:14px;font-weight:900;cursor:pointer;min-height:44px}
.gw .gw-promo-btn:hover{background:#e8f0fe}
.gw .gw-promo-btn:focus-visible{outline:3px solid #fbbc04;outline-offset:2px}
.gw-photo{width:100%;aspect-ratio:1.18/1;object-fit:cover;object-position:center 20%;border-radius:32px;display:block;box-shadow:var(--shadow);border:8px solid rgba(255,255,255,.9)}
.gw-float{position:absolute;left:-16px;bottom:22px;background:#fff;border:1px solid var(--line);box-shadow:var(--shadow);border-radius:18px;padding:14px 18px;font-weight:800}
.gw-float small{display:block;color:var(--muted);font-weight:500;margin-top:2px}
.gw-apps-sec{padding:18px 0 32px}
.gw-apps{list-style:none;margin:0;padding:0;background:#fff;border:1px solid var(--line);box-shadow:0 10px 30px rgba(16,42,86,.07);border-radius:24px;display:grid;grid-template-columns:repeat(7,1fr);overflow:hidden}
.gw-apps li{padding:18px 8px;text-align:center;border-right:1px solid var(--line);display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0}
.gw-apps li:last-child{border-right:0}
.gw-apps b{font-size:14px}.gw-apps span{color:var(--muted);font-size:12px}
.gw-apps .gw-tile{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;color:#fff;font-weight:900;font-size:18px}
.gw-offer{display:grid;grid-template-columns:1fr .75fr;gap:22px;padding:16px 0 64px;align-items:stretch}
.gw-card{background:#fff;border:1px solid var(--line);border-radius:26px;box-shadow:var(--shadow);min-width:0}
.gw-benefits{padding:30px}
.gw-kicker{color:var(--blue);font-weight:900;text-transform:uppercase;letter-spacing:.12em;font-size:12px}
.gw-blist{list-style:none;margin:22px 0 0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:14px}
.gw-blist li{display:flex;gap:12px;padding:15px;border:1px solid var(--line);border-radius:18px;background:#fbfdff}
.gw-blist b{display:block}.gw-blist small{font-size:13px;color:var(--muted)}
.gw-check{width:36px;height:36px;flex:0 0 36px;border-radius:50%;display:grid;place-items:center;background:#e9f7ee;color:#0a7a35;font-weight:900}
.gw-pricing{padding:28px;display:flex;flex-direction:column;background:linear-gradient(160deg,#fff,#f2f8ff)}
.gw-tag{align-self:flex-start;background:#d81b2a;color:#fff;font-weight:900;padding:7px 14px;border-radius:999px;margin-bottom:12px;font-size:14px}
.gw-price{font-size:clamp(46px,6vw,64px);font-weight:900;letter-spacing:-.04em;color:var(--blue);line-height:1;font-variant-numeric:tabular-nums}
.gw-price small{font-size:16px;letter-spacing:0;color:#51627d;font-weight:700}
.gw-year{margin-top:8px;font-size:14px;color:var(--muted)}
.gw-price-talk{font-size:clamp(34px,4vw,44px)}
.gw-incl{margin:16px 0 20px;padding-left:18px;color:var(--ink);font-size:15px;display:grid;gap:4px}
.gw-price-actions{display:grid;gap:10px}
.gw-secure{margin:14px 0 0;text-align:center;color:#6c7a91;font-size:13px}
.gw-final{padding-bottom:64px}
.gw-cta{background:#101828;border-radius:30px;color:#fff;padding:44px;display:grid;grid-template-columns:1.1fr .9fr;align-items:center;gap:32px;box-shadow:0 22px 60px rgba(16,24,40,.25)}
.gw-cta .gw-h3{color:#fff}
.gw-cta p{margin:0 0 18px;color:#cbd5e1}
.gw-cta-form .gw-cb{margin-top:0;max-width:none;color:var(--ink)}
.gw .gw-cta .gw-cta-form .gw-btn{background:#0b57d0;color:#fff;border-color:#0b57d0}
.gw-cta-form .gw-cb-row{grid-template-columns:1fr}
.gw-cta-actions{display:flex;flex-wrap:wrap;gap:10px}
.gw .gw-cta .gw-buy,.gw .gw-cta .gw-trial{background:#fff;color:#0b57d0}
.gw-foot{background:#0d2348;color:#cdd9ee;padding:28px 0}
.gw-foot b{color:#fff}
.gw-foot-row{display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap;font-size:13px}
.gw-calc{border:1px solid var(--line);border-radius:16px;padding:14px;margin:0 0 16px;background:#fff}
.gw-calc label{font-weight:800;font-size:14px}
.gw-calc-row{display:flex;gap:8px;margin:8px 0 10px}
.gw-calc-row button{width:44px;height:44px;border-radius:12px;border:1px solid #c9d3e3;background:#f5f8fd;font-size:22px;font-weight:800;cursor:pointer;color:var(--ink)}
.gw-calc-row button:focus-visible,.gw-calc-row input:focus-visible,.gw-faq summary:focus-visible{outline:3px solid #0b57d0;outline-offset:2px}
.gw-calc-row input{width:90px;height:44px;text-align:center;border:1px solid #c9d3e3;border-radius:12px;font:inherit;font-size:18px;font-weight:800}
.gw-calc-out{margin:0;display:grid;gap:4px}
.gw-calc-out div{display:flex;justify-content:space-between;gap:12px;font-size:14px}
.gw-calc-out dt{color:var(--muted)}.gw-calc-out dd{margin:0;font-variant-numeric:tabular-nums}
.gw-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.gw-sec{padding-bottom:56px}
.gw-table-wrap{overflow-x:auto;margin-top:16px;border:1px solid var(--line);border-radius:20px;background:#fff;box-shadow:var(--shadow)}
.gw-table{width:100%;border-collapse:collapse;min-width:520px;font-size:15px}
.gw-table th,.gw-table td{padding:14px 16px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
.gw-table thead th{background:#f2f7ff;font-size:14px}
.gw-table thead th:last-child{color:var(--blue)}
.gw-table tbody tr:last-child th,.gw-table tbody tr:last-child td{border-bottom:0}
.gw-table tbody th{font-weight:700;color:var(--ink)}
.gw-table td:nth-child(2){color:var(--muted)}
.gw-table td:last-child{font-weight:700}
.gw-yes{color:#0a7a35;font-weight:900}
.gw-why{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:16px}
.gw-why-card{padding:20px}.gw-why-card p{margin:6px 0 0;color:var(--muted);font-size:14px}
.gw-faq{display:grid;gap:10px;margin-top:16px;max-width:860px}
.gw-faq summary{cursor:pointer;padding:18px 20px;font-weight:800;list-style:none}
.gw-faq summary::-webkit-details-marker{display:none}
.gw-faq summary::after{content:"+";float:right;color:var(--blue);font-size:20px;line-height:1}
.gw-faq details[open] summary::after{content:"−"}
.gw-faq p{margin:0;padding:0 20px 18px;color:var(--muted)}
.gw-sticky{display:none}
.gw-ticks{list-style:none;margin:16px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:8px 16px;font-size:14px;font-weight:700;color:#14532d}
.gw-ticks li::before{content:"✓ ";color:#15803d}
.gw-note b{color:var(--ink)}
.gw-cb{margin-top:18px;background:#fff;border:1px solid #dbe8ff;border-radius:18px;padding:14px;box-shadow:0 10px 28px rgba(16,42,86,.08);display:grid;gap:8px;max-width:620px}
.gw-cb-compact{box-shadow:none;border:0;padding:0;margin-top:14px}
.gw-cb-title{font-size:15px}
.gw-cb-row{display:grid;grid-template-columns:1fr 1fr auto;gap:8px}
.gw-cb input{min-height:48px;border:1px solid #c9d3e3;border-radius:12px;padding:0 12px;font:inherit;font-size:16px;min-width:0}
.gw-cb input:focus-visible{outline:3px solid #0b57d0;outline-offset:1px}
.gw .gw-cb .gw-btn{min-height:48px}
.gw-cb-done{color:#14532d}.gw-cb-done span{font-size:13px;color:var(--muted)}
.gw-steps{list-style:none;margin:16px 0 0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.gw-steps li{background:#fff;border:1px solid var(--line);border-radius:20px;padding:20px;display:grid;gap:4px;box-shadow:var(--shadow)}
.gw-steps span{width:36px;height:36px;border-radius:50%;background:#0b57d0;color:#fff;display:grid;place-items:center;font-weight:900}
.gw-steps small{color:var(--muted);font-size:14px}
.gw-modal{position:fixed;inset:0;background:rgba(6,22,48,.6);display:grid;place-items:center;padding:16px;z-index:100}
.gw-modal-card > .gw-kicker{padding-right:40px}
.gw-plans{list-style:none;margin:28px 0 0;padding:0;display:grid;grid-template-columns:1fr;gap:22px 16px}
@media (min-width:600px){.gw-plans{grid-template-columns:repeat(2,1fr)}}
@media (min-width:1040px){.gw-plans{grid-template-columns:repeat(4,1fr)}}
.gw-plan{position:relative;display:flex;flex-direction:column;gap:8px;background:#fff;border:1px solid #dbe4f0;border-radius:18px;padding:22px 18px 18px}
.gw-plan-hot{border:2px solid #1a73e8;box-shadow:0 12px 30px rgba(26,115,232,.14)}
.gw-plan-flag{position:absolute;top:-12px;left:16px;right:16px;background:#e8453c;color:#fff;font-size:11px;font-weight:800;letter-spacing:.02em;border-radius:999px;padding:4px 10px;text-align:center}
.gw-plan-name{font-size:18px;color:#0b1f3a}
.gw-plan-price{font-size:28px;font-weight:800;color:#0b1f3a;line-height:1.1;font-variant-numeric:tabular-nums}
.gw-plan-price small{font-size:13px;font-weight:600;color:#5b6b82}
.gw-plan-year{color:#5b6b82;font-size:12px}
.gw-plan-facts{list-style:none;margin:4px 0 8px;padding:0;display:grid;gap:6px;font-size:14px;color:#33415a;flex:1}
.gw-plan-facts li::before{content:"✓ ";color:#188038;font-weight:800}
.gw-plan-more{font-size:13px;font-weight:700;color:#1a73e8;text-align:center;text-decoration:none}
.gw-plan-more:hover{text-decoration:underline}
.gw-plans-note{margin-top:16px;text-align:center}
.gw-modal-card{width:min(520px,100%);max-height:calc(100dvh - 32px);overflow:auto;background:#fff;border-radius:24px;padding:28px;box-shadow:0 30px 90px rgba(0,0,0,.25);position:relative}
.gw-close{position:absolute;right:14px;top:12px;border:0;background:#f0f4fa;width:36px;height:36px;border-radius:50%;font-size:20px;cursor:pointer}
.gw-form{display:grid;gap:12px;margin-top:16px}
.gw-form label{display:grid;gap:4px;font-size:13px;font-weight:700}
.gw-form input{width:100%;min-height:46px;padding:0 14px;border:1px solid #c9d3e3;border-radius:12px;font:inherit;font-size:16px}
.gw-form input:focus-visible{outline:3px solid #0b57d0;outline-offset:1px}
.gw-err{color:#b42318;font-size:14px;margin:0}
@media(max-width:900px){
  .gw-hero-grid,.gw-offer{grid-template-columns:1fr}
  .gw-visual{max-width:640px}
  .gw-apps{grid-template-columns:repeat(4,1fr)}
  .gw-apps li:nth-child(4){border-right:0}.gw-apps li:nth-child(n+5){border-top:1px solid var(--line)}
  .gw-blist{grid-template-columns:1fr}
  .gw-why{grid-template-columns:1fr 1fr}
  .gw-steps{grid-template-columns:1fr}
  .gw-cta{grid-template-columns:1fr;padding:30px}
  .gw-links{display:none}
}
@media(max-width:600px){
  .gw-wrap{width:calc(100% - 24px)}
  .gw-logo{width:140px}
  .gw .gw-mini{padding:8px 11px;font-size:12px}
  .gw .gw-mini-wa{display:none}
  .gw .gw-lang button{padding:0 8px;font-size:12px}
  .gw-hero{padding:28px 0 14px}
  .gw-buttons,.gw-cta-actions{display:grid;width:100%}
  .gw .gw-btn{width:100%}
  .gw-float{left:12px;bottom:12px;font-size:13px}
  .gw-promo{padding:16px}.gw-promo-h{font-size:18px}.gw-promo-zero{width:64px;height:64px}.gw-promo-zero b{font-size:22px}
  .gw .gw-promo-btn{width:100%}
  .gw-photo{border-width:5px;border-radius:24px}
  .gw-apps{grid-template-columns:repeat(4,1fr);border-radius:18px}
  .gw-apps li{padding:12px 4px;border:0!important}
  .gw-apps li span:not(.gw-tile){display:none}
  .gw-apps b{font-size:12px}
  .gw-apps img,.gw-apps .gw-tile{width:34px;height:34px}
  .gw-benefits,.gw-pricing{padding:22px}
  .gw-why{grid-template-columns:1fr}
  .gw-cb-row{grid-template-columns:1fr}
  .gw-table-wrap{overflow:visible;border:0;box-shadow:none;background:transparent}
  .gw-table,.gw-table tbody,.gw-table tr,.gw-table th,.gw-table td{display:block;min-width:0}
  .gw-table thead{display:none}
  .gw-table tr{background:#fff;border:1px solid var(--line);border-radius:16px;margin-bottom:10px;padding:12px 14px}
  .gw-table th,.gw-table td{padding:2px 0;border:0}
  .gw-table tbody th{font-size:15px;margin-bottom:4px}
  .gw-table td{display:flex;gap:8px;font-size:14px}
  .gw-table td::before{content:attr(data-label);flex:0 0 118px;color:var(--muted);font-weight:600}
  .gw-sticky{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;position:fixed;left:0;right:0;bottom:0;z-index:60;padding:8px 8px calc(8px + env(safe-area-inset-bottom,0px));background:rgba(255,255,255,.96);border-top:1px solid var(--line);box-shadow:0 -10px 30px rgba(16,42,86,.12)}
  .gw .gw-sticky .gw-btn{min-height:46px;padding:0 8px;font-size:14px;border-radius:12px}
  .gw-foot{padding-bottom:84px}
  .gw-cta{padding:26px;border-radius:24px}
}
@media(max-width:420px){.gw-logo{width:108px}.gw .gw-lang button{padding:0 6px}.gw-nav{gap:8px}}
@media(prefers-reduced-motion:reduce){.gw .gw-btn{transition:none}.gw .gw-btn:hover{transform:none}}
`;
