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
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  readConsent, saveConsent, onConsentOpen, openConsentSettings, type ConsentChoice,
} from "@/site/lib/consent";

const BTN: CSSProperties = {
  flex: "1 1 0", minHeight: 44, padding: "10px 14px", borderRadius: 8,
  border: "1.5px solid #1F2A37", background: "#FFFFFF", color: "#111827",
  fontSize: 14, fontWeight: 600, lineHeight: 1.2, cursor: "pointer", fontFamily: "inherit",
};

const LABEL: Record<ConsentChoice, string> = { all: "Accept all", essential: "Only necessary" };

export function ConsentBanner() {
  /* "unknown" until mounted — the banner must not flash for a visitor who already chose. */
  const [choice, setChoice] = useState<ConsentChoice | null | "unknown">("unknown");
  const [reopened, setReopened] = useState(false);
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
  const choose = (value: ConsentChoice) => {
    saveConsent(value);
    setChoice(value);
    close();
  };

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="consent-title"
      aria-describedby="consent-body"
      className="consent-banner"
      onKeyDown={(e) => { if (e.key === "Escape" && reopened) { e.stopPropagation(); close(); } }}
      style={{
        position: "fixed", zIndex: 95, background: "#FFFFFF", color: "#1F2A37",
        border: "1px solid #D0D5DD", borderRadius: 10, padding: 18,
        boxShadow: "0 12px 32px rgba(16, 24, 40, 0.18)", fontSize: 14, lineHeight: 1.5,
      }}
    >
      {/* R-230: below 980px the banner spans the screen with a 12px gutter (375px phones). */}
      <style jsx>{`
        .consent-banner { left: 22px; bottom: 22px; max-width: 400px; }
        @media (max-width: 979px) {
          .consent-banner { left: 12px; right: 12px; bottom: 12px; max-width: none; max-height: calc(100vh - 24px); overflow-y: auto; }
        }
      `}</style>
      <p id="consent-title" style={{ margin: "0 0 8px", paddingRight: 28, fontWeight: 700, fontSize: 15, color: "#111827" }}>
        Cookies on this site
      </p>
      <div id="consent-body">
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
        {reopened && choice && (
          <p style={{ margin: "0 0 12px", fontWeight: 600 }} aria-live="polite">Your current choice: {LABEL[choice]}</p>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button ref={firstBtn} type="button" className="consent-btn" style={BTN} onClick={() => choose("all")}>Accept all</button>
        <button type="button" className="consent-btn" style={BTN} onClick={() => choose("essential")}>Only necessary</button>
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
