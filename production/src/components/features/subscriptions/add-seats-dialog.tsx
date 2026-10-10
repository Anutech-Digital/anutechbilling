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
import { addSeatsErrorMessage, type AddSeatsOk } from "./add-seats-error";
import { seatChargeWindow } from "@/lib/subscriptions/seat-charge-window";
import { seatIncreaseCharge } from "@/lib/subscriptions/seat-increase-charge";
import { istToday } from "@/lib/dates/ist";
import { seatEffectiveBounds, checkSeatEffectiveDate } from "@/lib/subscriptions/seat-effective-date";

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
  /* R-800: the date the seats were actually provisioned. Default today; may be backdated to
     the start of the current term, never in the future (lib/subscriptions/seat-effective-date). */
  const today = istToday();
  const [effectiveDate, setEffectiveDate] = React.useState(today);
  /* Re-seed when the dialog is REOPENED for a different subscription. Without this the
     box keeps whatever was typed the last time it was open, which on a prefilled dialog
     means the second customer silently inherits the first one's gap. */
  React.useEffect(() => {
    if (open) {
      setSeatsStr(String(initialSeats ?? 1));
      setEffectiveDate(istToday());
    }
  }, [open, initialSeats, sub.id]);
  const [submitting, setSubmitting] = React.useState(false);
  /* R-450: a failed add used to show only a toast, easy to miss behind the open dialog
     ("nothing happens"). The reason now also stays in the dialog, next to the button,
     until the operator changes something or tries again. */
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  React.useEffect(() => { setSubmitError(null); }, [open, sub.id, seatsStr, effectiveDate]);

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
  React.useEffect(() => { keyRef.current = null; }, [open, sub.id, additionalSeats, effectiveDate]);

  /* Pro-rata preview — the server is the source of truth, and this now uses its rules:
     R-527 seatChargeWindow (a split-billed subscription is charged to the end of the CURRENT
     instalment, not to renewal) and seatIncreaseCharge() (days over the real term,
     integer paise). It was days-to-renewal ÷ 365 here, so a quarterly sub showed the year. */
  const renewal = sub.renewal_date ? new Date(sub.renewal_date) : null;
  const bounds = seatEffectiveBounds(sub, today);
  const effCheck = checkSeatEffectiveDate(effectiveDate, sub, today);
  const effectiveError = effCheck.ok ? null : effCheck.message;
  const chargeFrom = effCheck.ok ? effCheck.date : today;
  const window = seatChargeWindow(sub, today, chargeFrom);
  const daysRemaining = window ? Math.max(0, window.remainingDays) : 0;
  const termDaysForPreview = window?.termDays ?? 365;
  const factor = termDaysForPreview > 0 ? daysRemaining / termDaysForPreview : 0;

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
  /* R-803: the server's own calculation (addSeats calls seatIncreaseCharge too), so these
     lines equal the quote it creates. Adding the separately rounded subtotal and GST here
     showed ₹1,007 for a ₹1,006 quote (₹852.95 + ₹153.53 = ₹1,006.48). */
  const charge           = seatIncreaseCharge({
    currentSeats: sub.seats, currentMrr: sub.mrr, additionalSeats,
    remainingDays: daysRemaining, termDays: termDaysForPreview, taxRatePct,
  });
  const annualPerSeat    = charge.annualPerSeat;
  const subtotal         = charge.subtotal;
  const gstAmt           = charge.tax;
  const totalIncl        = charge.total;
  const proRataPerSeat   = charge.perSeat;
  const newSeats         = sub.seats + additionalSeats;
  const newMrr           = charge.newMrr;

  /* Term has ended = TODAY is past renewal; a backdated date does not reopen it. */
  const isTermEnded = (seatChargeWindow(sub, today)?.remainingDays ?? 0) <= 0;

  const onSubmit = async () => {
    if (additionalSeats < 1) {
      toast.error("Add at least 1 seat.", { description: "Enter how many seats to add to this subscription." });
      return;
    }
    if (effectiveError) {
      setSubmitError(effectiveError);
      return;
    }
    if (!keyRef.current) keyRef.current = newIdempotencyKey();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res  = await fetch(`/api/subscriptions/${sub.id}/add-seats`, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ additional_seats: additionalSeats, idempotency_key: keyRef.current, effective_date: chargeFrom }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = addSeatsErrorMessage(res.status, json);
        setSubmitError(msg);
        toast.error(msg, { description: "No seats were added and no quote was made." });
        return;
      }
      const ok = json as AddSeatsOk;
      toast.success(
        /* A replay says so. Claiming "+N seats added" a second time would tell the
           operator two expansions happened when one did — the exact confusion the key
           exists to prevent, moved from the database into their head. */
        ok.replayed
          ? `Already added · Quote ${ok.quoteId} (${rupee(ok.amount)}) — opening it now`
          : `+${additionalSeats} seats added · Quote ${ok.quoteId} (${rupee(ok.amount)})${
              ok.poId ? ` · PO ${ok.poId} drafted` : ""
            }`,
      );
      onOpenChange(false);
      router.push(`/quotes/${ok.quoteId}`);
    } catch (err) {
      setSubmitError("Seats not added — could not reach the server. Check your connection, then try again.");
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

            {/* R-800: when the seats were provisioned — the charge runs from this date. */}
            <label htmlFor="add-seats-effective-date" className="block text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
              Effective date
            </label>
            <Input
              id="add-seats-effective-date"
              type="date"
              value={effectiveDate}
              min={bounds?.min}
              max={bounds?.max}
              onChange={(e) => setEffectiveDate(e.target.value)}
              aria-invalid={effectiveError ? true : undefined}
              aria-describedby="add-seats-effective-date-help"
              className="font-mono mb-1"
            />
            <p id="add-seats-effective-date-help" className={effectiveError ? "text-2xs text-rose mb-4" : "text-2xs text-ink-3 mb-4"}>
              {effectiveError ?? `Date the seats were added. Today or earlier, not before ${bounds ? formatDate(bounds.min) : "the term start"}.`}
            </p>

            {/* Pro-rata math */}
            <div className="bg-paper-2 rounded-md p-3 mb-4 text-sm">
              <div className="flex justify-between mb-1">
                <span className="text-ink-3">Effective date</span>
                <span className="tabular-nums text-ink-2">{formatDate(chargeFrom)}{chargeFrom < today ? " (backdated)" : ""}</span>
              </div>
              <div className="flex justify-between mb-1">
                <span className="text-ink-3">Annual rate per seat</span>
                <span className="tabular-nums text-ink-2">{rupee(annualPerSeat)}</span>
              </div>
              <div className="flex justify-between mb-1">
                <span className="text-ink-3">{window?.instalmentPeriod ? `Days charged in this instalment (to ${formatDate(window.chargeTo)})` : "Days charged (to renewal)"}</span>
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
              {" "}<Badge size="sm" kind="muted">{daysRemaining} days</Badge> from {formatDate(chargeFrom)}
              {window?.instalmentPeriod ? " of this instalment — the later instalments include the new seats." : "."}
            </p>
          </>
        )}

        {submitError && (
          <p role="alert" className="mt-3 rounded-md border border-rose/40 bg-rose/5 px-3 py-2 text-xs text-rose">
            {submitError}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          {!isTermEnded && (
            <Button variant="primary" icon="plus" onClick={onSubmit} disabled={submitting || additionalSeats < 1 || !!effectiveError}>
              {submitting ? "Adding…" : `Add ${additionalSeats} seat${additionalSeats === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
