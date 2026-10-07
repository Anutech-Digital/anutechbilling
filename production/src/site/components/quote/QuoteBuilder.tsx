"use client";
/**
 * QuoteBuilder — the multi-line quote page ("Anutech Quote" handoff, 5 Sep 2026).
 *
 * Two collapsible steps (What to quote · Where to send it), a live summary rail,
 * and a generated quote document with email / WhatsApp / print hand-off. It is a
 * faithful port of the handoff, wired to REAL data (QUOTE_PRODUCTS from the
 * repo's catalogue) and to the app's REAL backend: "Generate" POSTs the
 * requirement to ResellerOS through /api/enquiry (a lead in the sales pipeline,
 * with the GW auto-quote path preserved), then shows the document for the
 * customer to send by email or WhatsApp — one tap each, not automatic delivery.
 *
 * Money maths (WHOLE RUPEES, CLAUDE.md §13): a monthly-cycle line on an annual
 * commitment bills ×12 (a year on this invoice); once-a-year lines (domain, SSL,
 * onsite) bill once. Payable = round(subtotal × 1.18). Renewal annualises every
 * line at today's rate. Every figure is derived, never hardcoded.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { QUOTE_PRODUCTS, QUOTE_CATEGORIES, QUOTE_TLDS, withLiveEditions, quoteRate, quoteInr, type QuoteProduct } from "@/site/lib/data/quote-catalog";
import { WHATSAPP_URL, COMPANY } from "@/site/lib/config";
import { BusyPanel } from "@/components/ui/busy-panel";
import { useTurnstile } from "@/components/shared/turnstile";
import type { MergedEdition } from "@/site/lib/live-catalog";
import { enquiryReference, referenceNote } from "@/site/lib/enquiry-reference";

/* R-224: hosting rates carry paise (₹49.99) — print them exactly as /rates does, not rounded. */
const inr = quoteInr;
const P = "var(--primary)";

