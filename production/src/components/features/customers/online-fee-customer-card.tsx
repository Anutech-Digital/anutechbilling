/**
 * R-2416 — customer page "Online fee": Default (the company setting) / We absorb for this customer
 * (+ reason). Owner, manager or accountant changes it — the database refuses anyone else
 * (online_fee_exception_guard). A bill's own waiver still wins over this. Before the migration
 * the column is absent and the card renders nothing.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ONLINE_FEE_REASON_MIN, useCustomerOnlineFee, useOnlineFeeSettings, useSaveCustomerOnlineFee } from "@/lib/queries/online-fee";

type Mode = "default" | "absorb";

export function OnlineFeeCustomerCard({ customerId, canEdit }: { customerId: string; canEdit: boolean }) {
  const { data } = useCustomerOnlineFee(customerId);
  const { data: company } = useOnlineFeeSettings();
  const save = useSaveCustomerOnlineFee(customerId);
  const [mode, setMode] = React.useState<Mode>("default");
  const [reason, setReason] = React.useState("");

  React.useEffect(() => {
    if (!data) return;
    setMode(data.override === "absorb" ? "absorb" : "default");
    setReason(data.reason ?? "");
  }, [data]);

  if (!data?.ready) return null;
  const savedMode: Mode = data.override === "absorb" ? "absorb" : "default";
  const dirty = mode !== savedMode || (mode === "absorb" && reason.trim() !== (data.reason ?? ""));
  const reasonOk = mode === "default" || reason.trim().length >= ONLINE_FEE_REASON_MIN;
  const companyText = company?.settings.bearer === "business" ? "we pay (company setting)" : "customer pays (company setting)";
  const id = `online-fee-${customerId}`;

  return (
    <Card title="Online fee" sub={savedMode === "absorb" ? "We absorb for this customer" : `Default · ${companyText}`}>
      <div className="space-y-3 text-sm">
        <div role="group" aria-label="Who pays the online fee for this customer" className="flex flex-wrap gap-1.5">
          {(["default", "absorb"] as const).map((m) => {
            const on = mode === m;
            return (
              <button
                key={m}
                type="button"
                aria-pressed={on}
                disabled={!canEdit || save.isPending}
                onClick={() => setMode(m)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-1 disabled:opacity-60 disabled:cursor-not-allowed ${
                  on ? "bg-amber text-white border-amber" : "bg-paper border-hairline text-ink-2 hover:border-hairline-strong"
                }`}
              >
                {m === "default" ? "Default" : "We absorb for this customer"}
              </button>
            );
          })}
        </div>
        {mode === "absorb" && (
          <div>
            <label htmlFor={`${id}-reason`} className="mb-1 block text-xs font-medium text-ink-3">Reason</label>
            <Input id={`${id}-reason`} value={reason} maxLength={200} placeholder="e.g. Key account, agreed in contract"
              disabled={!canEdit || save.isPending} onChange={(e) => setReason(e.target.value)} aria-invalid={!reasonOk} />
            {!reasonOk && <p className="mt-1 text-xs text-rose">Write why we absorb the fee ({ONLINE_FEE_REASON_MIN}+ letters).</p>}
          </div>
        )}
        <p className="text-xs text-ink-3">
          Razorpay&apos;s fee on online payments. A quote or invoice can still waive it for one bill.
          {!canEdit && " Only an owner, manager or accountant can change this."}
        </p>
        {canEdit && dirty && (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setMode(savedMode); setReason(data.reason ?? ""); }}>Discard</Button>
            <Button size="sm" variant="primary" disabled={!reasonOk} loading={save.isPending}
              onClick={() => save.mutate({ override: mode === "absorb" ? "absorb" : null, reason: mode === "absorb" ? reason.trim() : null })}>
              Save
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
