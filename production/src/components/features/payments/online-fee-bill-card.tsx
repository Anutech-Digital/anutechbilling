/**
 * R-2416 — the online fee on one quote / invoice, read-only: "Online fee: customer pays ₹X" or
 * "waived — reason", from the same onlineFeeFor the Razorpay webhook uses on capture. An owner or
 * manager can "Waive online fee for this bill" (+ reason); the database refuses anyone else.
 *
 * A quote and its invoice are one bill: a waiver on either counts for both (the webhook reads it
 * the same way). Nothing is charged yet — R-2417 adds the fee to online payments.
 * Before the migration the columns are absent and the card renders nothing.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { onlineFeeFor, onlineFeeLine } from "@/lib/payments/online-fee";
import { rupee } from "@/lib/utils";
import {
  ONLINE_FEE_REASON_MIN,
  useBillOnlineFee,
  useCustomerOnlineFeeMaybe,
  useOnlineFeeSettings,
  useSaveBillOnlineFee,
  type OnlineFeeBillKind,
} from "@/lib/queries/online-fee";

interface Props {
  kind: OnlineFeeBillKind;
  id: string;
  /** The bill total in rupees, GST included. */
  billTotal: number;
  customerId: string | null | undefined;
  /** The other half of the same bill (the quote's invoice, or the invoice's quote). */
  linked?: { kind: OnlineFeeBillKind; id: string | null | undefined };
  role: string | null | undefined;
}

export function OnlineFeeBillCard({ kind, id, billTotal, customerId, linked, role }: Props) {
  const { data: own } = useBillOnlineFee(kind, id);
  const { data: other } = useBillOnlineFee(linked?.kind ?? kind, linked?.id ?? null);
  const { data: company } = useOnlineFeeSettings();
  const { data: customer } = useCustomerOnlineFeeMaybe(customerId);
  const save = useSaveBillOnlineFee(kind, id);
  const [editing, setEditing] = React.useState(false);
  const [reason, setReason] = React.useState("");

  if (!own?.ready || !company?.ready) return null;
  const canWaive = role === "owner" || role === "manager";
  const otherWaived = !own.waived && other?.waived === true;
  const result = onlineFeeFor(
    {
      billTotal,
      waived: own.waived || otherWaived,
      waiveReason: own.waived ? own.reason : otherWaived ? other?.reason : null,
    },
    customer?.ready ? customer : null,
    company.settings,
  );
  const reasonOk = reason.trim().length >= ONLINE_FEE_REASON_MIN;
  const fieldId = `online-fee-waive-${kind}-${id}`;
  const otherLabel = linked?.kind === "invoice" ? "its invoice" : "its quote";

  return (
    <Card title="Online fee" sub={result.bearer === "customer" ? "Customer pays" : "We absorb"}>
      <div className="space-y-3 text-sm">
        <p className={result.bearer === "customer" ? "text-ink" : "text-ink-2"}>
          {onlineFeeLine(result, company.settings)}
          {otherWaived && <span className="text-ink-3"> (waived on {otherLabel})</span>}
        </p>
        {result.bearer === "business" && result.total > 0 && (
          <p className="text-xs text-ink-3">If paid online, Razorpay&apos;s fee (about {rupee(result.total)}) is on us.</p>
        )}
        <p className="text-xs text-ink-3">Not added to the payment yet — this shows who pays under your rules.</p>

        {canWaive && !editing && !otherWaived && (
          <div className="flex justify-end">
            {own.waived ? (
              <Button size="sm" variant="ghost" loading={save.isPending}
                onClick={() => save.mutate({ waived: false, reason: null })}>
                Remove waiver
              </Button>
            ) : (
              <Button size="sm" variant="default" onClick={() => { setReason(""); setEditing(true); }}>
                Waive online fee
              </Button>
            )}
          </div>
        )}
        {canWaive && editing && (
          <div className="space-y-2">
            <label htmlFor={fieldId} className="block text-xs font-medium text-ink-3">Why waive the fee on this bill?</label>
            <Input id={fieldId} value={reason} maxLength={200} placeholder="e.g. Promised on call" autoFocus
              onChange={(e) => setReason(e.target.value)} aria-invalid={reason.length > 0 && !reasonOk} />
            {reason.length > 0 && !reasonOk && <p className="text-xs text-rose">At least {ONLINE_FEE_REASON_MIN} letters.</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
              <Button size="sm" variant="primary" disabled={!reasonOk} loading={save.isPending}
                onClick={() => save.mutate({ waived: true, reason: reason.trim() }, { onSuccess: () => setEditing(false) })}>
                Waive online fee
              </Button>
            </div>
          </div>
        )}
        {!canWaive && <p className="text-xs text-ink-3">Only an owner or manager can waive the online fee on a bill.</p>}
      </div>
    </Card>
  );
}
