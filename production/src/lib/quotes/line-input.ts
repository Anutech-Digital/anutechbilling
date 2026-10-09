/**
 * R-449 (4)(5) — what a typed Qty or Rate on a quote line means.
 *
 * Abhishek's audit (8 Oct 2026): Qty "0" left the box empty while the line still charged one
 * seat (₹3,240), and Rate "−100" became "0100" / ₹100 — the minus was dropped without a word.
 * Both were silent rewrites of what the rep typed. Now a bad value is kept on screen with a
 * plain message, the line keeps its last good number, and the quote cannot be saved until the
 * box is fixed.
 */

/** Upper bounds that catch a slipped key (an extra zero or two), not a price rule. */
export const MAX_LINE_QTY = 100_000;
export const MAX_LINE_RATE = 10_000_000;

export type LineInputResult =
  | { ok: true; value: number }
  | { ok: false; problem: string };

/** Qty: a whole number from 1 to MAX_LINE_QTY. */
export function parseLineQty(raw: string): LineInputResult {
  const t = raw.trim();
  if (t === "") return { ok: false, problem: "Enter a quantity of 1 or more." };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, problem: "Quantity must be a number." };
  if (n < 1) return { ok: false, problem: "Quantity must be 1 or more." };
  if (!Number.isInteger(n)) return { ok: false, problem: "Quantity must be a whole number." };
  if (n > MAX_LINE_QTY) return { ok: false, problem: `Quantity looks too high — the most is ${MAX_LINE_QTY.toLocaleString("en-IN")}.` };
  return { ok: true, value: n };
}

/**
 * Rate, as typed in the box's own unit (₹ or $ per seat per period). 0 is allowed — a free
 * line is a real thing (our own support plan at ₹0). Negative is not: a reduction is a
 * discount, not a negative price.
 */
export function parseLineRate(raw: string): LineInputResult {
  const t = raw.trim();
  if (t === "") return { ok: false, problem: "Enter a rate (0 or more)." };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, problem: "Rate must be a number." };
  if (n < 0) return { ok: false, problem: "Rate can't be negative. Use the quote discount instead." };
  if (n > MAX_LINE_RATE) return { ok: false, problem: "Rate looks too high — check for an extra zero." };
  return { ok: true, value: n };
}

/** The first problem among the lines' boxes, for the save refusal. Null = all good. */
export function firstLineInputProblem(problems: Record<string, string | undefined>): string | null {
  for (const p of Object.values(problems)) if (p) return p;
  return null;
}

/**
 * R-472 — is the builder holding work the user did? Opened from a lead, the builder fills a
 * line and the prospect name by itself, and the old rule ("any line or any name") called
 * that unsaved work — "Leave site?" with nothing changed. `baseline` is the screen as it
 * stood at the user's first click or key press (null until then); dirty means changed since.
 */
export function builderIsDirty(baseline: string | null, current: string): boolean {
  return baseline !== null && baseline !== current;
}
