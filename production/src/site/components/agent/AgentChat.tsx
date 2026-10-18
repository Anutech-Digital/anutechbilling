"use client";
/**
 * "Talk to us" — the website's ONE floating launcher. R-1498 (17 Oct 2026, Pawan): it used to
 * sit above a separate WhatsApp pill and the two covered content; now pressing it opens a small
 * menu with "Chat with our AI sales agent" and "WhatsApp us" (same wa.me link). The panel is
 * a small chat whose answers come from the app's public agent — live catalogue prices,
 * guarded server-side (production/src/lib/ai/public-sales-chat.ts holds the rules).
 *
 * The widget itself is deliberately thin: it renders text, it never computes a price, and
 * when the agent suggests a quote it renders a LINK to /quote with the selection prefilled
 * — the same handover the calculator uses, so every priced document keeps coming from the
 * one proven path.
 *
 * Failure shape: if the agent cannot answer, the visitor is told plainly and offered
 * WhatsApp — never a spinner that outlives its welcome, never an invented answer.
 */
import Link from "@/site/components/ui/SiteLink";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { WHATSAPP_URL, WHATSAPP_READY } from "@/site/lib/config";
import { hideFloatingOn } from "@/site/components/chrome/Chrome";
import { floatingLauncher, useAvoidFloating, useIsMobile } from "@/site/components/chrome/floating";

interface Msg {
  role: "user" | "assistant";
  text: string;
  suggestQuote?: { tier: "starter" | "standard" | "plus"; seats: number; term: "annual" | "monthly" } | null;
  /** Set when THIS reply filed the lead — renders the confirmation chip. */
  leadCreated?: { quoteId: string | null } | null;
}

/** The /quote page's edition names for the agent's tier ids. */
const TIER_EDITION: Record<string, string> = {
  starter: "GW Business Starter",
  standard: "GW Business Standard",
  plus: "GW Business Plus",
};

const GREETING: Msg = {
  role: "assistant",
  /* Pehla practical sawaal greeting me hi — discovery wahi se shuru hoti hai.
     R-235 (7 Oct): site English hai, to greeting/error/chips/placeholder English; agent
     visitor ki bhasha mirror karta hai (Hindi/Hinglish me likhe to wahi) — public-sales-chat.ts. */
  text: "Hello! I'm Anutech's AI sales assistant — prices come from our live catalogue. How many people need business email?",
};

/* v2 (R-235): purane tab me padi Hinglish greeting wali chat wapas na aaye. */
const STORE_KEY = "anutech.agentchat.v2";

interface Stored { msgs: Msg[]; leadCaptured: boolean }

function loadStored(): Stored | null {
  /* try/catch har storage-touch par — private window me accessor khud throw karta hai,
     aur ek chat jo page gira de wo khoi hui chat se buri hai. */
  try {
    const raw = window.sessionStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Stored;
    if (!Array.isArray(j.msgs) || j.msgs.length === 0) return null;
    return { msgs: j.msgs.slice(-24), leadCaptured: j.leadCaptured === true };
  } catch {
    return null;
  }
}

