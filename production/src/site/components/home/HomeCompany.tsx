"use client";

/**
 * HomeCompany — the anutech.in home since 5 Oct 2026 (R-155). Pardeep: the home is about the
 * whole company, and the company leads with CUSTOM SOFTWARE and office automation; licences,
 * domains and hosting follow as "IT for your office". The email-first page that used to be
 * the home is now the Business Email category page (/email, HomeV2).
 *
 * Honest by construction: no client names, case studies, reviews or software prices — we
 * have none to show yet. The proof is the one thing that is true and checkable: Anutech runs
 * its own company on software it built (ResellerOS). The project steps are the real ones
 * from docs/project-template. Leads go to /api/public/callback as product "custom-software".
 *
 * Same visual language as HomeV2 (palette, Archivo + Plex Mono), CSS in one <style> block
 * so the phone layout is media queries, not a JS width check.
 */
import { useState } from "react";
import Link from "@/site/components/ui/SiteLink";
import { useTurnstile } from "@/components/shared/turnstile";
import { reportLeadConversion } from "@/site/lib/google-ads";
import { WHATSAPP_URL, WHATSAPP_READY, COMPANY } from "@/site/lib/config";
import { C, MONO, CATALOGUE_V2, CatScene } from "@/site/components/home/HomeV2";
import { COMPANY_FAQS } from "@/site/lib/data/company-faqs";

const WA = (text: string) => `${WHATSAPP_URL}?text=${encodeURIComponent(text)}`;
const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

