/**
 * The subscription drawer's actions — R-1727 (owner journey audit, 21 Oct 2026).
 *
 * The drawer used to end with an "Actions" block below the billing schedule, the
 * amendment history and the late-fee panel, and the only FILLED button in it was a red
 * "Cancel subscription". The most dangerous act on the page was its brightest, and the
 * everyday job (add or remove seats) was a plain button at the bottom of a long scroll.
 *
 * Now split in two:
 *   · SubDrawerActions — right under the header. "Manage seats" is the primary button
 *     (the usual next step on a live subscription); Extend term, Statement, Open customer
 *     and Correct details are secondary.
 *   · SubDrawerDangerZone — last in the drawer, below a rule. Cancel subscription and
 *     Delete (wrong entry) are red OUTLINE buttons, never a filled primary; both still
 *     confirm in their own dialog.
 *
 * Presentational only: the page owns the state and passes the handlers (each one closes
 * the drawer before opening its dialog — see the note in subscriptions/page.tsx).
 */
"use client";

import { Button } from "@/components/ui/button";

/** Red outline on the shared `default` button — no new variant on the shared primitive. */
const DANGER_OUTLINE = "w-full border-rose/60 text-rose hover:bg-rose-soft/40 hover:text-rose-ink";

export function SubDrawerActions({
  hasCustomer, primary, onManageSeats, onExtend, onOpenCustomer, onStatement, onCorrect, onUpgradePlan, supportPlan = false,
}: {
  /** R-2087: a support plan (item SUP-…) has no seats — "Manage seats" is hidden and
   *  "Upgrade plan" (when offered) is the primary button. */
  supportPlan?: boolean;
  /** Open customer / Statement need a customer record. */
  hasCustomer: boolean;
  /** False when another primary is already on screen (the "Bill the N extra seats" leak
   *  fix) — one primary per screen. */
  primary: boolean;
  onManageSeats: () => void;
  onExtend: () => void;
  onOpenCustomer: () => void;
  onStatement: () => void;
  onCorrect: () => void;
  /** R-2073: set only for an active support plan (SUP-…) with a higher tier, for roles that may
   *  change a subscription's terms — opens the pro-rata upgrade quote dialog. */
  onUpgradePlan?: () => void;
}) {
  return (
    <div className="mb-4 pb-4 border-b border-hairline" data-testid="sub-drawer-actions">
      <div className="grid grid-cols-2 gap-2">
        {supportPlan ? (
          onUpgradePlan && (
            <Button variant={primary ? "primary" : "default"} icon="zap" className="col-span-2" onClick={onUpgradePlan}>
              Upgrade plan
            </Button>
          )
        ) : (
          <>
            <Button
              variant={primary ? "primary" : "default"}
              icon="plus"
              className="col-span-2"
              onClick={onManageSeats}
            >
              Manage seats
            </Button>
            {onUpgradePlan && <Button icon="zap" onClick={onUpgradePlan}>Upgrade plan</Button>}
          </>
        )}
        <Button icon="clock" onClick={onExtend}>Extend term</Button>
        {/* The statement, one click from here — ?customer= seeds the ledger's picker. */}
        {hasCustomer && <Button icon="book" onClick={onStatement}>Statement</Button>}
        {hasCustomer && <Button icon="users" onClick={onOpenCustomer}>Open customer</Button>}
        <Button icon="edit" onClick={onCorrect}>Correct details</Button>
      </div>
    </div>
  );
}

export function SubDrawerDangerZone({ cancelledNote, canDelete, onCancel, onDelete }: {
  /** Set when the subscription is already cancelled — shown instead of the button. */
  cancelledNote: string | null;
  /** R-718: owner / accountant only. */
  canDelete: boolean;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="mt-6 pt-4 border-t border-hairline space-y-2" data-testid="sub-drawer-danger">
      {/* R-455: Cancel = the customer is leaving (keeps the record). Delete = this entry
          should never have existed. Two different things, two buttons. */}
      {cancelledNote != null ? (
        <p className="text-2xs text-ink-3">{cancelledNote}</p>
      ) : (
        <Button icon="x" className={DANGER_OUTLINE} onClick={onCancel}>
          Cancel subscription
        </Button>
      )}
      {canDelete && (
        <Button icon="trash" className={DANGER_OUTLINE} onClick={onDelete}>
          Delete (wrong entry)
        </Button>
      )}
    </div>
  );
}
