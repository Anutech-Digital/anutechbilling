"use client";
/**
 * TrialForm — the vendor trial request ("Anutech Trial"). No card (Pardeep, 5 Oct 2026, R-157).
 *
 * Ported faithfully from the design handoff (Anutech Trial.dc.html): two collapsible
 * sections, a sticky request rail, a four-question FAQ, and a confirmation view. Pick an
 * edition and how many mailboxes (always a clean start); give the contact details; the request
 * goes to ResellerOS through /api/enquiry (a lead) AND is handed off by email/WhatsApp.
 *
 * ─── No card ─────────────────────────────────────────────────────────────────
 * Until 5 Oct this page asked for a ₹1 card check and said the trial "continues at the
 * published rate unless you cancel", while the buy page and the ad pages said "no card".
 * Pardeep chose one rule for the whole site: the vendor's reseller trial needs no card,
 * nothing is charged, and when it ends the customer decides — buy, or it simply ends.
 *
 * ─── Rates ──────────────────────────────────────────────────────────────────
 * Rates ("after the trial") are the live editions the page supplies — the same source the
 * home and quote use — so a trial never quotes a price the app would then contradict. The
 * design's static ₹136 is overridden by the live catalogue (GW Starter ₹270). Search tags
 * and the richer one-line notes come from the design, keyed by edition name.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LICENCE_EDITIONS, type LicenceEdition } from "@/site/lib/data/catalog";
import { WHATSAPP_URL, COMPANY } from "@/site/lib/config";
import { BusyPanel } from "@/components/ui/busy-panel";
import { useTurnstile } from "@/components/shared/turnstile";
import type { MergedEdition } from "@/site/lib/live-catalog";
import { enquiryReference, referenceNote } from "@/site/lib/enquiry-reference";

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const P = "var(--primary)";
const GREEN = "#0F7B4F";
const GREEN_TINT = "#EEF7F0";
const MAX_IDS = 10;

/** Full vendor labels + design search tags + one-line notes, keyed by edition name. */
const META: Record<string, { label: string; vendor: string; tags: string; note: string }> = {
  "GW Business Starter": { label: "Google Workspace Business Starter", vendor: "Google Workspace", tags: "gmail meet drive docs sheets slides calendar gemini 30gb", note: "30 GB per user · Gmail, Meet, Drive" },
  "GW Business Standard": { label: "Google Workspace Business Standard", vendor: "Google Workspace", tags: "gmail meet recordings shared drives 2tb esignature", note: "2 TB per user · Meet recordings" },
  "GW Business Plus": { label: "Google Workspace Business Plus", vendor: "Google Workspace", tags: "vault ediscovery compliance endpoint 5tb audit retention", note: "5 TB per user · Vault, eDiscovery" },
  "M365 Business Basic": { label: "Microsoft 365 Business Basic", vendor: "Microsoft 365", tags: "outlook teams onedrive exchange webmail sharepoint", note: "50 GB mailbox · web Office, Teams" },
  "M365 Business Standard": { label: "Microsoft 365 Business Standard", vendor: "Microsoft 365", tags: "outlook desktop word excel powerpoint teams webinars onedrive", note: "Desktop Office · 1 TB OneDrive" },
  "Zoho Workplace": { label: "Zoho Workplace Standard", vendor: "Zoho Workplace", tags: "writer sheet show cliq zoho mail workdrive india cheapest", note: "30 GB mailbox · Writer, Sheet, Show" },
};
const labelOf = (n: string) => META[n]?.label ?? n;
const vendorOf = (n: string) => META[n]?.vendor ?? (n.startsWith("GW ") ? "Google Workspace" : n.startsWith("M365 ") ? "Microsoft 365" : "Zoho Workplace");
const noteOf = (n: string, fallback: string) => META[n]?.note ?? fallback;

const MAIL_TODAY = ["Nothing yet — this is a new setup", "Personal Gmail or Yahoo", "cPanel or hosting mail", "Workspace / M365 from another reseller", "Not sure — please check for us"];

