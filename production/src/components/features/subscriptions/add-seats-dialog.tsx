/**
 * AddSeatsDialog — mid-term seat expansion with pro-rata billing.
 *
 * Customer wants +N seats. Current sub still has X days left. We charge
 * only the proportional amount for those remaining days (not full annual
 * rate). Both renewal_date and term stay UNCHANGED — only seats grow.
 *
 * Live preview shows:
 *   - Days remaining in term
 *   - Per-seat pro-rata rate
 *   - Total pro-rata amount (incl GST)
 *   - New seat count after the change
 *
 * Workflow:
 *   - User picks +N seats
 *   - Click "Add seats + create quote" → API call
 *     1. subscription.seats updated immediately (Pardeep provisions on vendor)
 *     2. Quote created for the pro-rata billing
 *   - Redirect to the new quote so operator can send it to customer
 */

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { rupee, formatDate } from "@/lib/utils";
import { newIdempotencyKey } from "@/lib/ops/idempotency-key";
import type { Subscription } from "@/lib/supabase/database.types";
import { useCustomer } from "@/lib/queries/customers";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { quotePlaceOfSupply, gstHeadLabel } from "@/lib/quotes/quote-place-of-supply";

interface Props {
  sub:          Subscription;
  open:         boolean;
  onOpenChange: (v: boolean) => void;
  /**
   * How many seats to start the box at. Defaults to 1.
   *
   * Set by the "Bill the N extra seats" button on a LEAKING subscription, where the
   * number is not a guess — it is exactly the gap between what the vendor charges and
   * what the customer is billed. Typing it again by hand is a chance to get it wrong on
   * the one screen where the right answer is already known.
   */
  initialSeats?: number;
}