export function QuoteBuilder({ editions }: { editions?: MergedEdition[] }) {
  const params = useSearchParams();

  // Live rates (if the page supplied them) override the static edition prices. An edition
  // with no flexible tier comes back with monthly: null — annual only (R-224).
  const products = useMemo<QuoteProduct[]>(() => withLiveEditions(QUOTE_PRODUCTS, editions), [editions]);
  const byName = useMemo(() => new Map(products.map((p) => [p.name, p])), [products]);

  const [lines, setLines] = useState<Record<string, number>>({ "GW Business Starter": 1 });
  const [term, setTerm] = useState<"annual" | "monthly">("annual");
  const [openSec, setOpenSec] = useState<"plan" | "details">("plan");
  const [cat, setCat] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [domainTld, setDomainTld] = useState(".in");
  const [tldQuery, setTldQuery] = useState("");
  // contact
  const [company, setCompany] = useState("");
  const ts = useTurnstile(); // R-020
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [gstin, setGstin] = useState("");
  const [mailToday, setMailToday] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  // submit / doc
  const [submitState, setSubmitState] = useState<"idle" | "sending" | "done" | "failed">("idle");
  const [err, setErr] = useState("");
  /* Did the requirement reach our team? The quote is shown either way (it is built here and
     is valid to send by hand), but it must not look sent when it was not (30 Sep 2026: this
     used to clear the error and show the quote as if the team had it). */
  const [teamHasIt, setTeamHasIt] = useState<boolean | null>(null);
  const [teamErr, setTeamErr] = useState("");
  const [ackSent, setAckSent] = useState(false);
  const [quoteNo, setQuoteNo] = useState("");
  const [quoteAt, setQuoteAt] = useState<Date | null>(null);
  const [delivered, setDelivered] = useState<"email" | "wa" | "">("");

  // Prefill from the home/hero deep link (?ed & seats & term).
  useEffect(() => {
    const ed = params.get("ed") ?? params.get("edition");
    const seats = Math.max(1, Math.min(300, parseInt(params.get("seats") ?? "", 10) || 0));
    const t = params.get("term");
    const next: Record<string, number> = {};
    if (ed && byName.has(ed)) {
      next[ed] = seats || 1;
      /* Open on that product's category, not "All plans" (Pardeep, 4 Oct 2026). */
      const v = byName.get(ed)?.vendor;
      if (v) setCat(v);
    }
    if (Object.keys(next).length) setLines(next);
    /* A deep link asking for monthly on an annual-only edition stays annual (R-224). */
    const edAnnualOnly = !!ed && byName.get(ed)?.monthly === null;
    if (t === "annual" || (t === "monthly" && !edAnnualOnly)) setTerm(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const annual = term === "annual";
  const rateOf = (p: QuoteProduct): number => {
    if (p.domain && p.domainField) return QUOTE_TLDS.find((t) => t.tld === domainTld)?.[p.domainField] ?? 0;
    /* Annual-only lines never sit in a monthly basket (toggle + term guard below), so the
       annual fallback is unreachable in practice — it only keeps the type a number. */
    return quoteRate(p, term) ?? p.annual;
  };
  const annualOnly = (p: QuoteProduct) => p.monthly === null;
  const amountOf = (p: QuoteProduct, qty: number): number => (p.cycle === "mo" ? rateOf(p) * qty * (annual ? 12 : 1) : rateOf(p) * qty);

  const selected = products.filter((p) => (lines[p.name] ?? 0) > 0);
  const subtotal = selected.reduce((n, p) => n + amountOf(p, lines[p.name]), 0);
  const payable = Math.round(subtotal * 1.18);
  const gst = payable - subtotal;
  const renewal = Math.round(selected.reduce((n, p) => n + (p.cycle === "mo" ? rateOf(p) * lines[p.name] * 12 : rateOf(p) * lines[p.name]), 0) * 1.18);
  // Saving from annual commitment, over discountable (monthly-cycle) lines only.
  const moLines = selected.filter((p) => p.cycle === "mo" && p.monthly !== null && p.monthly > p.annual);
  const savePct = moLines.length
    ? Math.round((1 - moLines.reduce((n, p) => n + p.annual * lines[p.name], 0) / moLines.reduce((n, p) => n + (p.monthly ?? p.annual) * lines[p.name], 0)) * 100)
    : 0;
  // Selected lines with no flexible tier — while any is in the basket, Flexible monthly is off.
  const annualOnlyPicked = selected.filter(annualOnly);

  const setQty = (nm: string, q: number) => setLines((L) => { const v = Math.max(0, Math.min(999, q)); const c = { ...L }; if (v === 0) delete c[nm]; else c[nm] = v; return c; });
  const toggle = (nm: string) => setLines((L) => {
    const c = { ...L };
    if (c[nm]) delete c[nm];
    else if (!annual && byName.get(nm)?.monthly === null) return L; // annual only — not on a monthly quote
    else c[nm] = 1;
    return c;
  });

  // Products visible in the picker: category + search, but a selected line always shows.
  const q = query.trim().toLowerCase();
  const visible = products.filter((p) => {
    if ((lines[p.name] ?? 0) > 0) return true;
    if (cat !== "all" && p.vendor !== cat) return false;
    if (!q) return true;
    return (p.label + " " + p.note + " " + p.vendor + " " + p.tags).toLowerCase().includes(q);
  });
  const catCount = (c: string) => products.filter((p) => p.vendor === c).length;
  const anyDomainSelected = selected.some((p) => p.domain);

  const quoteText = () => {
    const L = selected.map((p) => `• ${p.label}${p.domain ? " " + domainTld : ""} — ${lines[p.name]} × ${inr(rateOf(p))}/${p.per}/${p.cycle === "mo" ? (annual ? "mo (×12)" : "mo") : "yr"} = ${inr(amountOf(p, lines[p.name]))}`).join("\n");
    return [
      `Quotation ${quoteNo || "(draft)"} — Anutech Digital`,
      `For: ${company || "—"}${gstin ? " · GSTIN " + gstin : ""}`,
      term === "annual" ? "Billing: annual commitment" : "Billing: flexible monthly",
      "",
      L,
      "",
      `Subtotal ${inr(subtotal)}`,
      `GST 18% ${inr(gst)}`,
      `Payable on this invoice ${inr(payable)}`,
      `Renews ${inr(renewal)}/yr at today's rates`,
      "",
      "Rate held 15 days · ₹0 migration · GST invoice on payment · renewal unchanged (30 days' notice).",
    ].join("\n");
  };

  const valid = company.trim().length >= 2 && name.trim().length >= 2 && email.includes("@") && isIndianMobile(phone) && selected.length > 0 && (gstin === "" || gstin.length === 15);

  async function generate() {
    setTouched(true); setErr("");
    if (!valid) { setOpenSec(selected.length === 0 ? "plan" : "details"); setErr("Add at least one line, and a company, name, valid email and 10-digit phone — that's where the formal quotation goes."); return; }
    /* R-228: the quote's number is the APP's (draft quote number, else lead id) from
       /api/enquiry — never a per-browser counter, which gave every new visitor AQ-…-001. */
    const now = new Date();

    setSubmitState("sending");
    try {
      const primary = selected.find((p) => /^GW |^M365 |^Zoho/.test(p.name));
      const requirement = quoteText().replace(/\n/g, " · ") + (mailToday ? ` · mail today: ${mailToday}` : "") + (note ? ` · note: ${note}` : "") + " (via anutech.in quote page)";
      const res = await fetch("/api/enquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ts.headers },
        body: JSON.stringify({
          fullName: name, companyName: company, email, phone,
          product: selected.length === 1 ? selected[0].label : `Multi-line quote (${selected.length} items)`,
          /* R-157: the licence's own user count. Summing every line (domains, hosting, SSL too)
             priced the automatic Workspace quote for users nobody asked for. */
          seats: primary ? lines[primary.name] : selected.reduce((s, p) => s + lines[p.name], 0),
          requirement,
          edition: primary?.name, term,
        }),
      });
      const data = (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; error?: string; ackSent?: boolean; reference?: string | null };
      if (!res.ok || !data.ok) throw new Error(data.error || "Our team did not receive it.");
      setTeamHasIt(true); setTeamErr(""); setAckSent(data.ackSent === true);
      setQuoteNo(enquiryReference(data)); setQuoteAt(now); setSubmitState("done");
    } catch (e) {
      ts.reset();
      // The quote is still valid to hand off manually — shown, and marked NOT received.
      setTeamHasIt(false);
      setTeamErr(e instanceof Error ? e.message : "We could not reach our server.");
      setQuoteNo(""); setQuoteAt(now); setSubmitState("done");
    }
  }

  const validTill = quoteAt ? new Date(quoteAt.getTime() + 15 * 864e5) : null;
  const fmt = (d: Date) => `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${d.getFullYear()}`;

  // ── styles ────────────────────────────────────────────────────────────────
  const card: React.CSSProperties = { background: "#fff", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 12px 30px -26px rgba(12,17,22,.3)" };
  const secHead = (open: boolean): React.CSSProperties => ({ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "16px 18px", background: "none", border: "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit", borderBottom: open ? "1px solid var(--border-light)" : "none" });
  const stepMark = (done: boolean): React.CSSProperties => ({ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: 999, fontSize: 12, fontWeight: 700, flex: "none", background: done ? "var(--success)" : P, color: "#fff" });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)", gap: 28, alignItems: "start" }} data-grid="quote">
      {/* ── LEFT: the two steps ─────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        {/* Step 1 — What to quote */}
        <div style={card}>
          <button onClick={() => setOpenSec(openSec === "plan" ? "details" : "plan")} aria-expanded={openSec === "plan"} style={secHead(openSec === "plan")}>
            <span style={stepMark(selected.length > 0)}>{selected.length > 0 ? "✓" : "1"}</span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontSize: 16, fontWeight: 700, color: "var(--text)" }}>What to quote</span>
              <span style={{ display: "block", fontSize: 13, color: "var(--text-muted)" }}>{selected.length ? `${selected.length} line${selected.length > 1 ? "s" : ""} · ${inr(payable)} on this invoice` : "Pick one or more products"}</span>
            </span>
            <span aria-hidden style={{ color: P, fontSize: 18 }}>{openSec === "plan" ? "▲" : "▼"}</span>
          </button>
          {openSec === "plan" && (
            <div style={{ padding: 18 }}>
              {/* category + search */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                <button className="chip" aria-pressed={cat === "all"} onClick={() => setCat("all")}>All plans ({products.length})</button>
                {QUOTE_CATEGORIES.map((c) => <button key={c} className="chip" aria-pressed={cat === c} onClick={() => setCat(c)}>{c} ({catCount(c)})</button>)}
              </div>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search — outlook, vault, wildcard, hosting…" aria-label="Search products"
                style={{ width: "100%", minHeight: 44, border: "1.5px solid var(--border-strong)", borderRadius: 8, padding: "10px 12px", fontSize: 14.5, fontFamily: "inherit", marginBottom: 8 }} />
              {/* commitment toggle */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", padding: "8px 0 12px" }}>
                <div style={{ display: "inline-flex", background: "var(--tint)", border: "1px solid var(--border)", borderRadius: 999, padding: 3 }}>
                  {(["annual", "monthly"] as const).map((t) => {
                    const off = t === "monthly" && annualOnlyPicked.length > 0;
                    return (
                      <button key={t} onClick={() => setTerm(t)} aria-pressed={term === t} disabled={off} aria-describedby={off ? "annual-only-note" : undefined}
                        style={{ cursor: off ? "not-allowed" : "pointer", border: "none", borderRadius: 999, padding: "7px 14px", fontSize: 13, fontWeight: term === t ? 600 : 500, background: term === t ? P : "transparent", color: term === t ? "#fff" : off ? "var(--text-muted)" : "var(--text-secondary)", fontFamily: "inherit", minHeight: 40 }}>
                        {t === "annual" ? "Annual commitment" : "Flexible monthly"}
                      </button>
                    );
                  })}
                </div>
                <span style={{ fontSize: 13, color: savePct > 0 ? "var(--success)" : "var(--text-muted)", fontWeight: 600 }}>
                  {savePct > 0 ? `Annual saves ${savePct}% on this basket` : "Commitment doesn't change domain or certificate rates"}
                </span>
              </div>
              {annualOnlyPicked.length > 0 && (
                <p id="annual-only-note" className="meta" style={{ margin: "-4px 0 10px", fontSize: 13 }}>
                  {annualOnlyPicked.map((p) => p.label).join(", ")} {annualOnlyPicked.length > 1 ? "are" : "is"} annual only. Remove {annualOnlyPicked.length > 1 ? "them" : "it"} for a monthly quote.
                </p>
              )}
              {/* rows */}
              <div style={{ display: "flex", flexDirection: "column" }}>
                {visible.length === 0 && (
                  <p className="meta" style={{ padding: "16px 0" }}>Nothing matches. <button onClick={() => { setQuery(""); setCat("all"); }} style={{ background: "none", border: "none", color: P, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Show all plans</button></p>
                )}
                {visible.map((p) => {
                  const on = (lines[p.name] ?? 0) > 0;
                  const locked = !on && !annual && annualOnly(p); // annual only, monthly quote
                  const lockNoteId = `annual-only-${p.name.replace(/[^A-Za-z0-9_-]/g, "-")}`;
                  return (
                    <div key={p.name} style={{ borderTop: "1px solid var(--border-hairline)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0" }}>
                        <button onClick={() => toggle(p.name)} role="checkbox" aria-checked={on} aria-label={`Select ${p.label}`} disabled={locked} aria-describedby={locked ? lockNoteId : undefined}
                          style={{ width: 22, height: 22, flex: "none", borderRadius: 6, border: `1.5px solid ${on ? "var(--success)" : "var(--border-strong)"}`, background: on ? "var(--success)" : locked ? "var(--tint)" : "#fff", color: "#fff", cursor: locked ? "not-allowed" : "pointer", fontSize: 13, lineHeight: 1 }}>{on ? "✓" : ""}</button>
                        <button onClick={() => toggle(p.name)} disabled={locked} aria-describedby={locked ? lockNoteId : undefined} style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", cursor: locked ? "not-allowed" : "pointer", fontFamily: "inherit", padding: 0 }}>
                          <span style={{ display: "block", fontSize: 14.5, fontWeight: 600, color: "var(--text)" }}>{p.label}</span>
                          <span style={{ display: "block", fontSize: 12.5, color: "var(--text-muted)" }}>{p.note}</span>
                        </button>
                        <span id={locked ? lockNoteId : undefined} className="mono" style={{ fontSize: 13.5, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                          {!annual && annualOnly(p) ? "Annual only" : rateOf(p) === 0 ? "Free" : `${inr(rateOf(p))}/${p.per}`}
                        </span>
                        {on && (
                          <span style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--border-strong)", borderRadius: 8, overflow: "hidden", flex: "none" }}>
                            <button onClick={() => setQty(p.name, lines[p.name] - 1)} aria-label="Fewer" style={{ minHeight: 36, padding: "0 10px", border: "none", background: "#fff", cursor: "pointer", color: "var(--text-secondary)" }}>–</button>
                            <input value={lines[p.name]} inputMode="numeric" aria-label={`${p.label} quantity`} onChange={(e) => setQty(p.name, parseInt(e.target.value.replace(/\D/g, ""), 10) || 0)} style={{ width: 40, textAlign: "center", border: "none", borderLeft: "1px solid var(--border-light)", borderRight: "1px solid var(--border-light)", fontFamily: "var(--font-mono), monospace", fontSize: 14, minHeight: 36 }} />
                            <button onClick={() => setQty(p.name, lines[p.name] + 1)} aria-label="More" style={{ minHeight: 36, padding: "0 10px", border: "none", background: "#fff", cursor: "pointer", color: "var(--text-secondary)" }}>+</button>
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* domain extension picker */}
              {anyDomainSelected && (
                <div style={{ marginTop: 12, padding: 12, background: "var(--tint)", border: "1px solid var(--border-light)", borderRadius: 8 }}>
                  <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 8 }}>DOMAIN EXTENSION — DRIVES THE RATE</div>
                  <input value={tldQuery} onChange={(e) => setTldQuery(e.target.value)} placeholder="Filter extensions… .in .com .io" aria-label="Filter extensions"
                    style={{ width: "100%", minHeight: 40, border: "1px solid var(--border-strong)", borderRadius: 7, padding: "8px 10px", fontSize: 13.5, fontFamily: "inherit", marginBottom: 8 }} />
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {QUOTE_TLDS.filter((t) => t.tld.includes(tldQuery.trim().toLowerCase())).map((t) => (
                      <button key={t.tld} onClick={() => setDomainTld(t.tld)} aria-pressed={domainTld === t.tld}
                        style={{ cursor: "pointer", borderRadius: 999, padding: "6px 11px", fontSize: 12.5, fontFamily: "var(--font-mono), monospace", border: `1px solid ${domainTld === t.tld ? "var(--success)" : "var(--border-strong)"}`, background: domainTld === t.tld ? "var(--success)" : "#fff", color: domainTld === t.tld ? "#fff" : "var(--text)" }}>
                        {t.tld} · {inr(t.reg)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Step 2 — Where to send it */}
        <div style={card}>
          <button onClick={() => setOpenSec(openSec === "details" ? "plan" : "details")} aria-expanded={openSec === "details"} style={secHead(openSec === "details")}>
            <span style={stepMark(valid)}>{valid ? "✓" : "2"}</span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontSize: 16, fontWeight: 700, color: "var(--text)" }}>Where to send it</span>
              <span style={{ display: "block", fontSize: 13, color: "var(--text-muted)" }}>{company ? `${company}${email ? " · " + email : ""}` : "Company, contact and email"}</span>
            </span>
            <span aria-hidden style={{ color: P, fontSize: 18 }}>{openSec === "details" ? "▲" : "▼"}</span>
          </button>
          {openSec === "details" && (
            /* R-231: data-grid → one column on a phone (two 1fr columns left ~150px boxes). */
            <div style={{ padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }} data-grid>
              <QField label="Company" value={company} set={setCompany} touched={touched} required autoComplete="organization" />
              <QField label="Your name" value={name} set={setName} touched={touched} required autoComplete="name" />
              <QField label="Mobile" value={phone} set={setPhone} touched={touched} required kind="tel" autoComplete="tel" inputMode="tel" />
              <QField label="Email" value={email} set={setEmail} touched={touched} required kind="email" autoComplete="email" inputMode="email" />
              <div>
                <QField label="GSTIN (optional)" value={gstin} set={(v) => setGstin(v.toUpperCase().slice(0, 15))} touched={touched} />
                {gstin.length > 0 && gstin.length !== 15 && <span style={{ fontSize: 11.5, color: "var(--warning)" }}>{gstin.length}/15 characters</span>}
              </div>
              <QField label="Where does mail run today?" value={mailToday} set={setMailToday} touched={false} placeholder="Gmail, GoDaddy, cPanel…" />
              <label style={{ gridColumn: "1 / -1", fontSize: 13, color: "var(--text-secondary)" }}>
                Anything else (optional)
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} style={{ width: "100%", marginTop: 4, border: "1.5px solid var(--border-strong)", borderRadius: 8, padding: "8px 10px", fontSize: 14, fontFamily: "inherit", resize: "vertical" }} />
              </label>
            </div>
          )}
        </div>
        <p className="meta" style={{ margin: 0 }}>Rates are India-region list prices, GST 18% (HSN {COMPANY.hsn}) billed separately. Nothing is charged until you approve.</p>
      </div>

      {/* ── RIGHT: rail / generated document ────────────────────────────── */}
      <div style={{ position: "sticky", top: 86, ...card, padding: 18, minWidth: 0 }}>
        {submitState !== "done" ? (
          <>
            <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 10 }}>YOUR ESTIMATE</div>
            {selected.length === 0 && <p className="meta" style={{ padding: "8px 0" }}>Pick a product to see the price build up here.</p>}
            {selected.map((p) => (
              <div key={p.name} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--border-hairline)", fontSize: 13.5 }}>
                <span style={{ minWidth: 0 }}>{p.label}{p.domain ? " " + domainTld : ""} <span className="mono" style={{ color: "var(--text-muted)" }}>×{lines[p.name]}</span></span>
                <span className="mono" style={{ whiteSpace: "nowrap" }}>{inr(amountOf(p, lines[p.name]))}</span>
              </div>
            ))}
            {selected.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 13.5 }}>
                <Row l="Subtotal" v={inr(subtotal)} />
                <Row l="GST 18%" v={inr(gst)} />
                <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 4px", borderTop: "1px solid var(--border)", marginTop: 6 }}>
                  <span style={{ fontWeight: 700 }}>Payable on this invoice</span>
                  <span className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{inr(payable)}</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Renews {inr(renewal)}/yr at today&apos;s rates · incl. 18% GST</div>
              </div>
            )}
            {err && <p style={{ fontSize: 13, color: "var(--warning)", marginTop: 10 }}>{err}</p>}
            <BusyPanel
              active={submitState === "sending"}
              title="Preparing your quotation"
              steps={["Sending your requirement to our sales team", "Preparing the quotation with today's prices"]}
            />
            {ts.widget}
            <button onClick={generate} disabled={submitState === "sending"} className="btn btn-primary" style={{ width: "100%", marginTop: 14, opacity: submitState === "sending" ? 0.7 : 1 }}>
              {submitState === "sending" ? "Generating…" : "Generate quotation"}
            </button>
            <p className="meta" style={{ marginTop: 8, textAlign: "center" }}>Sends the requirement to our sales system; you then send the quote by email or WhatsApp — one tap each.</p>
          </>
        ) : (
          <>
          {teamHasIt === false && (
            <div role="alert" style={{ background: "#FEF2F2", border: "1px solid #FECACA", color: "#991B1B", borderRadius: 8, padding: "11px 14px", fontSize: 14, marginBottom: 12 }}>
              Your quotation is below, but it did <b>not</b> reach our team ({teamErr}). Send it to us
              with the email or WhatsApp button, or{" "}
              <button type="button" onClick={() => { setSubmitState("idle"); setTeamHasIt(null); }} style={{ background: "none", border: "none", padding: 0, color: "#991B1B", fontWeight: 700, textDecoration: "underline", cursor: "pointer", font: "inherit" }}>
                go back and try again
              </button>.
            </div>
          )}
          {teamHasIt === true && (
            <div role="status" style={{ background: "#EEF7F0", border: "1px solid #B7DFC4", color: "#1E5C33", borderRadius: 8, padding: "11px 14px", fontSize: 14, marginBottom: 12 }}>
              Our team has your requirement.{" "}
              {ackSent
                ? <>We have emailed you a copy at <b>{email}</b> — check your inbox, and the spam folder if it is not there in a few minutes.</>
                : <>We could not email you a copy, so we will call or WhatsApp you on <b>{phone}</b>.</>}
            </div>
          )}
          <div data-quote-doc>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 6 }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>{COMPANY.name}</span>
              <span className={quoteNo ? "mono" : undefined} style={{ fontSize: 12, color: "var(--text-muted)" }}>{referenceNote(quoteNo, { received: teamHasIt === true, ackSent })}</span>
            </div>
            <div className="meta" style={{ marginBottom: 12 }}>{quoteAt && fmt(quoteAt)} · valid till {validTill && fmt(validTill)} · {term === "annual" ? "annual commitment" : "flexible monthly"}</div>
            <div style={{ fontSize: 13, marginBottom: 10 }}><b>Quote for:</b> {company}{gstin ? ` · GSTIN ${gstin}` : ""}</div>
            {selected.map((p) => (
              <div key={p.name} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--border-hairline)", fontSize: 12.5 }}>
                <span>{p.label}{p.domain ? " " + domainTld : ""} <span className="mono" style={{ color: "var(--text-muted)" }}>{lines[p.name]} × {inr(rateOf(p))}/{p.per} · HSN {COMPANY.hsn}</span></span>
                <span className="mono" style={{ whiteSpace: "nowrap" }}>{inr(amountOf(p, lines[p.name]))}</span>
              </div>
            ))}
            <div style={{ marginTop: 8, fontSize: 13 }}>
              <Row l="Subtotal" v={inr(subtotal)} />
              <Row l="GST 18%" v={inr(gst)} />
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0 2px", borderTop: "1px solid var(--border)", marginTop: 4 }}>
                <b>Payable on this invoice</b><span className="mono" style={{ fontWeight: 700 }}>{inr(payable)}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Renews {inr(renewal)}/yr</div>
            </div>
            <ul style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5, margin: "12px 0 0", paddingLeft: 16 }}>
              <li>Rate held for 15 days.</li><li>Migration is ₹0, done by us.</li><li>Setup included.</li><li>GST invoice issued on payment.</li><li>Renewal at the same rate — 30 days&apos; notice of any change.</li>
            </ul>
            {/* delivery */}
            <div className="no-print" style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
              <a href={`mailto:${encodeURIComponent(email)}?cc=${COMPANY.supportEmail}&subject=${encodeURIComponent(`Quotation${quoteNo ? ` ${quoteNo}` : ""} — Anutech Digital`)}&body=${encodeURIComponent(quoteText())}`} onClick={() => setDelivered("email")} className="btn btn-primary" style={{ width: "100%" }}>Email the quote</a>
              <div style={{ display: "flex", gap: 8 }}>
                <a href={`${WHATSAPP_URL}?text=${encodeURIComponent(quoteText())}`} target="_blank" rel="noopener" onClick={() => setDelivered("wa")} className="btn btn-outline" style={{ flex: 1 }}>Send on WhatsApp</a>
                <button onClick={() => window.print()} className="btn btn-outline" style={{ flex: 1 }}>Save as PDF</button>
              </div>
              <a href={`${WHATSAPP_URL}?text=${encodeURIComponent(`I'd like to order at ${quoteNo ? `quote ${quoteNo}` : "this quote"}: ` + quoteText())}`} target="_blank" rel="noopener" className="btn btn-outline" style={{ width: "100%" }}>Order at this rate</a>
              <button onClick={() => { setSubmitState("idle"); setDelivered(""); }} style={{ background: "none", border: "none", color: P, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", fontSize: 13, paddingTop: 4 }}>Change something</button>
              {delivered && <p className="meta" style={{ textAlign: "center", color: "var(--success)" }}>{delivered === "email" ? "Opened your email app with the quote." : "Opened WhatsApp with the quote."}</p>}
            </div>
          </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ l, v }: { l: string; v: string }) {
  return <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: "var(--text-secondary)" }}><span>{l}</span><span className="mono">{v}</span></div>;
}

/**
 * R-231: a 10-digit Indian mobile (6–9 first), with or without +91 / 0 in front. The old
 * rule only wanted 2 digits, so "12345" looked fine until the quote button refused it.
 */
export function isIndianMobile(v: string): boolean {
  const d = v.replace(/\D/g, "").replace(/^(?:91|0)(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(d);
}

export function QField({ label, value, set, touched, required, kind = "text", placeholder, autoComplete, inputMode }: { label: string; value: string; set: (v: string) => void; touched: boolean; required?: boolean; kind?: string; placeholder?: string; autoComplete?: string; inputMode?: "text" | "email" | "tel" }) {
  const bad = touched && required && (kind === "email" ? !value.includes("@") : kind === "tel" ? !isIndianMobile(value) : value.replace(/\s/g, "").length < 2);
  const msg = kind === "tel" && value.trim() ? "Enter a 10-digit mobile number." : label + " is needed here.";
  return (
    <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>
      {label}
      <input type={kind} value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder} autoComplete={autoComplete} inputMode={inputMode} aria-invalid={bad || undefined}
        style={{ width: "100%", marginTop: 4, minHeight: 44, border: `1.5px solid ${bad ? "var(--warning)" : "var(--border-strong)"}`, borderRadius: 8, padding: "9px 11px", fontSize: 14, fontFamily: "inherit" }} />
      {bad && <span style={{ fontSize: 11.5, color: "var(--warning)" }}>{msg}</span>}
    </label>
  );
}
