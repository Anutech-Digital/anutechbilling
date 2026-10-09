/**
 * R-530 — late payment charges on the invoice page: the switch, what has accrued (late fee +
 * interest), what is already billed, and the owner's two actions — "Bill late charges" (a
 * separate debit note at this invoice's own GST rate; the invoice itself never changes) and
 * "Waive" (with a reason, kept on record).
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { useConfirm, useAskText } from "@/components/providers/confirm-provider";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { toastError } from "@/lib/errors/toast-error";
import { rupee, formatDate } from "@/lib/utils";
import { useLateCharges, useBillLateCharges, useWaiveLateCharges } from "@/lib/late-charges/queries";
import { mayBillLateCharges } from "@/lib/late-charges/rules";
import type { LateChargeView } from "@/lib/late-charges/charges";
import { LateFeeSwitch } from "./late-fee-switch";

export function LateChargeFigures({ v }: { v: LateChargeView }) {
  const rows: [string, React.ReactNode][] = [
    ["Late fee", v.feeAccrued > 0 ? rupee(v.feeAccrued) : "—"],
    [
      v.interestApplies ? `Interest (${v.interestPct}% a year)` : "Interest",
      v.interestApplies ? `${rupee(v.interestAccrued)}${v.daysLate > 0 ? ` · ${v.daysLate} ${v.daysLate === 1 ? "day" : "days"}` : ""}` : "Not charged — customer is not GST-registered",
    ],
    ["Already billed", v.feeBilled + v.interestBilled > 0 ? rupee(v.feeBilled + v.interestBilled) : "—"],
    ["To bill now", v.toBill > 0 ? `${rupee(v.toBill)}${v.gstToBill !== null ? ` + GST ${rupee(v.gstToBill)} = ${rupee(v.grossToBill ?? 0)}` : " + GST (rate unknown)"}` : "—"],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      {rows.map(([k, val]) => (
        <React.Fragment key={k}>
          <dt className="text-ink-3">{k}</dt>
          <dd className="text-ink tabular-nums">{val}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function InvoiceLateCharges({ invoiceId }: { invoiceId: string }) {
  const { data: me } = useCurrentUser();
  const q = useLateCharges({ invoiceId });
  const bill = useBillLateCharges();
  const waive = useWaiveLateCharges();
  const confirm = useConfirm();
  const askText = useAskText();
  const isOwner = mayBillLateCharges(me?.role);
  const row = q.data?.[0];

  const onBill = async () => {
    if (!row) return;
    const v = row.view;
    if (v.taxRate === null) {
      toast.error("This invoice has no GST rate stored", { description: "Late charges cannot be taxed correctly. Ask your accountant which rate applies." });
      return;
    }
    const ok = await confirm({
      title: `Bill ${rupee(v.toBill)} late charges + GST?`,
      body: `A separate debit note on ${row.invoiceId} for ${rupee(v.grossToBill ?? 0)}: `
        + `${v.feeToBill > 0 ? `late fee ${rupee(v.feeToBill)}` : ""}${v.feeToBill > 0 && v.interestToBill > 0 ? " + " : ""}`
        + `${v.interestToBill > 0 ? `interest ${rupee(v.interestToBill)}` : ""}, GST ${v.taxRate}% (the invoice's own rate).\n`
        + "The invoice itself does not change. Nothing is sent to the customer.",
      confirmLabel: "Bill late charges",
      icon: "receipt",
    });
    if (!ok) return;
    try {
      const res = await bill.mutateAsync(row);
      toast.success(`Debit note ${res.debit_note_id} raised`, { description: `${rupee(res.gross)} late charges on ${row.invoiceId}.` });
    } catch (e) {
      toastError(e, { fallback: "Late charges not billed.", description: "Nothing was billed. Refresh and try again." });
    }
  };

  const onWaive = async () => {
    if (!row) return;
    const reason = await askText({
      title: `Waive late charges on ${row.invoiceId}?`,
      body: "No more late fee or interest will build up on this invoice. Anything already billed stays billed — raise a credit note for that if needed.",
      label: "Reason (kept on record)",
      placeholder: "e.g. bank delay, long-time customer",
      confirmLabel: "Waive",
    });
    if (!reason) return;
    try {
      await waive.mutateAsync({ invoiceId: row.invoiceId, reason });
      toast.success("Late charges waived", { description: `Recorded: ${reason}` });
    } catch (e) {
      toastError(e, { fallback: "Not waived.", description: "Nothing changed. Only the owner can waive." });
    }
  };

  return (
    <Card className="p-4">
      <p className="text-xs font-semibold text-ink mb-2">Late payment charges</p>
      <LateFeeSwitch level="invoice" id={invoiceId} className="mb-3" />
      {q.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : q.isError ? (
        <LoadError what="Late charges" onRetry={() => void q.refetch()} />
      ) : !row ? (
        <p className="text-xs text-ink-3">No late charges — this invoice has no due date or is not issued.</p>
      ) : !row.view.applies ? (
        <p className="text-xs text-ink-3">{row.view.reason}</p>
      ) : (
        <>
          <LateChargeFigures v={row.view} />
          <p className="text-3xs text-ink-3 mt-2">
            {row.view.reason}
            {row.settings.graceDays > 0 && ` Grace ${row.settings.graceDays} days after the due date ${row.dueDate ? formatDate(row.dueDate) : ""}.`}
          </p>
          {isOwner && (
            <div className="flex flex-wrap gap-2 mt-3">
              <Button size="sm" variant="primary" icon="receipt" disabled={row.view.toBill <= 0} loading={bill.isPending} onClick={onBill}>
                Bill late charges
              </Button>
              <Button size="sm" variant="outline" loading={waive.isPending} onClick={onWaive}>
                Waive
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
