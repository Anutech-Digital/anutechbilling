/**
 * R-097 — the checkout's boxes and the terms checkbox, each with a name a screen reader says.
 *
 * Every box gets an explicit label↔input pair (htmlFor + id; a stable useId when the page
 * does not need a fixed id to scroll to), plus the browser's autocomplete token so phones
 * and password managers fill name / email / mobile / address in one tap (WCAG 1.3.5).
 * The terms checkbox is named by its own sentence, and when Pay is pressed before it is
 * ticked it is marked invalid and pointed at the nudge that says why.
 */
"use client";

import { useId, type ReactNode } from "react";

export function Field({ id, label, value, onChange, type = "text", mono, autoComplete, inputMode, maxLength, autoCapitalize, invalid, describedBy }: {
  id?: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  mono?: boolean;
  autoComplete?: string;
  inputMode?: "text" | "email" | "tel" | "numeric";
  maxLength?: number;
  autoCapitalize?: "characters" | "words" | "off";
  /** The value is wrong and the message with id `describedBy` says why (R-227). */
  invalid?: boolean;
  describedBy?: string;
}) {
  const autoId = useId();
  const inputId = id ?? `checkout-field-${autoId}`;
  return (
    <div style={{ marginBottom: 14 }}>
      <label htmlFor={inputId} className="mono-label" style={{ color: "var(--text-muted)", display: "block", marginBottom: 6 }}>{label}</label>
      <input
        id={inputId}
        type={type}
        value={value}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        autoCapitalize={autoCapitalize}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", border: `1px solid ${invalid ? "#DC2626" : "var(--border-strong)"}`, borderRadius: 6, padding: "11px 12px", fontSize: 15, fontFamily: mono ? "var(--font-mono)" : "inherit" }}
      />
    </div>
  );
}

export const TERMS_NUDGE_ID = "checkout-terms-nudge";

export function TermsCheckbox({ checked, onChange, invalid, children }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Pay was pressed before the box was ticked — the nudge with TERMS_NUDGE_ID is on screen. */
  invalid: boolean;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "16px 0" }}>
      <input
        id="checkout-terms"
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? TERMS_NUDGE_ID : undefined}
        style={{ marginTop: 3, accentColor: "var(--primary)", cursor: "pointer" }}
      />
      <label htmlFor="checkout-terms" style={{ fontSize: 14, color: "var(--text-secondary)", cursor: "pointer" }}>
        {children}
      </label>
    </div>
  );
}