const TRIAL_FAQ = [
  { q: "What if we do not buy?", a: "The trial simply ends. We hand over any data you created and remove the mailboxes — nothing is charged and no card is ever asked for." },
  { q: "Can we add people mid-trial?", a: "Yes, up to the vendor's free cap. Beyond that we tell you the rate first; nothing starts without your approval." },
  { q: "Will our current mail break?", a: "No. Your live mail keeps running on your existing provider until you decide — we only cut over when you say so." },
  { q: "Do we get the same rate afterwards?", a: `Yes, the published rate on the quote, and it stays the same at renewal. GST 18% (HSN ${COMPANY.hsn}) is billed separately.` },
];

export function TrialForm({ editions }: { editions?: MergedEdition[] }) {
  const params = useSearchParams();
  const LIST: readonly LicenceEdition[] = editions && editions.length ? editions : LICENCE_EDITIONS;

  const [ed, setEd] = useState("GW Business Starter");
  const [seats, setSeats] = useState(3);
  const [open, setOpen] = useState<"plan" | "detail">("plan");
  const [planDone, setPlanDone] = useState(false);
  /* Open on the chosen product's own category, not "All editions" — a long catalogue is
     noise to someone who already picked Google Workspace (Pardeep, 4 Oct 2026). */
  const [cat, setCat] = useState(() => vendorOf("GW Business Starter"));
  const [query, setQuery] = useState("");
  const [company, setCompany] = useState("");
  const ts = useTurnstile(); // R-020
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [domain, setDomain] = useState("");
  const [startWhen, setStartWhen] = useState("");
  const [current, setCurrent] = useState(MAIL_TODAY[0]);
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  /* Honest feedback (owner, 30 Sep 2026). Until then a failed send still showed the
     "request received" screen — the fetch's errors were swallowed on purpose. */
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  /** Did our system email the customer a copy? Only then do we say "check your inbox". */
  const [ackSent, setAckSent] = useState(false);
  const [reqNo, setReqNo] = useState("");
  const [reqAt, setReqAt] = useState<Date | null>(null);
  const [delivered, setDelivered] = useState<"email" | "wa" | "">("");

  /* Home ka Trial button edition + users URL me bhejta hai; draft localStorage me. */
  useEffect(() => {
    const p = params.get("ed") ?? params.get("edition");
    if (p && LIST.some((e) => e.name === p)) { setEd(p); setCat(vendorOf(p)); }
    const s = parseInt(params.get("seats") ?? "", 10);
    if (s > 0) setSeats(Math.min(MAX_IDS, s));
    try {
      const raw = window.localStorage.getItem("anutech-trial-draft");
      if (raw) {
        const d = JSON.parse(raw) as Record<string, string>;
        if (d.company) setCompany(d.company);
        if (d.email) setEmail(d.email);
        if (d.phone) setPhone(d.phone);
        if (d.domain) setDomain(d.domain);
        if (d.startWhen) setStartWhen(d.startWhen);
        if (d.current && MAIL_TODAY.includes(d.current)) setCurrent(d.current);
        if (d.company && d.domain && d.email && d.phone) setPlanDone(true);
      }
    } catch { /* private window */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem("anutech-trial-draft", JSON.stringify({ company, email, phone, domain, startWhen, current })); } catch { /* ignore */ }
  }, [company, email, phone, domain, startWhen, current]);

  const edition = LIST.find((e) => e.name === ed) ?? LIST[0];
  const rateAfter = `${inr(edition.annual)}/user/mo + GST`;

  const cats = useMemo(() => ["all", ...Array.from(new Set(LIST.map((e) => vendorOf(e.name))))], [LIST]);
  const q = query.trim().toLowerCase();
  const visible = LIST.filter((e) => {
    if (e.name === ed) return true;
    if (cat !== "all" && vendorOf(e.name) !== cat) return false;
    if (!q) return true;
    return (labelOf(e.name) + " " + noteOf(e.name, e.note) + " " + vendorOf(e.name) + " " + (META[e.name]?.tags ?? "")).toLowerCase().includes(q);
  });
  const noMatch = (!!q || cat !== "all") && visible.filter((e) => e.name !== ed).length === 0;

  const setIds = (n: number) => setSeats(Math.max(1, Math.min(MAX_IDS, n)));
  const atCap = seats >= MAX_IDS;

  const errs: Record<string, string> = {};
  if (company.trim().length < 2) errs.company = "Tell us who the trial is for.";
  if (!email.includes("@") || email.trim().length < 5) errs.email = "A working email — the logins go here.";
  const digits = phone.replace(/\D/g, "");
  if (!digits) errs.phone = "So we can reach you while setting up.";
  else if (digits.length !== 10 || !/^[6-9]/.test(digits)) errs.phone = "Enter a 10-digit Indian mobile number.";
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim())) errs.domain = "A domain like yourcompany.in — no http, no @.";
  const filled = Object.keys(errs).length === 0;
  const show = (k: string) => (touched && errs[k]) || "";

  const rows: { k: string; v: string }[] = [
    { k: "Edition", v: labelOf(ed) },
    { k: "Email IDs in the trial", v: `${seats} ${seats === 1 ? "ID" : "IDs"}` },
    { k: "Existing mail", v: "Clean start — copied in free when you buy" },
    { k: "Domain", v: domain.trim() ? domain.trim().toLowerCase() : "—" },
    { k: "Mail today", v: current },
    { k: "Rate if you keep it", v: rateAfter },
    { k: "Preferred start", v: startWhen.trim() || "As soon as possible" },
  ];

  const requestText = (no: string) =>
    [
      `TRIAL REQUEST${no ? ` ${no}` : ""}`,
      "",
      ...rows.map((r) => `· ${r.k}: ${r.v}`),
      "",
      `· Company contact: ${email || "—"} · ${phone || "—"}`,
      "",
      "Please set up the vendor trial on this domain and confirm the trial length and free-mailbox cap in writing.",
      "No card. Remind me two days before the trial ends; I will tell you then whether we buy.",
    ].join("\n");

  const activation = [
    { n: "01", t: "Send and receive on your own domain — check it does not land in spam." },
    { n: "02", t: "Add the account on everyone's phone, and on Outlook if your office uses it." },
    { n: "03", t: "Share a file or a calendar invite inside the team." },
    { n: "04", t: "Run one real meeting and one shared document, the way you actually work." },
  ];
  const steps = [
    { n: "01", t: "We reply on WhatsApp with the vendor's trial length and free-user cap, in writing." },
    { n: "02", t: "We create the mailboxes on your domain and set the DNS records — you do nothing." },
    { n: "03", t: "You get empty mailboxes and logins for the team." },
    { n: "04", t: "Two days before the trial ends we remind you. Want to keep it? Say yes and we send the GST quote at the published rate. Say nothing and the trial simply ends — nothing is charged." },
  ];

  async function submit() {
    setTouched(true);
    /* Never fail silently: the button can sit far below the field that is wrong (a saved
       draft with no mobile number looked like a dead button — Pardeep, 4 Oct 2026). Say
       what is missing next to the button, then take the person to the first bad field. */
    if (!filled) {
      setOpen("detail");
      const names: Record<string, string> = { company: "company", domain: "domain", email: "email", phone: "mobile number" };
      setFormErr(`Please fill in: ${Object.keys(errs).map((k) => names[k] ?? k).join(", ")}.`);
      setTimeout(() => {
        const el = document.querySelector<HTMLInputElement>("[data-trial-bad=\"1\"]");
        if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.focus({ preventScroll: true }); }
      }, 60);
      return;
    }
    setFormErr(null);
    /* R-228: the request's number is the APP's (draft quote number, else lead id) from
       /api/enquiry — never a per-browser counter, which gave every new visitor AT-…-001. */
    const now = new Date();
    let no = "";
    setSending(true);
    setSubmitErr(null);
    try {
      const requirement = `TRIAL: ${labelOf(ed)}, ${seats} mailbox(es) on ${domain.trim().toLowerCase()}, clean start, mail today: ${current}${startWhen ? `, preferred start: ${startWhen}` : ""}. If they keep it: ${rateAfter}. No card. (via anutech.in trial page)`;
      const res = await fetch("/api/enquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ts.headers },
        body: JSON.stringify({ fullName: company, companyName: company, email, phone, product: `Trial — ${labelOf(ed)}`, seats, requirement, edition: ed, term: "annual", trial: true }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; ackSent?: boolean; reference?: string | null };
      if (!res.ok || !json.ok) {
        setSubmitErr(json.error || "We could not send your trial request. Nothing was saved — please press the button to try again.");
        ts.reset();
        setSending(false);
        return;
      }
      setAckSent(json.ackSent === true);
      no = enquiryReference(json);
    } catch {
      setSubmitErr("We could not reach our server, so your trial request was not sent. Check your connection and press the button to try again.");
      setSending(false);
      return;
    }
    setReqNo(no); setReqAt(now); setSent(true); setSending(false);
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { /* ignore */ }
  }

  const fmt = (d: Date) => `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${d.getFullYear()}`;
  const mailHref = `mailto:${COMPANY.supportEmail}?subject=${encodeURIComponent(`Trial request${reqNo ? ` ${reqNo}` : ""} — ${labelOf(ed)}`)}&body=${encodeURIComponent(requestText(reqNo))}`;
  const waHref = `${WHATSAPP_URL}?text=${encodeURIComponent(requestText(reqNo))}`;
  const orderHref = `/quote?ed=${encodeURIComponent(ed)}&seats=${seats}&term=annual`;

  const card: React.CSSProperties = { background: "#fff", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 12px 30px -26px rgba(12,17,22,.3)" };
  const secHead = (isOpen: boolean): React.CSSProperties => ({ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "16px 18px", background: "none", border: "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit", borderBottom: isOpen ? "1px solid var(--border-light)" : "none" });
  const mark = (done: boolean): React.CSSProperties => ({ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: 999, fontSize: 12, fontWeight: 700, flex: "none", background: done ? GREEN : "#F2F6FB", color: done ? "#fff" : "#5C6672" });

  /* ─── CONFIRMATION VIEW ─────────────────────────────────────────────────── */
  if (sent) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, ...card, padding: "18px 20px", marginBottom: 20 }}>
          <span aria-hidden style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: 999, background: GREEN, color: "#fff", fontSize: 17, flex: "none" }}>✓</span>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text)" }}>We have received {reqNo ? <>trial request {reqNo}</> : "your trial request"}</div>
            <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>
              {ackSent
                ? <>A confirmation is on its way to <b style={{ color: "var(--text)" }}>{email}</b> — check your inbox, and the spam folder if it is not there in a few minutes.</>
                : <>We could not email you a copy, so we will call or WhatsApp you on <b style={{ color: "var(--text)" }}>{phone}</b> to confirm the trial.</>}
              {delivered === "email" ? " Your mail app also opened with the request written, if you want to add anything."
                : delivered === "wa" ? " WhatsApp also opened with the request written, if you want to add anything."
                : " We confirm the trial length and cap before switching anything on."}
            </div>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 20, alignItems: "start" }} data-grid="trial">
          {/* summary */}
          <div style={{ ...card, padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text)" }}>{labelOf(ed)} — trial</span>
              <span className={reqNo ? "mono" : undefined} style={{ fontSize: 12, color: "var(--text-muted)" }}>{referenceNote(reqNo, { received: true, ackSent })}</span>
            </div>
            <div className="meta" style={{ marginBottom: 10 }}>{reqAt && fmt(reqAt)}</div>
            {rows.map((r) => (
              <div key={r.k} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, padding: "7px 0", borderTop: "1px solid var(--border-hairline)" }}>
                <span style={{ color: "var(--text-muted)" }}>{r.k}</span>
                <span style={{ color: "var(--text)", fontWeight: 500, textAlign: "right" }}>{r.v}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, padding: "7px 0", borderTop: "1px solid var(--border-hairline)" }}>
              <span style={{ color: "var(--text-muted)" }}>Charged during the trial</span>
              <span style={{ color: GREEN, fontWeight: 600 }}>₹0 — no card</span>
            </div>
          </div>
          {/* what happens next + handoffs */}
          <div style={{ ...card, padding: 18 }}>
            <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 8 }}>WHAT HAPPENS NEXT</div>
            {steps.map((s) => (
              <div key={s.n} style={{ display: "flex", gap: 12, padding: "9px 0", borderTop: "1px solid var(--border-hairline)" }}>
                <span className="mono" style={{ fontSize: 12, color: P, fontWeight: 600, flex: "none", width: 22 }}>{s.n}</span>
                <span style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>{s.t}</span>
              </div>
            ))}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
              <a href={mailHref} onClick={() => setDelivered("email")} className="btn btn-primary" style={{ width: "100%" }}>Email the request</a>
              <a href={waHref} target="_blank" rel="noopener" onClick={() => setDelivered("wa")} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", fontSize: 14.5, fontWeight: 600, padding: "11px 16px", borderRadius: 9, background: "#25D366", color: "#0A2B18", border: "1px solid #1DAE52", textDecoration: "none" }}>Send on WhatsApp</a>
              <a href={orderHref} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", fontSize: 14, fontWeight: 600, padding: "11px 16px", borderRadius: 9, background: "#0C1116", color: "#fff", textDecoration: "none" }}>Skip the trial and order</a>
              <button onClick={() => { setSent(false); setOpen("plan"); }} style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 13, cursor: "pointer", marginTop: 2 }}>← Change the request</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ─── BUILDER VIEW ──────────────────────────────────────────────────────── */
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)", gap: 28, alignItems: "start" }} data-grid="trial">
      {/* LEFT */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        {/* Section 1 — What to switch on */}
        <div style={card}>
          <button onClick={() => setOpen(open === "plan" ? "detail" : "plan")} aria-expanded={open === "plan"} style={secHead(open === "plan")}>
            <span style={mark(planDone)}>{planDone ? "✓" : "1"}</span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontSize: 16, fontWeight: 700, color: "var(--text)" }}>What to switch on</span>
              <span style={{ display: "block", fontSize: 13, color: "var(--text-muted)" }}>{labelOf(ed)} · {seats} email ID{seats > 1 ? "s" : ""} · clean start</span>
            </span>
            <span aria-hidden style={{ color: P, fontSize: 18 }}>{open === "plan" ? "▲" : "▼"}</span>
          </button>
          {open === "plan" && (
            <div style={{ padding: 18 }}>
              <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Filter by group" style={{ minHeight: 44, border: "1.5px solid var(--border-strong)", borderRadius: 8, padding: "9px 34px 9px 12px", fontSize: 14, fontFamily: "inherit", background: "#fff", flex: "none" }}>
                  {cats.map((c) => <option key={c} value={c}>{c === "all" ? `All editions (${LIST.length})` : `${c} (${LIST.filter((e) => vendorOf(e.name) === c).length})`}</option>)}
                </select>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search — outlook, vault, teams, zoho…" aria-label="Search editions" style={{ flex: 1, minWidth: 180, minHeight: 44, border: "1.5px solid var(--border-strong)", borderRadius: 8, padding: "10px 12px", fontSize: 14.5, fontFamily: "inherit" }} />
              </div>
              {noMatch && <p className="meta" style={{ margin: "0 0 8px" }}>Nothing matches that — <button onClick={() => { setQuery(""); setCat("all"); }} style={{ background: "none", border: "none", color: P, cursor: "pointer", fontWeight: 600, padding: 0, fontFamily: "inherit", fontSize: 13 }}>clear the filter</button>.</p>}
              <div style={{ display: "flex", flexDirection: "column" }} role="radiogroup" aria-label="Edition">
                {visible.map((e) => {
                  const on = e.name === ed;
                  return (
                    <button key={e.name} onClick={() => setEd(e.name)} role="radio" aria-checked={on}
                      style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 12px", margin: "3px 0", border: `1px solid ${on ? GREEN : "var(--border-light)"}`, borderRadius: 9, background: on ? GREEN_TINT : "#fff", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                      <span style={{ width: 20, height: 20, flex: "none", borderRadius: "50%", border: `1.5px solid ${on ? GREEN : "#C6CED8"}`, background: on ? `radial-gradient(circle, ${GREEN} 45%, #fff 47%)` : "#fff", boxSizing: "border-box" }} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 14.5, fontWeight: 600, color: "var(--text)" }}>{labelOf(e.name)}</span>
                        <span style={{ display: "block", fontSize: 12.5, color: "var(--text-muted)" }}>{noteOf(e.name, e.note)}</span>
                      </span>
                      <span className="mono" style={{ fontSize: 13, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{inr(e.annual)}/user/mo<span style={{ display: "block", textAlign: "right", fontSize: 10.5, color: "#8A939E" }}>after</span></span>
                    </button>
                  );
                })}
              </div>
              {/* email IDs */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: 18 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>How many email IDs required?</div>
                  <div style={{ fontSize: 12, color: atCap ? "var(--warning)" : "var(--text-muted)" }}>{atCap ? "10 is the most we set up on a trial — order the plan for a bigger rollout." : "Up to 10 email IDs on a trial. Start with the people who will actually test it."}</div>
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--border-strong)", borderRadius: 8, overflow: "hidden" }}>
                  <button onClick={() => setIds(seats - 1)} aria-label="Fewer email IDs" style={{ minHeight: 40, padding: "0 13px", border: "none", background: "#fff", cursor: "pointer", color: "var(--text-secondary)", fontSize: 16 }}>–</button>
                  <input value={seats} inputMode="numeric" aria-label="Email IDs" onChange={(e) => setIds(parseInt(e.target.value.replace(/\D/g, ""), 10) || 1)} style={{ width: 44, textAlign: "center", border: "none", borderLeft: "1px solid var(--border-light)", borderRight: "1px solid var(--border-light)", fontFamily: "var(--font-mono), monospace", fontSize: 15, minHeight: 40 }} />
                  <button onClick={() => setIds(seats + 1)} aria-label="More email IDs" style={{ minHeight: 40, padding: "0 13px", border: "none", background: "#fff", cursor: "pointer", color: "var(--text-secondary)", fontSize: 16 }}>+</button>
                </span>
              </div>
              {/* A vendor trial is always a clean start, so there is nothing to ask (Pardeep,
                  4 Oct 2026). Old mail is copied in free once the customer buys. */}
              <p className="meta" style={{ marginTop: 18 }}>Trials start with empty mailboxes. When you buy, we copy your old mail, folders and contacts in — free.</p>
              {/* provenance */}
              <div style={{ display: "flex", gap: 10, marginTop: 16, padding: 12, background: "#FBFCFE", border: "1px solid var(--border-hairline)", borderRadius: 10 }}>
                <span aria-hidden style={{ color: GREEN, fontWeight: 700, flex: "none" }}>✓</span>
                <span style={{ fontSize: 12, lineHeight: 1.55, color: "var(--text-secondary)", minWidth: 0 }}>
                  The vendor&apos;s own trial, set up by us on your domain as an authorised reseller — Google Premier Partner since 2014. Length and the free-user cap are the vendor&apos;s; we confirm both in writing before we start. No card is asked for and nothing is charged during the trial; when it ends you decide whether to buy at the published rate. Rates shown are India-region list rates — we add nothing on top: GST 18% (HSN {COMPANY.hsn}) is billed separately, the renewal stays at the same rate, and if a vendor changes a rate you get thirty days&apos; written notice.
                </span>
              </div>
              <button onClick={() => { setPlanDone(true); setOpen("detail"); }} className="btn btn-primary" style={{ marginTop: 16 }}>Continue to details →</button>
            </div>
          )}
        </div>

        {/* Section 2 — Where to set it up */}
        <div style={card}>
          <button onClick={() => setOpen(open === "detail" ? "plan" : "detail")} aria-expanded={open === "detail"} style={secHead(open === "detail")}>
            <span style={mark(filled)}>{filled ? "✓" : "2"}</span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontSize: 16, fontWeight: 700, color: "var(--text)" }}>Where to set it up</span>
              <span style={{ display: "block", fontSize: 13, color: "var(--text-muted)" }}>{filled ? `${company} · ${domain.trim().toLowerCase()}` : "Company, domain, email and mobile"}</span>
            </span>
            <span aria-hidden style={{ color: P, fontSize: 18 }}>{open === "detail" ? "▲" : "▼"}</span>
          </button>
          {open === "detail" && (
            <div style={{ padding: 18 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <TField label="Company" value={company} set={setCompany} err={show("company")} />
                <TField label="Domain (e.g. yourcompany.in)" value={domain} set={(v) => setDomain(v.replace(/[^a-z0-9.-]/gi, "").toLowerCase())} err={show("domain")} mono />
                <TField label="Email — the logins go here" value={email} set={setEmail} err={show("email")} kind="email" />
                <TField label="Mobile" value={phone} set={setPhone} err={show("phone")} kind="tel" />
                <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>Where does mail run today?
                  <select value={current} onChange={(e) => setCurrent(e.target.value)} style={{ width: "100%", marginTop: 4, minHeight: 44, border: "1.5px solid var(--border-strong)", borderRadius: 8, padding: "9px 11px", fontSize: 14, fontFamily: "inherit", background: "#fff" }}>
                    {MAIL_TODAY.map((m) => <option key={m}>{m}</option>)}
                  </select>
                </label>
                <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>Preferred start <span style={{ color: "var(--text-muted)" }}>(optional)</span>
                  <input type="date" value={startWhen} onChange={(e) => setStartWhen(e.target.value)} style={{ width: "100%", marginTop: 4, minHeight: 44, border: "1.5px solid var(--border-strong)", borderRadius: 8, padding: "9px 11px", fontSize: 14, fontFamily: "inherit" }} />
                </label>
              </div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "14px 0 0" }}><b style={{ color: GREEN }}>No card, nothing charged.</b> When the trial ends you decide — buy at {rateAfter}, or it simply ends.</p>
              {formErr && !filled && <div role="alert" style={{ background: "#FFF7ED", border: "1px solid #FED7AA", color: "#9A3412", borderRadius: 8, padding: "11px 14px", fontSize: 14, margin: "12px 0" }}>{formErr}</div>}
              {submitErr && <div role="alert" style={{ background: "#FEF2F2", border: "1px solid #FECACA", color: "#991B1B", borderRadius: 8, padding: "11px 14px", fontSize: 14, margin: "12px 0" }}>{submitErr} If it keeps failing, email <a href={`mailto:${COMPANY.supportEmail}`} style={{ color: "#991B1B", fontWeight: 600 }}>{COMPANY.supportEmail}</a>.</div>}
              <BusyPanel active={sending} title="Sending your trial request" steps={["Sending your details to our team", "Preparing your request reference"]} />
              {ts.widget}
              <button onClick={submit} disabled={sending} className="btn btn-primary" style={{ width: "100%", marginTop: 16, opacity: sending ? 0.7 : 1 }}>
                {sending ? "Requesting…" : "Request the free trial"}
              </button>
              <p className="meta" style={{ textAlign: "center", marginTop: 8 }}>A person replies on WhatsApp in working hours.</p>
            </div>
          )}
        </div>

        {/* FAQ */}
        <div style={{ ...card, padding: 18 }}>
          <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 4 }}>BEFORE YOU ASK</div>
          {TRIAL_FAQ.map((f) => (
            <div key={f.q} style={{ padding: "12px 0", borderTop: "1px solid var(--border-hairline)" }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{f.q}</div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55 }}>{f.a}</div>
            </div>
          ))}
        </div>
      </div>

      {/* RIGHT — sticky rail */}
      <div style={{ position: "sticky", top: 86, ...card, padding: 18, minWidth: 0 }}>
        <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 10 }}>YOUR TRIAL REQUEST</div>
        {rows.map((r) => (
          <div key={r.k} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, padding: "6px 0", borderTop: "1px solid var(--border-hairline)" }}>
            <span style={{ color: "var(--text-muted)" }}>{r.k}</span>
            <span style={{ color: "var(--text)", fontWeight: 500, textAlign: "right", minWidth: 0, wordBreak: "break-word" }}>{r.v}</span>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, padding: "8px 0", borderTop: "1px solid var(--border-light)", marginTop: 2 }}>
          <span style={{ fontWeight: 600 }}>Charged during the trial</span>
          <span style={{ color: GREEN, fontWeight: 700 }}>₹0 — no card</span>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, margin: "6px 0 0" }}>If you keep it after the trial: {rateAfter}, and the renewal rate stays the same. If not, it simply ends.</p>

        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border-hairline)" }}>
          {["We do the setup — mailboxes, DNS and logins", "Old mail copied in free once you buy", "Reminder two days before it ends — you decide, nothing is automatic", "Keep it and the published rate applies — nothing extra"].map((b) => (
            <span key={b} style={{ display: "flex", gap: 8, fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.45 }}><span aria-hidden style={{ color: GREEN, fontWeight: 700, flex: "none" }}>✓</span><span>{b}</span></span>
          ))}
        </div>

        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border-hairline)" }}>
          <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 8 }}>WHAT TO TEST IN THE FIRST THREE DAYS</div>
          {activation.map((a) => (
            <div key={a.n} style={{ display: "flex", gap: 10, padding: "5px 0" }}>
              <span className="mono" style={{ fontSize: 11.5, color: P, fontWeight: 600, flex: "none", width: 18 }}>{a.n}</span>
              <span style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.45 }}>{a.t}</span>
            </div>
          ))}
          <p className="meta" style={{ marginTop: 8 }}>If any of it does not work the way you need, tell us during the trial — that is what it is for.</p>
        </div>

        {formErr && !filled && <div role="alert" style={{ background: "#FFF7ED", border: "1px solid #FED7AA", color: "#9A3412", borderRadius: 8, padding: "11px 14px", fontSize: 14, margin: "12px 0" }}>{formErr}</div>}
              {submitErr && <div role="alert" style={{ background: "#FEF2F2", border: "1px solid #FECACA", color: "#991B1B", borderRadius: 8, padding: "11px 14px", fontSize: 14, margin: "12px 0" }}>{submitErr} If it keeps failing, email <a href={`mailto:${COMPANY.supportEmail}`} style={{ color: "#991B1B", fontWeight: 600 }}>{COMPANY.supportEmail}</a>.</div>}
        <BusyPanel active={sending} title="Sending your trial request" steps={["Sending your details to our team", "Preparing your request reference"]} />
        <button onClick={submit} disabled={sending} className="btn btn-primary" style={{ width: "100%", marginTop: 14, opacity: sending ? 0.7 : 1 }}>
          {sending ? "Requesting…" : "Request the free trial"}
        </button>
        <p className="meta" style={{ textAlign: "center", marginTop: 8 }}>Would rather see the price first? <a href={orderHref} style={{ color: P, fontWeight: 600 }}>Build a quote</a> instead.</p>
      </div>
    </div>
  );
}

function TField({ label, value, set, err, kind = "text", mono }: { label: string; value: string; set: (v: string) => void; err: string; kind?: string; mono?: boolean }) {
  const bad = !!err;
  return (
    <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>{label}
      <input type={kind} value={value} onChange={(e) => set(e.target.value)} data-trial-bad={bad ? "1" : undefined} aria-invalid={bad || undefined} style={{ width: "100%", marginTop: 4, minHeight: 44, border: `1.5px solid ${bad ? "#C2410C" : "var(--border-strong)"}`, borderRadius: 8, padding: "9px 11px", fontSize: 14, fontFamily: mono ? "var(--font-mono), monospace" : "inherit" }} />
      {bad && <span style={{ display: "block", fontSize: 11.5, color: "#C2410C", marginTop: 3 }}>{err}</span>}
    </label>
  );
}

