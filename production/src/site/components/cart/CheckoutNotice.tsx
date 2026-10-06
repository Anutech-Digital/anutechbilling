"use client";

/**
 * The checkout's pop-up for an event that stops the order (1 Oct 2026, Pawan: a red line
 * of text above the button "looks flimsy" for something this significant).
 *
 * A centred dialog, its content centred too (Pawan, 1 Oct 2026): a tone mark, a plain title, what happened, a reassurance line, and
 * the buttons that fix it — the first is the main one. Escape, the ✕ and a click on
 * the backdrop all close it; focus moves to the main button when it opens and back to
 * where it was when it closes, so a keyboard user is never left behind the overlay.
 *
 * Drawn into the site wrapper (`.anutech-site`, which carries the colours and button
 * styles), not inside the checkout section: inside the checkout's animated section (`.rise` keeps a
 * transform) its z-index only counted within that section, and the cookie banner and the
 * chat buttons showed through the backdrop.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { lockPageScroll } from "@/lib/ui/scroll-lock";

export interface NoticeButton {
  label: string;
  onClick: () => void;
}

const TONES = {
  error: { ring: "#FDECEA", mark: "var(--danger)", glyph: "!" },
  warning: { ring: "#FEF5E1", mark: "var(--warning)", glyph: "!" },
  success: { ring: "#E6F4EE", mark: "var(--success)", glyph: "✓" },
} as const;

export function CheckoutNotice({
  tone,
  title,
  body,
  footnote,
  buttons,
  onClose,
}: {
  tone: keyof typeof TONES;
  title: string;
  body: string;
  footnote?: string;
  buttons: NoticeButton[];
  onClose: () => void;
}) {
  const mainRef = useRef<HTMLButtonElement>(null);
  const t = TONES[tone];

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    mainRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const unlock = lockPageScroll();
    return () => {
      document.removeEventListener("keydown", onKey);
      unlock();
      before?.focus?.();
    };
  }, [onClose]);

  const [main, ...rest] = buttons;
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 120, background: "rgba(12,17,22,.45)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
        animation: "wFade .18s ease",
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="checkout-notice-title"
        aria-describedby="checkout-notice-body"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative", width: "100%", maxWidth: 440, background: "#fff",
          borderRadius: 14, boxShadow: "0 30px 70px -30px rgba(12,17,22,.55)",
          padding: "32px 28px 24px", animation: "wRise .22s ease", textAlign: "center",
        }}
      >
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={{
            position: "absolute", top: 12, right: 12, width: 32, height: 32, borderRadius: 8,
            border: "none", background: "transparent", color: "var(--text-muted)", fontSize: 18,
            cursor: "pointer", lineHeight: 1,
          }}
        >
          ✕
        </button>

        <div
          aria-hidden
          style={{
            width: 48, height: 48, borderRadius: "50%", background: t.ring, display: "flex",
            alignItems: "center", justifyContent: "center", margin: "0 auto 16px",
          }}
        >
          <span
            style={{
              width: 28, height: 28, borderRadius: "50%", background: t.mark, color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 16,
            }}
          >
            {t.glyph}
          </span>
        </div>

        <h2 id="checkout-notice-title" style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em", margin: "0 0 8px", color: "var(--text)" }}>
          {title}
        </h2>
        <p id="checkout-notice-body" style={{ fontSize: 15, lineHeight: 1.55, color: "var(--text-secondary)", margin: 0 }}>
          {body}
        </p>
        {footnote && (
          <p className="meta" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-hairline)" }}>
            {footnote}
          </p>
        )}

        {main && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 20 }}>
            <button ref={mainRef} type="button" className="btn btn-primary" style={{ width: "100%" }} onClick={main.onClick}>
              {main.label}
            </button>
            {rest.map((b) => (
              <button key={b.label} type="button" className="btn btn-outline" style={{ width: "100%" }} onClick={b.onClick}>
                {b.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.querySelector(".anutech-site") ?? document.body,
  );
}
