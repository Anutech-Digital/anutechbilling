/**
 * R-609 — "Biometric machine key" row for the attendance settings card (Payroll → Attendance).
 *
 * Why: whoever holds the machine key can post punches for any employee on any date through
 * /api/attendance/punch (no login — it is a machine door). Pardeep has no machine yet, so a
 * left-over key is a door with nothing behind it. This row says whether a key exists and lets
 * the owner turn it off, with an in-page confirm (not window.confirm). Everyone else sees the
 * status only; the key itself never reaches this row.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useIngestKeyStatus, useTurnOffIngestKey } from "@/lib/queries/attendance-biometric";

export function BiometricKeyRow() {
  const isOwner = useCurrentUser().data?.role === "owner";
  const statusQ = useIngestKeyStatus();
  const turnOff = useTurnOffIngestKey();
  const [confirming, setConfirming] = React.useState(false);

  const hasKey = statusQ.data?.hasKey ?? false;

  return (
    <div className="mt-3 border-t border-hairline pt-3" data-testid="biometric-key-row">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-ink flex items-center gap-2">
            <Icon name="lock" size={14} className={hasKey ? "text-amber-ink" : "text-emerald"} />
            Biometric machine key
            {statusQ.isLoading ? " · …" : hasKey ? " · ON" : " · Off — no machine connected"}
          </div>
          <p className="text-xs text-ink-3 mt-0.5 max-w-xl">
            {statusQ.isError
              ? "Could not check the machine key. Refresh the page to try again."
              : hasKey
                ? "A fingerprint machine can send attendance with this key. If you have no machine, turn it off — then nobody can mark attendance through the machine link."
                : "No machine can send attendance. Attendance comes only from the kiosk and My Attendance."}
          </p>
        </div>
        {isOwner && hasKey && !confirming && (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            Turn off
          </Button>
        )}
      </div>

      {isOwner && hasKey && confirming && (
        <div role="alertdialog" aria-labelledby="bio-key-off-title"
          className="mt-3 rounded-lg border border-rose/30 bg-rose/5 p-3">
          <div id="bio-key-off-title" className="text-sm font-medium text-ink">Turn off the machine key?</div>
          <p className="text-xs text-ink-2 mt-0.5 max-w-xl">
            Any machine or bridge using this key stops working at once. When you get a machine, a new key is made
            then — the old one never comes back.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="danger" size="sm" loading={turnOff.isPending}
              onClick={() => turnOff.mutate(undefined, { onSettled: () => setConfirming(false) })}>
              Yes, turn off
            </Button>
            <Button variant="ghost" size="sm" disabled={turnOff.isPending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
