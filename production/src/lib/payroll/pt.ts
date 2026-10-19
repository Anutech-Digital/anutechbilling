/**
 * Professional Tax (PT) — state tax deducted from salary.
 *
 * SINGLE SOURCE OF TRUTH for the PT slab the app suggests. Mirrors esi.ts / pf.ts: the CTC
 * calculator, the CTC register and the employee drawer all read from here (R-1585 — the
 * slab used to be hard-coded inside ctc.ts).
 *
 * PT is a STATE tax and every state has its own slab (some have none). The app has no
 * state-wise slab table yet, so this module keeps the ONE slab the app has always used
 * (> ₹15,000 → ₹200, > ₹10,000 → ₹150, else ₹0) as the default, unchanged. State-wise
 * slabs need the CA (Hitesh) to confirm them before they are added here as rows in
 * PT_STATE_SLABS — never typed into a screen. Until then a state with no row falls back to
 * the default and `slabSource` says so, and a PT typed for the employee always wins.
 */

export interface PtSlab { above: number; monthly: number } // PT `monthly` when gross > `above`

/** Default slab (the app's existing rule), highest first. */
export const PT_DEFAULT_SLABS: readonly PtSlab[] = [
  { above: 15_000, monthly: 200 },
  { above: 10_000, monthly: 150 },
];

/** State-wise slabs, keyed by state name in lower case. Empty until the CA confirms them. */
export const PT_STATE_SLABS: Readonly<Record<string, readonly PtSlab[]>> = {};

export interface PtResult {
  monthly: number;
  annual: number;
  slabSource: "custom" | "state" | "default";
}

/**
 * PT for a month's gross.
 * @param opts.custom PT typed for this employee (₹/month) — wins over any slab.
 * @param opts.state  the employee's state — uses its slab when PT_STATE_SLABS has one.
 */
export function computePt(monthlyGross: number, opts?: { custom?: number | null; state?: string | null }): PtResult {
  if (opts?.custom !== undefined && opts.custom !== null && Number.isFinite(opts.custom)) {
    const monthly = Math.max(0, Math.round(opts.custom));
    return { monthly, annual: monthly * 12, slabSource: "custom" };
  }
  const stateSlabs = opts?.state ? PT_STATE_SLABS[opts.state.trim().toLowerCase()] : undefined;
  const slabs = stateSlabs ?? PT_DEFAULT_SLABS;
  const g = Math.max(0, Math.round(monthlyGross || 0));
  const monthly = slabs.find((s) => g > s.above)?.monthly ?? 0;
  return { monthly, annual: monthly * 12, slabSource: stateSlabs ? "state" : "default" };
}
