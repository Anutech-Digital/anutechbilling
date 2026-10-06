"use client";

/**
 * "We're working on it" — shown while a customer waits on the server.
 *
 * Owner, 30 Sep 2026: "tell users that they are sending email or processing things while
 * background work happens, so that user knows things are happening, not just stuck at a
 * page". Starting a trial took up to 30 s behind a button that only said "Starting your
 * trial…", and it read as a frozen page.
 *
 * What it shows, and why it is honest:
 *   - a title naming the action ("Starting your free trial");
 *   - WHAT the server is doing, as a plain list — not ticked off one by one, because the
 *     server does them in one request and the page cannot know which is finished;
 *   - how long it has been, counting up, so a wait is visibly a wait and not a hang;
 *   - after `slowAfterSec`, a line saying it is slower than usual and to keep the page open.
 * It announces itself to screen readers (role="status", aria-live="polite") and respects
 * prefers-reduced-motion.
 *
 * Plain inline styles with CSS-variable fallbacks, so it looks right on the public site
 * (site.css) and on the Tailwind pages (quote accept) alike.
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { lockPageScroll } from "@/lib/ui/scroll-lock";

export interface BusyPanelProps {
  /** Show it. When this goes false the panel disappears and the clock resets. */
  active: boolean;
  /** The action, as the customer would say it: "Starting your free trial". */
  title: string;
  /** What is happening, in order: "Checking you haven't had a trial before", … */
  steps: string[];
  /** Seconds before the "taking longer than usual" line appears. */
  slowAfterSec?: number;
  /**
   * "inline" (default): a box in the page flow. "modal" (checkout, 1 Oct 2026 — Pawan: the
   * inline box pushed the form down mid-wait): a centred card over a dimmed page, so the
   * layout under it does not move. It has no close button — the work is still running.
   */
  variant?: "inline" | "modal";
}

export function BusyPanel({ active, title, steps, slowAfterSec = 8, variant = "inline" }: BusyPanelProps) {
  const [secs, setSecs] = React.useState(0);

  React.useEffect(() => {
    if (!active) { setSecs(0); return; }
    const t0 = Date.now();
    setSecs(0);
    const id = window.setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [active]);

  if (!active) return null;
  if (variant === "modal") return <BusyModal title={title} steps={steps} secs={secs} slow={secs >= slowAfterSec} />;

  return (
    <div
      role="status"
      aria-live="polite"
      data-busy-panel
      style={{
        border: "1px solid var(--border-hairline, #E3E8EF)",
        background: "var(--surface-muted, #F6F8FB)",
        borderRadius: 10,
        padding: "14px 16px",
        margin: "12px 0",
        fontSize: 14,
        color: "var(--text-secondary, #475467)",
      }}
    >
      <style>{`
        @keyframes busy-panel-spin { to { transform: rotate(360deg); } }
        [data-busy-panel] .busy-panel-spinner { animation: busy-panel-spin 0.9s linear infinite; }
        @media (prefers-reduced-motion: reduce) { [data-busy-panel] .busy-panel-spinner { animation: none; } }
      `}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          className="busy-panel-spinner"
          aria-hidden
          style={{
            width: 16, height: 16, flexShrink: 0, borderRadius: "50%",
            border: "2px solid var(--border-strong, #C8D0DA)",
            borderTopColor: "var(--primary, #1A6BE0)",
          }}
        />
        <strong style={{ color: "var(--text-primary, #101828)" }}>{title}…</strong>
        <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums", color: "var(--text-muted, #667085)" }}>
          {secs}s
        </span>
      </div>
      {steps.length > 0 && (
        <ul style={{ margin: "10px 0 0 26px", padding: 0, listStyle: "disc", lineHeight: 1.6 }}>
          {steps.map((s) => <li key={s}>{s}</li>)}
        </ul>
      )}
      {secs >= slowAfterSec && (
        <p style={{ margin: "10px 0 0", color: "var(--text-primary, #101828)" }}>
          This is taking a little longer than usual. Please keep this page open — there is no need
          to press the button again.
        </p>
      )}
    </div>
  );
}

const SPIN_CSS = `
  @keyframes busy-panel-spin { to { transform: rotate(360deg); } }
  [data-busy-panel] .busy-panel-spinner { animation: busy-panel-spin 0.9s linear infinite; }
  @media (prefers-reduced-motion: reduce) { [data-busy-panel] .busy-panel-spinner { animation: none; } }
`;

/** The same content as a centred card over a dimmed page. */
function BusyModal({ title, steps, secs, slow }: { title: string; steps: string[]; secs: number; slow: boolean }) {
  // Counted lock (lib/ui/scroll-lock): a save-and-restore here once left /done unscrollable.
  React.useEffect(() => lockPageScroll(), []);
  if (typeof document === "undefined") return null;
  /* Into the public site's wrapper when there is one (it carries the colours), else <body>;
     never inside the page section, whose transform would trap the overlay's z-index. */
  const host = document.querySelector(".anutech-site") ?? document.body;
  return createPortal(
    <div
      data-busy-panel
      style={{
        position: "fixed", inset: 0, zIndex: 120, background: "rgba(12,17,22,.45)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <style>{SPIN_CSS}</style>
      <div
        role="status"
        aria-live="polite"
        style={{
          width: "100%", maxWidth: 400, background: "#fff", borderRadius: 14,
          boxShadow: "0 30px 70px -30px rgba(12,17,22,.55)", padding: "30px 28px 24px",
          textAlign: "center", fontSize: 14, color: "var(--text-secondary, #475467)",
        }}
      >
        <span
          className="busy-panel-spinner"
          aria-hidden
          style={{
            display: "block", width: 40, height: 40, margin: "0 auto 18px", borderRadius: "50%",
            border: "3px solid var(--border, #E0E5EC)", borderTopColor: "var(--primary, #1A6BE0)",
          }}
        />
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-0.01em", color: "var(--text, #101828)" }}>
          {title}…
        </h2>
        <p style={{ margin: "6px 0 0", fontVariantNumeric: "tabular-nums", color: "var(--text-muted, #667085)", fontSize: 13 }}>
          {secs}s · please keep this page open
        </p>
        {steps.length > 0 && (
          <ul
            style={{
              margin: "18px 0 0", padding: "14px 16px 14px 34px", textAlign: "left", listStyle: "disc",
              lineHeight: 1.7, background: "var(--tint, #F6F8FB)", borderRadius: 10,
            }}
          >
            {steps.map((s) => <li key={s}>{s}</li>)}
          </ul>
        )}
        {slow && (
          <p style={{ margin: "14px 0 0", color: "var(--text, #101828)" }}>
            This is taking a little longer than usual — there is no need to press the button again.
          </p>
        )}
      </div>
    </div>,
    host,
  );
}
