/**
 * R-441 — one price box in Products → Add item → "Pricing by commitment".
 *
 * ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
 * Every box showed `stored × 12` (yearly) or `stored` (monthly), and the stored value is
 * ₹/seat/month rounded to paise. Typing 3240 in "Annual, yearly bill":
 *   "3"  → stored 0.25 → box shows 3
 *   "32" → stored 2.67 → box shows 32.04   ← the box rewrote what was being typed
 *   then "4" lands after 32.04 …           → ₹32.040, monthly ₹2.67
 * The box being typed in was re-derived from the rounded month on every keystroke.
 *
 * ─── THE FIX ────────────────────────────────────────────────────────────────
 * While a box has focus it shows exactly what was typed (a draft string). The number still
 * goes up on every keystroke so the other boxes and the margin follow along, but the box
 * itself is never rewritten under the cursor. On blur the draft is dropped and the box
 * shows the stored value again, rounded to paise for display.
 */
"use client";

import * as React from "react";
import { Input, type InputProps } from "@/components/ui/input";

export interface TierPriceInputProps extends Omit<InputProps, "value" | "onChange" | "type"> {
  /** The value to show when the box is not being typed in (₹, in this box's unit). */
  value: number;
  /** Called on every keystroke with the typed number (0 when empty / not a number). */
  onValue: (n: number) => void;
}

/** Display a stored price: whole rupees stay whole, paise to 2 places, 0 shows empty. */
export function displayPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return String(Math.round(n * 100) / 100);
}

/** Read a typed price. Empty or junk is 0; negatives are 0 (a price cannot be below zero). */
export function parsePrice(raw: string): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function TierPriceInput({ value, onValue, onFocus, onBlur, ...rest }: TierPriceInputProps) {
  const [draft, setDraft] = React.useState<string | null>(null);
  return (
    <Input
      {...rest}
      type="number"
      inputMode="decimal"
      value={draft ?? displayPrice(value)}
      onFocus={(e) => { setDraft(displayPrice(value)); onFocus?.(e); }}
      onChange={(e) => { setDraft(e.target.value); onValue(parsePrice(e.target.value)); }}
      onBlur={(e) => { setDraft(null); onBlur?.(e); }}
    />
  );
}
