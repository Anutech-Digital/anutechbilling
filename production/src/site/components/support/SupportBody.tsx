"use client";
/**
 * Support page body (/contact). Rewritten 30 Sep 2026, when it was first given a route:
 * the original was never rendered (/support is the staff inbox), and several things in it
 * were not true.
 *
 * - The "knowledge base" listed nine article titles with no articles behind them, so a
 *   search found things nobody could open. They are now TOPICS: each one opens an email to
 *   support with the topic as its subject, which is what really happens when you ask.
 * - The call booker offered four fixed dates ("Mon 31 Aug" …) that were already past. The
 *   days are now the next four working days (Mon–Sat, IST), and the button still says what
 *   it does: it writes an email asking for that slot; there is no booking calendar.
 * - WhatsApp, with an "eleven-minute average first reply", pointed at the placeholder
 *   number. It shows only once WHATSAPP_READY is true, and claims no average.
 */
import { useMemo, useState } from "react";
import { KB_ARTICLES, SUPPORT_CHANNELS } from "@/site/lib/data/misc";
import { WHATSAPP_READY, WHATSAPP_URL, COMPANY, CLIENT_AREA_URL, SLA } from "@/site/lib/config";
import { addDaysISO, istToday } from "@/lib/dates/ist";

const SLOTS = ["10:30", "11:30", "14:00", "15:30", "17:00", "18:15"];
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The next `n` working days after today, in IST. Sunday is the day off (COMPANY.hours). */
export function nextWorkingDays(n: number, today: string = istToday()): string[] {
  const out: string[] = [];
  for (let d = addDaysISO(today, 1); out.length < n; d = addDaysISO(d, 1)) {
    if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) out.push(d);
  }
  return out;
}

/** "2026-10-01" → "Thu 01 Oct". */
export function dayLabel(iso: string): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return `${WEEKDAY[dow]} ${iso.slice(8, 10)} ${MONTH[Number(iso.slice(5, 7)) - 1]}`;
}

const mail = (subject: string) => `mailto:${COMPANY.supportEmail}?subject=${encodeURIComponent(subject)}`;
const link = { display: "block", color: "var(--primary)", fontWeight: 600, fontSize: 14, marginBottom: 6 } as const;

export function SupportBody() {
  const days = useMemo(() => nextWorkingDays(4).map(dayLabel), []);
  const [query, setQuery] = useState("");
  const [day, setDay] = useState(days[0]);
  const [slot, setSlot] = useState(SLOTS[0]);

  const q = query.trim().toLowerCase();
  const topics = q ? KB_ARTICLES.filter((a) => (a.title + " " + a.cat).toLowerCase().includes(q)) : KB_ARTICLES;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.4fr .8fr", gap: 40, alignItems: "start" }} data-grid>
      <div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What do you need help with?"
          aria-label="Search help topics"
          style={{ width: "100%", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "13px 14px", fontSize: 15, fontFamily: "inherit", marginBottom: 16 }}
        />
        <div className="meta" style={{ marginBottom: 10 }}>
          {q ? `${topics.length} topic(s) matching “${query}”` : "Common questions — pick one and we answer by email"}
        </div>
        {topics.length === 0 ? (
          <div style={{ border: "1px dashed var(--border-strong)", borderRadius: 8, padding: 28, textAlign: "center" }}>
            <p className="body" style={{ margin: "0 0 12px" }}>Nothing matches that. Describe it in your own words and a person replies.</p>
            <a className="btn btn-primary btn-sm" href={mail(query.trim() || "Support request")}>Email support</a>
          </div>
        ) : (
          topics.map((a) => (
            <a key={a.title} href={mail(a.title)} style={{ display: "flex", gap: 14, alignItems: "baseline", padding: "13px 0", borderBottom: "1px solid var(--border-hairline)", color: "inherit", textDecoration: "none" }}>
              <span className="mono-label" style={{ color: "var(--text-muted)", flex: "none", width: 76 }}>{a.cat}</span>
              <span style={{ fontSize: 15, fontWeight: 500, flex: 1 }}>{a.title}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--primary)", flex: "none" }}>Ask us →</span>
            </a>
          ))
        )}

        <div style={{ marginTop: 28, display: "grid", gap: 12 }}>
          {SUPPORT_CHANNELS.map((c) => (
            <div key={c.title} className="card" style={{ padding: 18 }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{c.title}</div>
              <p className="body" style={{ margin: 0, fontSize: 14 }}>{c.body}</p>
            </div>
          ))}
        </div>
      </div>

      <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="card card-highlight">
          <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Email support</div>
          <p className="body" style={{ margin: "0 0 12px", fontSize: 14 }}>
            {SLA.hours}. We aim to reply {SLA.firstReply}.
          </p>
          <a href={mail("Support request")} className="btn btn-primary btn-sm">{COMPANY.supportEmail}</a>
        </div>

        {WHATSAPP_READY && (
          <div className="card">
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>WhatsApp us</div>
            <p className="body" style={{ margin: "0 0 12px", fontSize: 14 }}>{COMPANY.hours}.</p>
            <a href={WHATSAPP_URL} target="_blank" rel="noopener" className="btn btn-outline btn-sm">Open WhatsApp</a>
          </div>
        )}

        <div className="card">
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Ask for a 15-minute call</div>
          <p className="meta" style={{ margin: "0 0 10px" }}>Pick a time and we confirm it by email.</p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {days.map((d) => (
              <button key={d} type="button" className="chip" aria-pressed={day === d} onClick={() => setDay(d)} style={{ fontSize: 12, padding: "6px 10px" }}>
                {d}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {SLOTS.map((s) => (
              <button key={s} type="button" className="chip chip-primary" aria-pressed={slot === s} onClick={() => setSlot(s)} style={{ fontSize: 12, padding: "6px 10px" }}>
                {s}
              </button>
            ))}
          </div>
          <a className="btn btn-outline btn-sm" style={{ width: "100%" }} href={mail(`Call request — ${day} at ${slot} IST`)}>
            Email a request for {day}, {slot} IST
          </a>
        </div>

        <div className="card" style={{ padding: 18 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Already a customer?</div>
          <a href={CLIENT_AREA_URL} style={link}>Sign in to the client area</a>
          <a href="/refund" style={link}>Refund policy</a>
          <a href="/terms-and-conditions" style={{ ...link, marginBottom: 0 }}>Terms and conditions</a>
        </div>
      </aside>
    </div>
  );
}