export function AgentChat() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  /* R-464: phone par form (data-avoid-floating) screen par ho to launcher hat jaata hai. */
  const isMobile = useIsMobile();
  const avoidOnScreen = useAvoidFloating(pathname);
  const [msgs, setMsgs] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /* Ek chat, ek lead — server ko har request me batate hain ki lead ban chuki, taaki
     model dobara lead field bhare to bhi doosri row na bane. */
  const [leadCaptured, setLeadCaptured] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* Reload-proof: tab ke andar baat-cheet sessionStorage me rehti hai (layout-mount
     navigation sambhalta hai; ye poora reload sambhalta hai). SESSION storage, local
     nahi — kal tak visitor ke browser me padi baat-cheet uski umeed ke khilaaf hai. */
  useEffect(() => {
    const stored = loadStored();
    if (stored) {
      setMsgs(stored.msgs);
      setLeadCaptured(stored.leadCaptured);
    }
  }, []);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORE_KEY, JSON.stringify({ msgs: msgs.slice(-24), leadCaptured }));
    } catch { /* storage band — in-memory chat phir bhi chalti hai */ }
  }, [msgs, leadCaptured]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs, busy]);

  /* R-1498: ek hi floating launcher — dabane par chhota menu (AI chat + WhatsApp). Menu khulte
     hi pehla item focus; Escape / bahar click band karta hai, Escape focus launcher par lautata hai. */
  const [menuOpen, setMenuOpen] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    firstItemRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      launcherRef.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (menuRef.current?.contains(t) || launcherRef.current?.contains(t))) return;
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [menuOpen]);
  const onLauncher = () => {
    // Chat khuli ho to launcher use band karta hai (pehle jaisa); warna menu khole/band kare.
    if (open) { setOpen(false); return; }
    setMenuOpen((v) => !v);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setFailed(false);
    const next: Msg[] = [...msgs, { role: "user", text }];
    setMsgs(next);
    setBusy(true);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        /* The greeting is presentation, not conversation — the agent should not have to
           account for words the model never said. Only real turns travel. */
        body: JSON.stringify({
          messages: next.slice(1).slice(-16).map((m) => ({ role: m.role, text: m.text })),
          leadAlreadyCaptured: leadCaptured,
        }),
      });
      /* R-1549: too many messages from this visitor — the server says how long to wait; show that,
         not the generic "couldn't answer". */
      if (res.status === 429) {
        const limited = (await res.json().catch(() => ({}))) as { reply?: string };
        setFailed(true);
        setMsgs((cur) => [...cur, { role: "assistant", text: limited.reply || "You have sent too many messages in a short time. Please wait a few minutes and send it again — or use the Get a quote page." }]);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { reply?: string; suggestQuote?: Msg["suggestQuote"]; leadCreated?: { quoteId: string | null } | null };
      if (!data.reply) throw new Error("empty");
      if (data.leadCreated) setLeadCaptured(true);
      setMsgs((cur) => [...cur, { role: "assistant", text: data.reply!, suggestQuote: data.suggestQuote ?? null, leadCreated: data.leadCreated ?? null }]);
    } catch {
      setFailed(true);
      setMsgs((cur) => [
        ...cur,
        { role: "assistant", text: "I couldn't answer just now — a person replies on WhatsApp during working hours, or use the Get a quote page for an instant priced estimate." },
      ]);
    } finally {
      setBusy(false);
    }
  };

  /* R-230: /checkout aur /done par kuch float nahi karta — phone par launcher Pay button dhak
     deta tha. Saare hooks upar chal chuke, isliye yahan return safe hai. */
  if (hideFloatingOn(pathname)) return null;
  const showLauncher = floatingLauncher({ pathname, isMobile, avoidOnScreen, chatOpen: open || menuOpen });
  const launcherName = WHATSAPP_READY ? "Talk to us: AI sales agent or WhatsApp" : "Talk to us: AI sales agent";

  return (
    <>
      {/* R-1498: EK hi floating launcher (pehle AI launcher + WhatsApp pill ek ke upar ek the).
          R-230: 980px se neeche poori text wali pill ki jagah 48px gol icon (naam aria-label
          me). Position/size class me — inline style media query ko jeet leta. R-464/R-1495:
          phone par form / plan cards screen par hon to launcher chhup jaata hai. zIndex 90 —
          consent banner (95) ke neeche hi rehta hai. */}
      {showLauncher && (
      <button
        ref={launcherRef}
        type="button"
        onClick={onLauncher}
        aria-expanded={menuOpen || open}
        aria-controls={menuOpen ? "agent-launcher-menu" : undefined}
        aria-label={launcherName}
        className="agent-launcher"
        style={{
          position: "fixed", zIndex: 90,
          display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 9,
          background: "var(--primary)", color: "#fff", border: "none", borderRadius: 999,
          fontSize: 14, fontWeight: 600, cursor: "pointer",
          boxShadow: "var(--shadow-panel)", fontFamily: "inherit",
        }}
      >
        <span aria-hidden className="agent-launcher-dot" style={{ width: 8, height: 8, borderRadius: 999, background: "#7EF0B2", animation: "wPulse 1.6s infinite" }} />
        <svg aria-hidden className="agent-launcher-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span className="agent-launcher-text">Talk to us</span>
        <style jsx>{`
          .agent-launcher { right: 22px; bottom: 22px; min-height: 44px; padding: 12px 18px; }
          .agent-launcher-icon { display: none; }
          @media (max-width: 979px) {
            .agent-launcher { width: 48px; height: 48px; padding: 0; right: 16px; bottom: 16px; }
            .agent-launcher-text, .agent-launcher-dot { display: none; }
            .agent-launcher-icon { display: block; }
          }
        `}</style>
      </button>
      )}

      {/* R-1498: launcher ka menu — dono kaam yahin. Har item 44px uncha (touch target). */}
      {showLauncher && menuOpen && (
        <div
          ref={menuRef}
          id="agent-launcher-menu"
          className="agent-launcher-menu"
          style={{
            position: "fixed", zIndex: 91, minWidth: 248, maxWidth: "calc(100vw - 32px)",
            background: "var(--tint-2)", border: "1px solid var(--border)", borderRadius: 12,
            boxShadow: "var(--shadow-menu)", padding: 6, display: "flex", flexDirection: "column", gap: 2,
            animation: "wDrop .16s ease",
          }}
        >
          <button
            ref={firstItemRef}
            type="button"
            className="agent-menu-item"
            onClick={() => { setMenuOpen(false); setOpen(true); }}
          >
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: "var(--primary)" }} />
            Chat with our AI sales agent
          </button>
          {WHATSAPP_READY && (
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener"
              className="agent-menu-item"
              onClick={() => setMenuOpen(false)}
            >
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: "var(--bar-ok)" }} />
              WhatsApp us
            </a>
          )}
          <style jsx>{`
            .agent-launcher-menu { right: 22px; bottom: 76px; }
            .agent-menu-item {
              display: flex; align-items: center; gap: 10px; min-height: 44px; width: 100%;
              padding: 10px 12px; border: none; border-radius: 8px; background: transparent;
              color: var(--text); font: inherit; font-size: 14px; font-weight: 600;
              text-align: left; cursor: pointer;
            }
            .agent-menu-item:hover { background: var(--tint); color: var(--primary); }
            .agent-menu-item:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
            @media (max-width: 979px) {
              .agent-launcher-menu { right: 16px; bottom: 72px; }
            }
          `}</style>
        </div>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="AI sales agent chat"
          style={{
            position: "fixed", right: 22, bottom: 80, zIndex: 96,
            width: 360, maxWidth: "92vw", height: 460, maxHeight: "70vh",
            background: "#fff", border: "1px solid var(--border)", borderRadius: 12,
            boxShadow: "var(--shadow-menu)", display: "flex", flexDirection: "column",
            animation: "wDrop .16s ease", overflow: "hidden",
          }}
        >
          <div style={{ background: "var(--dark)", color: "#fff", padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: "var(--bar-ok)" }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>AI sales agent</div>
              <div className="mono-label" style={{ color: "#9AA5B1" }}>LIVE CATALOGUE PRICES</div>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close chat" style={{ background: "none", border: "none", color: "#9AA5B1", fontSize: 16, cursor: "pointer" }}>✕</button>
          </div>

          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            {msgs.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
                <div
                  style={{
                    padding: "9px 12px", borderRadius: 10, fontSize: 14, lineHeight: 1.45,
                    background: m.role === "user" ? "var(--primary)" : "var(--tint)",
                    color: m.role === "user" ? "#fff" : "var(--text)",
                    border: m.role === "user" ? "none" : "1px solid var(--border)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {m.text}
                </div>
                {m.leadCreated && (
                  <div
                    className="mono-label"
                    style={{ marginTop: 6, display: "inline-block", padding: "6px 10px", borderRadius: 999, background: "#EEF7F0", color: "var(--success)", border: "1px solid var(--success)" }}
                  >
                    {m.leadCreated.quoteId
                      ? `DETAILS RECEIVED — QUOTATION ${m.leadCreated.quoteId} CREATED`
                      : "DETAILS RECEIVED — OUR TEAM WILL BE IN TOUCH"}
                  </div>
                )}
                {m.suggestQuote && TIER_EDITION[m.suggestQuote.tier] && (
                  <Link
                    href={{
                      pathname: "/quote",
                      query: {
                        edition: TIER_EDITION[m.suggestQuote.tier],
                        seats: String(m.suggestQuote.seats),
                        term: m.suggestQuote.term,
                      },
                    }}
                    className="btn btn-primary btn-sm"
                    style={{ marginTop: 6, display: "inline-block" }}
                  >
                    Get this quote — {m.suggestQuote.seats} seats, {m.suggestQuote.term}
                  </Link>
                )}
              </div>
            ))}
            {busy && (
              <div style={{ alignSelf: "flex-start", padding: "9px 12px", borderRadius: 10, background: "var(--tint)", border: "1px solid var(--border)", fontSize: 14, color: "var(--text-muted)" }}>
                typing<span style={{ animation: "wPulse 1.1s infinite" }}>…</span>
              </div>
            )}
            {failed && (
              <a href={WHATSAPP_URL} target="_blank" rel="noopener" className="btn btn-outline btn-sm" style={{ alignSelf: "flex-start" }}>
                WhatsApp us instead
              </a>
            )}
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); void send(); }}
            style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--border-light)" }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. Workspace price for 20 users?"
              aria-label="Message the AI sales agent"
              style={{ flex: 1, border: "1px solid var(--border-strong)", borderRadius: 8, padding: "10px 12px", fontSize: 14, fontFamily: "inherit", minWidth: 0 }}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !input.trim()}>
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}
