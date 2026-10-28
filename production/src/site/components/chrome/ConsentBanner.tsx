"use client";
/**
 * R-2010 (27 Oct 2026, G-DPDP): the ONE cookie-consent banner, on every page that can load the
 * Meta Pixel — the marketing site (layout) AND /buy/workspace + its thanks page. Before this it
 * lived only in the (marketing) layout, so an ad visitor landing on /buy was never asked and the
 * Pixel / Conversions API never ran; and it said only "Analytics cookies", never Meta.
 *
 * DPDP Act 2023 / Rules 2025: consent must be free, specific, informed and unambiguous, and
 * withdrawing must be as easy as giving. So:
 *   - both purposes named — "Necessary" (always on) and "Advertising measurement (Meta)" with
 *     exactly what is shared — plus the Privacy policy link;
 *   - "Accept all" and "Only necessary" look the same (equal weight), no pre-ticked box;
 *   - "Cookie settings" (footer) reopens it with the current choice, and a change applies at
 *     once (the Pixel starts / stops without a reload — site/lib/meta-pixel.tsx).
 *
 * Styled inline (not with site.css classes) because the buy page is outside `.anutech-site`.
 * The `.consent-banner` class is kept: WorkspacePricing pads its sticky bar when it is shown.
 *
 * R-2022 (27 Oct 2026, localhost check of R-2020 at 375x812): on a phone (≤640px) the full text
 * was a tall box scrolling inside itself over "What do you need?", with both buttons only
 * reachable by scrolling inside it; and one tap on "Only necessary" also chose the card under it.
 *   - ≤640px: ONE short line (Meta named) + "Details", which expands the same full text — still
 *     one tap away; the buttons sit outside the scrolling text, so they are always in view.
 *   - Above 640px nothing changes (no short line, no Details, the full text as before).
 *   - The choice is made in the button's own click; that click stops there, and the second click
 *     a phone fires at the same spot just after the banner closes (the "ghost" tap) is swallowed,
 *     so the card underneath is chosen only by its own tap.
 */
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import {
  readConsent, saveConsent, onConsentOpen, openConsentSettings, type ConsentChoice,
} from "@/site/lib/consent";

const BTN: CSSProperties = {
  flex: "1 1 0", minHeight: 44, padding: "10px 14px", borderRadius: 8,
  border: "1.5px solid #1F2A37", background: "#FFFFFF", color: "#111827",
  fontSize: 14, fontWeight: 600, lineHeight: 1.2, cursor: "pointer", fontFamily: "inherit",
};

const LABEL: Record<ConsentChoice, string> = { all: "Accept all", essential: "Only necessary" };

/** How long after a choice a click at the banner's old spot counts as the same tap (R-2022). */
const GHOST_CLICK_MS = 700;

/**
 * R-2022: a phone can fire a second, synthesised click at the spot the finger lifted from, after
 * the banner is gone — it would land on whatever was underneath (the intent card). For a short
 * moment, swallow a click inside the banner's last box; any click elsewhere, or later, is normal.
 */
function swallowGhostClick(rect: DOMRect): void {
  if (typeof window === "undefined" || rect.width <= 0 || rect.height <= 0) return;
  const until = Date.now() + GHOST_CLICK_MS;
  const onClick = (ev: MouseEvent) => {
    if (Date.now() > until) { off(); return; }
    const inside = ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
    if (!inside) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    off();
  };
  const timer = setTimeout(() => off(), GHOST_CLICK_MS);
  function off() {
    window.removeEventListener("click", onClick, true);
    clearTimeout(timer);
  }
  window.addEventListener("click", onClick, true);
}