export default function AddSeatsDialog({ sub, open, onOpenChange, initialSeats }: Props) {
  const router = useRouter();
  const [seatsStr,   setSeatsStr]   = React.useState(String(initialSeats ?? 1));
  /* Re-seed when the dialog is REOPENED for a different subscription. Without this the
     box keeps whatever was typed the last time it was open, which on a prefilled dialog
     means the second customer silently inherits the first one's gap. */
  React.useEffect(() => {
    if (open) setSeatsStr(String(initialSeats ?? 1));
  }, [open, initialSeats, sub.id]);
  const [submitting, setSubmitting] = React.useState(false);

  const additionalSeats = Math.max(0, Math.min(5000, Math.round(Number(seatsStr) || 0)));

  /* ── R-060: one key per submit INTENT ──────────────────────────────────────
     `disabled={submitting}` below is still there and still useful, but it is a UI
     convenience — it loses a double-click that beats React's state update, and it means
     nothing to a second tab or a retried request. The server now refuses a repeat of the
     same key; this is where the key comes from.

     Cleared when the dialog opens, when it is reopened for a different subscription, and
     when the seat count changes — each of those is a genuinely different intent that
     deserves its own add. NOT cleared on an error: the server releases the key when the
     attempt wrote nothing, so pressing the button again after fixing the cause is a
     retry of the same intent, not a new one. */
  const keyRef = React.useRef<string | null>(null);
  React.useEffect(() => { keyRef.current = null; }, [open, sub.id, additionalSeats]);

  // Pro-rata math (client-side preview — server is source of truth)
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const renewal = sub.renewal_date ? new Date(sub.renewal_date) : null;
  if (renewal) renewal.setHours(0, 0, 0, 0);
  const daysRemaining = renewal
    ? Math.max(0, Math.min(365, Math.round((renewal.getTime() - today.getTime()) / 86400000)))
    : 0;
  const factor = daysRemaining / 365;

  const annualPerSeat = sub.seats > 0
    ? Math.round((sub.mrr * 12) / sub.seats)
    : 0;
  const proRataPerSeat   = Math.round(annualPerSeat * factor);
  const subtotal         = proRataPerSeat * additionalSeats;
  /* R-389 (F9): name the head the invoice will use — "IGST 18%" for an inter-state customer,
     "CGST 9% + SGST 9%" within the state — and zero-rate an export, the same rule the server
     applies (lib/subscriptions/apply-seat-increase.ts resolveSeatTax). */
  const { data: customer } = useCustomer(sub.customer_id ?? undefined);
  const { data: me } = useCurrentUser();
  const pos = quotePlaceOfSupply({
    customer: customer ?? null,
    seller: { state_code: me?.tenantStateCode, gstin: me?.tenantGstin },
  });
  const taxRatePct       = pos.isExport ? 0 : 18;
  const taxLabel         = gstHeadLabel({ ratePct: taxRatePct, interState: pos.interState, isExport: pos.isExport });
  const gstAmt           = Math.round((subtotal * taxRatePct) / 100);
  const totalIncl        = subtotal + gstAmt;
  const newSeats         = sub.seats + additionalSeats;
  const newMrr           = Math.round((annualPerSeat * newSeats) / 12);

  const isTermEnded = daysRemaining <= 0;

  const onSubmit = async () => {
    if (additionalSeats < 1) {
      toast.error("Add at least 1 seat.", { description: "Enter how many seats to add to this subscription." });
      return;
    }
    if (!keyRef.current) keyRef.current = newIdempotencyKey();
    setSubmitting(true);
    try {
      const res  = await fetch(`/api/subscriptions/${sub.id}/add-seats`, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ additional_seats: additionalSeats, idempotency_key: keyRef.current }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "Could not add seats.", { description: "No seats were added and no quote was made. Try again." });
        return;
      }
      toast.success(
        /* A replay says so. Claiming "+N seats added" a second time would tell the
           operator two expansions happened when one did — the exact confusion the key
           exists to prevent, moved from the database into their head. */
        json.replayed
          ? `Already added · Quote ${json.quoteId} (${rupee(json.amount)}) — opening it now`
          : `+${additionalSeats} seats added · Quote ${json.quoteId} (${rupee(json.amount)})${
              json.poId ? ` · PO ${json.poId} drafted` : ""
            }`,
      );
      onOpenChange(false);
      router.push(`/quotes/${json.quoteId}`);
    } catch (err) {
      toastError(err, { fallback: "Could not add seats.", description: "Check your connection, then try again — pressing again will not add the seats twice." });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <header className="border-b border-hairline pb-3 mb-4">
          <p className="text-3xs uppercase tracking-wider font-semibold text-amber-ink mb-1">
            Subscription · Add seats
          </p>
          <h2 className="font-serif text-2xl text-ink">{sub.customer_name}</h2>
          {sub.domain && (
            <p className="text-xs font-mono text-ink-3 mt-0.5">{sub.domain}</p>
          )}
          <p className="text-xs text-ink-2 mt-1">
            {sub.plan} · {sub.seats} seats · renews {renewal ? formatDate(renewal.toISOString()) : "—"}
          </p>
        </header>

        {isTermEnded ? (
          <div className="bg-rose/10 border border-rose/30 rounded-md p-3 text-sm text-rose mb-4">
            ⚠️ This subscription's term has ended. Add-seats can't pro-rate.
            Issue a <b>Renewal</b> or <b>Extension</b> quote first to reset the term.
          </div>
        ) : (
          <>
            <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
              How many additional seats?
            </p>
            <div className="flex items-center gap-2 mb-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSeatsStr(String(Math.max(1, additionalSeats - 1)))}
                disabled={additionalSeats <= 1}
              >
                −
              </Button>
              <Input
                type="number"
                min={1}
                max={5000}
                aria-label="Additional seats"
                value={seatsStr}
                onChange={(e) => setSeatsStr(e.target.value)}
                className="font-mono text-center"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSeatsStr(String(additionalSeats + 1))}
              >
                +
              </Button>
            </div>

            {/* Pro-rata math */}
            <div className="bg-paper-2 rounded-md p-3 mb-4 text-sm">
              <div className="flex justify-between mb-1">
                <span className="text-ink-3">Annual rate per seat</span>
                <span className="tabular-nums text-ink-2">{rupee(annualPerSeat)}</span>
              </div>
              <div className="flex justify-between mb-1">
                <span className="text-ink-3">Days remaining in term</span>
                <span className="tabular-nums text-ink-2">{daysRemaining} days</span>
              </div>
              <div className="flex justify-between mb-1">
                <span className="text-ink-3">Pro-rata factor</span>
                <span className="tabular-nums text-ink-2">{factor.toFixed(3)} ({Math.round(factor * 100)}%)</span>
              </div>
              <div className="flex justify-between mb-1">
                <span className="text-ink-3">Pro-rata per seat</span>
                <span className="tabular-nums text-ink-2">{rupee(proRataPerSeat)}</span>
              </div>
              <div className="flex justify-between mb-1 pt-2 border-t border-hairline">
                <span className="text-ink-3">Subtotal ({additionalSeats} × {rupee(proRataPerSeat)})</span>
                <span className="tabular-nums text-ink-2">{rupee(subtotal)}</span>
              </div>
              <div className="flex justify-between mb-1">
                <span className="text-ink-3">{taxLabel}</span>
                <span className="tabular-nums text-ink-2">{rupee(gstAmt)}</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-hairline">
                <span className="font-medium text-ink">Total (incl GST)</span>
                <span className="font-serif text-lg tabular-nums text-ink">{rupee(totalIncl)}</span>
              </div>
            </div>

            {/* Seat preview */}
            <div className="bg-emerald/5 border border-emerald/20 rounded-md p-3 mb-4 text-sm flex justify-between items-center">
              <div>
                <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">After adding</p>
                <p className="font-medium text-ink tabular-nums">{newSeats} seats</p>
              </div>
              <div className="text-right">
                <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">New MRR</p>
                <p className="font-medium text-ink tabular-nums">{rupee(newMrr)}/mo</p>
              </div>
            </div>

            <p className="text-2xs text-ink-3 leading-relaxed mb-1">
              Seats are added <b className="text-ink-2">immediately</b> — provision them with the
              vendor (Google CSP / Microsoft / Zoho). A pro-rata quote will be sent to the customer for
              the remaining <Badge size="sm" kind="muted">{daysRemaining} days</Badge>.
            </p>
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          {!isTermEnded && (
            <Button variant="primary" icon="plus" onClick={onSubmit} disabled={submitting || additionalSeats < 1}>
              {submitting ? "Adding…" : `Add ${additionalSeats} seat${additionalSeats === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
