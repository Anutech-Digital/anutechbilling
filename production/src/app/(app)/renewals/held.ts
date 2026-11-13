/**
 * R-2761 — the Renewals row's "Renewal held" flag (lib/renewals/stage.ts renewalHeldReason) from the OPEN
 * 'held' rows of subscription_renewal_moves (R-2749 / R-2761: a renewal part's payment was undone but the
 * database kept renewal_date). Pure — tested in held-r2761.test.ts; read in held-data.ts.
 */
import type { RenewalHeld } from "@/lib/renewals/stage";

export interface HeldMoveRow {
  id: number;
  subscription_id: string;
  from_date: string;
  to_date: string;
  hold_kind: string | null;
}

const KINDS = new Set(["not_active", "quote_linked", "seat_cut"]);

/** Newest open hold per subscription (the database keeps one open; newest wins if ever two). */
export function openHoldsBySubscription(rows: readonly HeldMoveRow[]): Map<string, RenewalHeld> {
  const best = new Map<string, HeldMoveRow>();
  for (const r of rows) {
    const cur = best.get(r.subscription_id);
    if (!cur || r.id > cur.id) best.set(r.subscription_id, r);
  }
  const out = new Map<string, RenewalHeld>();
  for (const [sid, r] of best) {
    out.set(sid, {
      kind: r.hold_kind && KINDS.has(r.hold_kind) ? (r.hold_kind as RenewalHeld["kind"]) : null,
      from: r.from_date.slice(0, 10),
      to: r.to_date.slice(0, 10),
    });
  }
  return out;
}
