/**
 * SubscriptionsBulkBar — the subscription-specific actions inside the shared floating
 * toolbar.
 *
 * The shell (position, count chip, dividers, Clear, the two-step confirm) is
 * `components/ui/bulk-action-bar.tsx`, the same one Leads, Invoices and Customers use.
 * This file holds only what is about SUBSCRIPTIONS.
 *
 * ─── THE THREE ACTIONS, AND THE ONE THAT IS NOT HERE ────────────────────────
 * Export · Send renewal quotes · Delete. Chosen by Abhishek on 19 Sep 2026 from a list
 * of four; the one he left out was bulk Pause/Resume, which would have mirrored
 * Archive/Reactivate on Customers. Right call — pausing is a bookkeeping status that
 * suspends nothing at the vendor, so a bulk pause would make the app disagree with
 * reality for every row it touched, and the operator would have no way to see it.
 *
 * ─── WHY SEND SITS IN THE MIDDLE, NOT LAST ──────────────────────────────────
 * It is the only action here that leaves the building. An email cannot be recalled, so
 * it gets a confirm of its own rather than firing on one click — the same reasoning that
 * put the confirm on Delete, for a different kind of irreversible.
 *
 * Delete is still last and still rose: the server refuses any subscription that came
 * from a paid quote, so a partial run is normal and expected, and the bar reports what
 * actually happened rather than claiming success.
 */
"use client";

import * as React from "react";
import {
  BulkActionBar,
  BulkBarButton,
  BulkBarConfirmButton,
} from "@/components/ui/bulk-action-bar";

interface SubscriptionsBulkBarProps {
  count: number;
  onExport: () => void;
  /** Creates-or-reuses the renewal quote for each selection and emails it. */
  onSendRenewals: () => void;
  /** Absent = the role may not delete subscriptions (R-718: owner / accountant only). */
  onDelete?: () => void;
  onDeselectAll: () => void;
  busy?: boolean;
}

export function SubscriptionsBulkBar({
  count, onExport, onSendRenewals, onDelete, onDeselectAll, busy,
}: SubscriptionsBulkBarProps) {
  return (
    <BulkActionBar count={count} noun="subscription" onClear={onDeselectAll}>
      {/* Read-only, so it comes first and needs no confirmation. */}
      <BulkBarButton icon="download" label="Export selected to CSV" onClick={onExport} disabled={busy}>
        Export
      </BulkBarButton>

      {/* Confirmed, because it sends real email to real customers. */}
      <BulkBarConfirmButton icon="mail" onConfirm={onSendRenewals}>
        Send renewal quotes
      </BulkBarConfirmButton>

      {onDelete && (
        <BulkBarConfirmButton icon="trash" onConfirm={onDelete}>
          Delete
        </BulkBarConfirmButton>
      )}
    </BulkActionBar>
  );
}