/** What we automate — capabilities, phrased as the job the client does by hand today. */
const AUTOMATE: readonly { icon: string; title: string; body: string }[] = [
  { icon: "M3 7h18M3 12h18M3 17h12", title: "Leads & sales", body: "Enquiries from the website, WhatsApp and calls in one list, follow-up reminders, and a quote sent in a click." },
  { icon: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6", title: "Billing & GST", body: "GST invoices, payment reminders, renewals and bank reconciliation — no more re-typing into Excel." },
  { icon: "M16 11a4 4 0 10-8 0M4 21a8 8 0 0116 0", title: "Staff & HR", body: "Attendance, salary, advances, leave and training records, with each person seeing only their own." },
  { icon: "M4 12l5 5L20 6", title: "Approvals", body: "Purchase, expense and discount approvals on the phone, with a record of who said yes and when." },
  { icon: "M4 20V10M10 20V4M16 20v-7M22 20H2", title: "Reports & dashboards", body: "Today's numbers on one screen — sales, dues, stock, work pending — instead of a sheet someone updates on Friday." },
  { icon: "M12 2a7 7 0 017 7c0 5-7 13-7 13S5 14 5 9a7 7 0 017-7zM12 7v4M12 13h.01", title: "AI where it saves time", body: "Reads documents, drafts replies, sorts enquiries and flags what is late — always with a person deciding." },
];

/** The real project steps (docs/project-template, 7-step team model). */
const STEPS: readonly { n: string; title: string; body: string; who: string }[] = [
  { n: "01", title: "A free call", body: "Show us how the work is done today — the sheets, the WhatsApp groups, the registers. No preparation needed.", who: "You" },
  { n: "02", title: "Requirements in writing", body: "Every point in plain words, for you to correct before anything is built.", who: "We" },
  { n: "03", title: "A fixed quote", body: "Scope, price in rupees with GST, and milestones with dates. Nothing starts without your yes.", who: "You" },
  { n: "04", title: "Build, with a demo at each milestone", body: "You use working software early and can change course — changes are written down with their effect on price and date.", who: "We" },
  { n: "05", title: "Go-live and training", body: "We set it up, move your existing data, train your team and hand over every login.", who: "We" },
  { n: "06", title: "Support after go-live", body: "Fixes and small changes on WhatsApp by the people who built it; an optional monthly support plan.", who: "We" },
];

/** "IT for your office" — the licence/hosting catalogue, email first. */
const IT_CARDS = [
  { name: "Business email", href: "/email", from: "₹79", unit: "from · /mailbox/mo", gst: "+ GST 18%", body: "Google Workspace, Microsoft 365, Zoho or Anutech Mail — priced side by side, migrated free.", tags: ["GOOGLE PREMIER PARTNER", "FREE MIGRATION"], cta: "See email plans", icon: "mail" as const, img: "/googleworkspace-inbox.png" },
  ...CATALOGUE_V2.filter((c) => c.name !== "Reseller program"),
];

export function HomeCompany({ emailFrom }: { emailFrom?: number }) {
  const [openFaq, setOpenFaq] = useState(0);
  const cards = IT_CARDS.map((c) => (c.name === "Business email" && emailFrom ? { ...c, from: inr(emailFrom) } : c));

  return (
    <div className="hc">
      <style>{CSS}</style>

      {/* ── HERO: custom software first ──────────────────────────────────────── */}
      <section className="hc-wrap hc-hero">
        <div>
          <div className="hc-eyebrow">Anutech Digital · Delhi · Since 2014</div>
          <h1 className="hc-h1">Software that runs your office — built for how <em>your</em> business works.</h1>
          <p className="hc-lead">
            We build custom software and office automation for Indian businesses: enquiries, quotes, GST invoices, follow-ups,
            approvals, staff and reports — the work your team does by hand in Excel and WhatsApp today.
          </p>
          <ul className="hc-ticks">
            <li>Fixed quote before we start</li>
            <li>Working demo at every milestone</li>
            <li>GST invoice · {COMPANY.city}</li>
          </ul>
          <div className="hc-actions">
            <a className="hc-btn hc-btn-primary" href="#start">Tell us what to automate →</a>
            {WHATSAPP_READY && <a className="hc-btn hc-btn-wa" href={WA("Hi Anutech — we want to automate some office work. Can we talk?")} target="_blank" rel="noopener">WhatsApp us</a>}
          </div>
        </div>
        <StartForm />
      </section>

      {/* ── WHAT WE AUTOMATE ─────────────────────────────────────────────────── */}
      <section className="hc-band" id="software">
        <div className="hc-wrap">
          <div className="hc-eyebrow">Office automation</div>
          <h2 className="hc-h2">If your team types it twice, we can automate it</h2>
          <p className="hc-sub">One system for the work that today lives in sheets, registers and chat groups. Built around your process — not the other way round.</p>
          <ul className="hc-grid3">
            {AUTOMATE.map((a) => (
              <li key={a.title} className="hc-tile">
                <span className="hc-ico" aria-hidden>
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={a.icon} /></svg>
                </span>
                <b>{a.title}</b>
                <span>{a.body}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── PROOF: we run on our own software ────────────────────────────────── */}
      <section className="hc-wrap hc-proof">
        <div>
          <div className="hc-eyebrow">Proof, not promises</div>
          <h2 className="hc-h2">We run our own company on software we built</h2>
          <p className="hc-sub">
            ResellerOS is our own system. Anutech Digital uses it every day for leads, quotes, GST invoices, subscriptions and
            renewals, bank reconciliation, staff and salary. On the first call we show it to you working — the same way we would build yours.
          </p>
          <div className="hc-actions">
            <Link href="/reselleros" className="hc-btn hc-btn-ghost">See ResellerOS →</Link>
          </div>
        </div>
        <ul className="hc-proof-list" aria-label="What ResellerOS does for us">
          {["Leads and follow-ups", "Quotes and GST invoices", "Subscriptions and renewals", "Bank reconciliation", "Staff, salary and advances", "AI assistant for the team"].map((t) => (
            <li key={t}><span aria-hidden>✓</span>{t}</li>
          ))}
        </ul>
      </section>

      {/* ── HOW A PROJECT WORKS ──────────────────────────────────────────────── */}
      <section className="hc-band" id="how">
        <div className="hc-wrap">
          <div className="hc-eyebrow">How a project works</div>
          <h2 className="hc-h2">Six steps. You decide at every one.</h2>
          <p className="hc-sub">AI writes much of the code and our team checks every part of it — that is how a small team delivers quickly and keeps the price fair.</p>
          <ol className="hc-steps">
            {STEPS.map((s) => (
              <li key={s.n}>
                <span className="hc-step-n">{s.n}</span>
                <span className="hc-step-body"><b>{s.title}</b><span>{s.body}</span></span>
                <span className="hc-step-who">{s.who}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── IT FOR YOUR OFFICE ───────────────────────────────────────────────── */}
      <section className="hc-wrap hc-it" id="it">
        <div className="hc-eyebrow">IT for your office</div>
        <h2 className="hc-h2">Email, domains, hosting and security — from one partner</h2>
        <p className="hc-sub">Published prices, renewal shown up front, GST invoice on every order. {COMPANY.partnerLine}.</p>
        <div className="hc-grid4">
          {cards.map((c) => (
            <Link key={c.name} href={c.href as never} className="hc-card">
              <span className="hc-card-img">
                {/* eslint-disable-next-line @next/next/no-img-element -- next.config images.unoptimized: next/image would serve it unchanged (R-331) */}
                {c.img ? <img src={c.img} alt="" loading="lazy" /> : <CatScene kind={c.icon} />}
              </span>
              <b className="hc-card-name">{c.name}</b>
              <span className="hc-card-price"><span>{c.from}</span><small>{c.unit}</small></span>
              <small className="hc-card-gst">{c.gst}</small>
              <span className="hc-card-body">{c.body}</span>
              <span className="hc-card-cta">{c.cta} <span aria-hidden>→</span></span>
            </Link>
          ))}
        </div>
        <p className="hc-reseller">Resell licences yourself? <Link href="/reseller">Wholesale rates</Link> · <Link href="/reselleros">ResellerOS for resellers</Link></p>
      </section>

      {/* ── COMPANY FACTS ────────────────────────────────────────────────────── */}
      <section className="hc-band">
        <div className="hc-wrap hc-facts">
          {[
            ["Since 2014", "In business"],
            ["Premier Partner", "Google"],
            ["A person", "Answers on WhatsApp"],
            [COMPANY.gstin, "GSTIN · " + COMPANY.city],
          ].map(([v, l]) => (
            <div key={l}><b>{v}</b><span>{l}</span></div>
          ))}
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────────────────────────── */}
      <section className="hc-wrap hc-faq" id="faq">
        <div className="hc-eyebrow hc-center">Questions</div>
        <h2 className="hc-h2 hc-center">What people ask before a project</h2>
        {COMPANY_FAQS.map((f, i) => {
          const open = openFaq === i;
          return (
            <div key={f.q} className="hc-faq-row">
              <button type="button" onClick={() => setOpenFaq(open ? -1 : i)} aria-expanded={open}>
                <span>{f.q}</span><span aria-hidden>{open ? "−" : "+"}</span>
              </button>
              {open && <p>{f.a}</p>}
            </div>
          );
        })}
      </section>

      {/* ── START ────────────────────────────────────────────────────────────── */}
      <section className="hc-final">
        <div className="hc-wrap hc-final-in">
          <div>
            <h2 className="hc-h2 hc-on-dark">Start with one free call</h2>
            <p className="hc-on-dark-sub">Tell us the one job that wastes the most time in your office. We will tell you honestly whether software is the answer — and what it would take.</p>
          </div>
          <a className="hc-btn hc-btn-light" href="#start">Request a call →</a>
        </div>
      </section>
    </div>
  );
}

/** The custom-software call-back: name, mobile, and (optional) the job to automate. */
function StartForm() {
  const ts = useTurnstile();
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const [name, setName] = useState("");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ts.ready) { setErr("One second — the spam check is still loading."); setState("error"); return; }
    const f = new FormData(e.currentTarget);
    const fullName = String(f.get("fullName") ?? "").trim();
    const phone = String(f.get("phone") ?? "").trim();
    const need = String(f.get("need") ?? "").trim();
    setState("sending"); setErr("");
    try {
      const res = await fetch("/api/public/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ts.headers },
        body: JSON.stringify({ fullName, phone, product: "custom-software", need: need || undefined, pageUrl: window.location.href, pageReferrer: document.referrer || undefined }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(typeof j?.error === "string" ? j.error : "Could not send. Please WhatsApp us.");
      }
      setName(fullName); setState("done");
      void reportLeadConversion();
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Could not send. Please WhatsApp us."); setState("error");
    }
  }

  if (state === "done") {
    return (
      <div className="hc-form hc-form-done" id="start" role="status">
        <b>Thank you{name ? `, ${name.split(" ")[0]}` : ""}! We will call you.</b>
        <span>{COMPANY.hours}.</span>
        {WHATSAPP_READY && <a className="hc-btn hc-btn-wa" href={WA(`Hi Anutech, I am ${name}. I just asked for a call about custom software.`)} target="_blank" rel="noopener">WhatsApp us now</a>}
      </div>
    );
  }
  return (
    <form className="hc-form" id="start" onSubmit={submit} aria-label="Request a call about custom software">
      <b className="hc-form-title">Tell us what to automate</b>
      <span className="hc-form-sub">A free call, no obligation. We reply in working hours.</span>
      <label htmlFor="hc-name">Your name</label>
      <input id="hc-name" name="fullName" required minLength={2} autoComplete="name" />
      <label htmlFor="hc-phone">Mobile number</label>
      <input id="hc-phone" name="phone" type="tel" required minLength={10} inputMode="tel" autoComplete="tel" />
      <label htmlFor="hc-need">What takes your team the most time? <small>(optional)</small></label>
      <textarea id="hc-need" name="need" rows={3} maxLength={600} placeholder="e.g. We make quotes in Excel and chase payments on WhatsApp" />
      {ts.widget}
      <button type="submit" className="hc-btn hc-btn-primary" disabled={state === "sending"}>{state === "sending" ? "Sending…" : "Request a call →"}</button>
      {state === "error" && <p className="hc-err" role="alert">{err}</p>}
    </form>
  );
}

const CSS = `
.hc{background:${C.surf};color:${C.body};font-family:var(--font-sans),'Archivo',system-ui,sans-serif}
.hc-wrap{max-width:1180px;margin:0 auto;padding-inline:48px}
.hc-eyebrow{font-family:${MONO};font-size:10.5px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:${C.blue}}
.hc-center{text-align:center}
.hc-h1{font-size:44px;font-weight:700;letter-spacing:-.04em;line-height:1.06;color:${C.ink};margin:14px 0 14px;text-wrap:balance}
.hc-h1 em{font-style:normal;color:${C.blue}}
.hc-h2{font-size:30px;font-weight:700;letter-spacing:-.03em;line-height:1.15;color:${C.ink};margin:8px 0 8px;text-wrap:balance}
.hc-lead{font-size:17.5px;line-height:1.6;margin:0 0 16px;max-width:620px}
.hc-sub{font-size:15.5px;line-height:1.6;margin:0 0 24px;max-width:720px}
.hc-ticks{list-style:none;padding:0;margin:0 0 22px;display:flex;flex-wrap:wrap;gap:8px 18px;font-size:14px;font-weight:600;color:${C.green}}
.hc-ticks li::before{content:"✓ "}
.hc-actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.hc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:9px;padding:13px 20px;font-size:15px;font-weight:600;text-decoration:none;border:1px solid transparent;cursor:pointer;font-family:inherit}
.hc .hc-btn-primary{background:linear-gradient(180deg,#1668E3,#0A47A0);color:#fff;box-shadow:0 12px 26px -16px rgba(22,104,227,.7)}
.hc-btn-primary:disabled{opacity:.6;cursor:wait}
.hc .hc-btn-wa{background:#fff;color:${C.green};border-color:${C.green}}
.hc .hc-btn-ghost{background:#fff;color:${C.blue};border-color:${C.border}}
.hc .hc-btn-light{background:#fff;color:${C.blueDk}}
.hc-btn:focus-visible,.hc-card:focus-visible,.hc-faq-row button:focus-visible{outline:3px solid ${C.blueDk};outline-offset:2px}

.hc-hero{display:grid;grid-template-columns:1.25fr 1fr;gap:48px;align-items:center;padding-block:48px 56px}
.hc-form{display:flex;flex-direction:column;gap:6px;background:${C.surfT};border:1px solid ${C.borderL};border-radius:16px;padding:24px;box-shadow:0 24px 50px -36px rgba(12,17,22,.45);scroll-margin-top:96px}
.hc-form-title{font-size:19px;color:${C.ink}}
.hc-form-sub{font-size:13px;color:${C.sec};margin-bottom:8px}
.hc-form label{font-size:13px;font-weight:600;color:${C.ink2};margin-top:6px}
.hc-form label small{font-weight:400;color:${C.faint}}
.hc-form input,.hc-form textarea{font:inherit;font-size:15px;padding:11px 12px;border:1px solid ${C.border};border-radius:8px;background:#fff;color:${C.ink};width:100%;box-sizing:border-box}
.hc-form textarea{resize:vertical;min-height:76px}
.hc-form input:focus,.hc-form textarea:focus{outline:2px solid ${C.blue};outline-offset:0;border-color:${C.blue}}
.hc-form .hc-btn{margin-top:12px}
.hc-form-done{gap:10px}
.hc-form-done b{font-size:18px;color:${C.green}}
.hc-err{color:#B3261E;font-size:13px;margin:6px 0 0}

.hc [id]{scroll-margin-top:96px}
.hc-band{background:${C.sectT};border-top:1px solid ${C.hair};border-bottom:1px solid ${C.hair};padding-block:56px}
.hc-grid3{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.hc-tile{display:flex;flex-direction:column;gap:6px;background:#fff;border:1px solid ${C.borderL};border-radius:12px;padding:20px;box-shadow:0 12px 30px -26px rgba(12,17,22,.3)}
.hc-tile b{font-size:16.5px;color:${C.ink};letter-spacing:-.01em}
.hc-tile span:last-child{font-size:14px;line-height:1.55}
.hc-ico{display:inline-flex;width:40px;height:40px;align-items:center;justify-content:center;border-radius:10px;background:#E8F0FD;color:${C.blue};margin-bottom:6px}

.hc-proof{display:grid;grid-template-columns:1.2fr 1fr;gap:40px;align-items:center;padding-block:56px}
.hc-proof-list{list-style:none;margin:0;padding:22px 24px;display:grid;gap:12px;background:${C.greenT};border:1px solid #CFE7D8;border-radius:14px}
.hc-proof-list li{display:flex;gap:10px;font-size:15.5px;font-weight:600;color:${C.ink}}
.hc-proof-list li span{color:${C.green}}

.hc-steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 40px}
.hc-steps li{display:flex;gap:16px;padding:16px 0;border-top:1px solid ${C.borderL}}
.hc-step-n{font-family:${MONO};font-size:13px;color:${C.blue};font-weight:500;width:26px;flex:none;padding-top:2px}
.hc-step-body{flex:1;display:flex;flex-direction:column;gap:3px}
.hc-step-body b{font-size:16px;color:${C.ink}}
.hc-step-body span{font-size:14px;line-height:1.5}
.hc-step-who{font-family:${MONO};font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${C.sec};flex:none;padding-top:3px}

.hc-it{padding-block:56px}
.hc-grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.hc .hc-card{display:flex;flex-direction:column;background:#fff;border:1px solid ${C.borderL};border-radius:11px;padding:0 17px 14px;box-shadow:0 12px 30px -26px rgba(12,17,22,.3);text-decoration:none;color:inherit;overflow:hidden}
.hc-card-img{position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:16/9;margin:0 -17px 12px;background:linear-gradient(135deg,#F2F6FB,#E8ECF1);border-bottom:1px solid ${C.hair};overflow:hidden}
.hc-card-img img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.hc-card-name{font-size:15px;color:${C.ink}}
.hc-card-price{display:flex;align-items:baseline;gap:6px;margin-top:8px}
.hc-card-price span{font-family:${MONO};font-size:22px;font-weight:500;color:${C.ink};font-variant-numeric:tabular-nums}
.hc-card-price small{font-family:${MONO};font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:${C.sec}}
.hc-card-gst{font-size:11.5px;color:${C.sec}}
.hc-card-body{font-size:13px;line-height:1.45;color:${C.sec};margin:10px 0 12px;flex:1}
.hc .hc-card-cta{padding-top:12px;border-top:1px solid ${C.hair};font-size:13px;font-weight:600;color:${C.blue}}
.hc-reseller{margin:20px 0 0;font-size:14px;color:${C.sec}}
.hc .hc-reseller a{color:${C.blue};font-weight:600}

.hc-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;text-align:center}
.hc-facts b{display:block;font-size:24px;letter-spacing:-.02em;color:${C.ink};overflow-wrap:anywhere}
.hc-facts span{display:block;font-family:${MONO};font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:${C.sec};margin-top:4px}

.hc-faq{max-width:820px;padding-block:56px}
.hc-faq .hc-h2{margin-bottom:18px}
.hc-faq-row{border-top:1px solid ${C.borderL}}
.hc-faq-row button{width:100%;display:flex;justify-content:space-between;align-items:center;gap:16px;background:none;border:0;cursor:pointer;padding:18px 0;text-align:left;font:inherit;font-size:16.5px;font-weight:600;color:${C.ink}}
.hc-faq-row button span:last-child{font-family:${MONO};font-size:19px;color:${C.blue}}
.hc-faq-row p{font-size:15px;line-height:1.6;margin:0 0 20px}

.hc-final{background:linear-gradient(135deg,#0A47A0,#1668E3);padding-block:44px}
.hc-final-in{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap}
.hc-on-dark{color:#fff}
.hc-on-dark-sub{color:#DCE8FB;font-size:15.5px;line-height:1.55;margin:0;max-width:640px}

@media (max-width:980px){
  .hc-wrap{padding-inline:20px}
  .hc-hero,.hc-proof{grid-template-columns:1fr;gap:28px}
  .hc-hero{padding-block:32px 40px}
  .hc-h1{font-size:32px}
  .hc-h2{font-size:25px}
  .hc-grid3{grid-template-columns:1fr 1fr}
  .hc-grid4,.hc-facts{grid-template-columns:1fr 1fr}
  .hc-steps{grid-template-columns:1fr}
  .hc-band,.hc-proof,.hc-it,.hc-faq{padding-block:40px}
}
@media (max-width:560px){
  .hc-grid3,.hc-grid4{grid-template-columns:1fr}
  .hc-actions .hc-btn{flex:1 1 100%}
}
`;