export function ConsentBanner() {
  /* "unknown" until mounted — the banner must not flash for a visitor who already chose. */
  const [choice, setChoice] = useState<ConsentChoice | null | "unknown">("unknown");
  const [reopened, setReopened] = useState(false);
  /* R-2022: the full text on a phone (≤640px) — collapsed behind "Details" until asked for. */
  const [expanded, setExpanded] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);
  const firstBtn = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    setChoice(readConsent());
    return onConsentOpen(() => {
      opener.current = typeof document !== "undefined" ? document.activeElement : null;
      setChoice(readConsent());
      setReopened(true);
    });
  }, []);

  const open = choice === null || reopened;
  useEffect(() => {
    if (reopened) firstBtn.current?.focus();
  }, [reopened]);

  if (choice === "unknown" || !open) return null;

  const close = () => {
    setReopened(false);
    const el = opener.current as HTMLElement | null;
    if (el && typeof el.focus === "function") el.focus();
  };
  const choose = (e: ReactMouseEvent<HTMLButtonElement>, value: ConsentChoice) => {
    /* R-2022: the tap ends here — never on the card that is under the banner once it closes. */
    e.preventDefault();
    e.stopPropagation();
    const rect = bannerRef.current?.getBoundingClientRect();
    if (rect) swallowGhostClick(rect);
    saveConsent(value);
    setChoice(value);
    close();
  };

  return (
    <div
      ref={bannerRef}
      role="region"
      data-expanded={expanded ? "true" : "false"}
      aria-labelledby="consent-title"
      aria-describedby="consent-short consent-body"
      className="consent-banner"
      onKeyDown={(e) => { if (e.key === "Escape" && reopened) { e.stopPropagation(); close(); } }}
      style={{
        position: "fixed", zIndex: 95, background: "#FFFFFF", color: "#1F2A37",
        border: "1px solid #D0D5DD", borderRadius: 10, padding: 18,
        boxShadow: "0 12px 32px rgba(16, 24, 40, 0.18)", fontSize: 14, lineHeight: 1.5,
        display: "flex", flexDirection: "column",
      }}
    >
      {/* R-230: below 980px the banner spans the screen with a 12px gutter (375px phones).
          R-2022: only the text scrolls (.consent-scroll) — the two buttons are always in view;
          ≤640px shows one short line + Details instead of the full text. */}
      <style>{`
        .consent-banner { left: 22px; bottom: 22px; max-width: 400px; }
        .consent-short { display: none; }
        .consent-scroll { min-height: 0; overflow-y: auto; }
        .consent-actions { display: flex; gap: 10px; flex-wrap: wrap; flex-shrink: 0; }
        @media (max-width: 979px) {
          .consent-banner { left: 12px; right: 12px; bottom: 12px; max-width: none; max-height: calc(100vh - 24px); }
        }
        @media (max-width: 640px) {
          .consent-banner { padding: 12px 14px !important; font-size: 13px !important; line-height: 1.45 !important; }
          .consent-title { display: none; }
          .consent-short { display: block; margin: 0 0 8px; }
          .consent-banner[data-expanded="false"] .consent-full { display: none; }
          .consent-actions { gap: 8px; }
        }
      `}</style>
      <div className="consent-scroll">
      <p id="consent-title" className="consent-title" style={{ margin: "0 0 8px", paddingRight: 28, fontWeight: 700, fontSize: 15, color: "#111827" }}>
        Cookies on this site
      </p>
      <p id="consent-short" className="consent-short" style={{ paddingRight: reopened ? 28 : 0 }}>
        We use necessary cookies; with your OK, Meta measures our ads.{" "}
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="consent-body"
          onClick={() => setExpanded((v) => !v)}
          style={{ background: "none", border: 0, padding: "4px 2px", margin: "-4px 0", font: "inherit", fontWeight: 600, color: "#1849A9", textDecoration: "underline", cursor: "pointer" }}
        >
          {expanded ? "Hide details" : "Details"}
        </button>
      </p>
      <div id="consent-body" className="consent-full">
        <p style={{ margin: "0 0 8px" }}>
          <strong>Necessary</strong> — always on. Keeps the cart, checkout and security working, and remembers this choice.
        </p>
        <p style={{ margin: "0 0 8px" }}>
          <strong>Advertising measurement (Meta)</strong> — only if you accept. Meta (Facebook, Instagram) receives the pages
          you visit, the purchase value if you buy, your email and phone in hashed form, and your IP address and browser,
          so we can measure our ads.
        </p>
        <p style={{ margin: "0 0 12px", color: "#475467" }}>
          Change this any time from Cookie settings at the bottom of the page.{" "}
          <a href="/privacy-policy" style={{ color: "#1849A9", textDecoration: "underline" }}>Privacy policy</a>
        </p>
      </div>
      {reopened && choice && (
        <p style={{ margin: "0 0 12px", fontWeight: 600 }} aria-live="polite">Your current choice: {LABEL[choice]}</p>
      )}
      </div>
      <div className="consent-actions">
        <button ref={firstBtn} type="button" className="consent-btn" style={BTN} onClick={(e) => choose(e, "all")}>Accept all</button>
        <button type="button" className="consent-btn" style={BTN} onClick={(e) => choose(e, "essential")}>Only necessary</button>
      </div>
      {reopened && (
        <button
          type="button"
          onClick={close}
          aria-label="Close without changing"
          style={{ position: "absolute", top: 6, right: 6, width: 36, height: 36, border: 0, background: "transparent", color: "#475467", fontSize: 20, lineHeight: 1, cursor: "pointer", borderRadius: 6 }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** The footer's "Cookie settings" — reopens the banner (withdrawing is as easy as giving). */
export function CookieSettingsButton({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <button
      type="button"
      onClick={openConsentSettings}
      className={className}
      style={{ background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer", textAlign: "left", ...style }}
    >
      Cookie settings
    </button>
  );
}
