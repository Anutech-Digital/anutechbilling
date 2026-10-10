/**
 * R-530 — company setting for late payment charges (Accounting > Aging, next to Auto-pause),
 * and the owner's monthly "Bill late charges" run over every invoice with unbilled charges.
 *
 * OFF by default. Customer / subscription / invoice pages can override it (Default/On/Off).
 * Only the owner changes this card (set_late_fee_settings checks it and records the change).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { useConfirm } from "@/components/providers/confirm-provider";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { toastError } from "@/lib/errors/toast-error";
import { rupee } from "@/lib/utils";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import {
  useLateFeeSettings, useSaveLateFeeSettings, useAllLateCharges, useBillLateChargesBulk,
} from "@/lib/late-charges/queries";
import { mayBillLateCharges, type LateFeeSettings } from "@/lib/late-charges/rules";

type Draft = { enabled: boolean; interestPct: string; flatFee: string; graceDays: string; interestRegisteredOnly: boolean };

const toDraft = (s: LateFeeSettings): Draft => ({
  enabled: s.enabled, interestPct: String(s.interestPct), flatFee: String(s.flatFee),
  graceDays: String(s.graceDays), interestRegisteredOnly: s.interestRegisteredOnly,
});

export function LateFeeSettingsCard() {
  const { data: me } = useCurrentUser();
  const isOwner = mayBillLateCharges(me?.role);
  const q = useLateFeeSettings(me?.tenantId);
  const save = useSaveLateFeeSettings();
  const all = useAllLateCharges(Boolean(me?.tenantId));
  const bulk = useBillLateChargesBulk();
  const confirm = useConfirm();
  const [d, setD] = React.useState<Draft | null>(null);

  React.useEffect(() => { if (q.data) setD(toDraft(q.data)); }, [q.data]);

  const pct = Number(d?.interestPct);
  const fee = Number(d?.flatFee);
  const grace = Number(d?.graceDays);
  const valid = d !== null && Number.isFinite(pct) && pct >= 0 && pct <= 36
    && Number.isInteger(fee) && fee >= 0 && fee <= 100000
    && Number.isInteger(grace) && grace >= 0 && grace <= 90;
  const changed = d !== null && q.data !== undefined && JSON.stringify(d) !== JSON.stringify(toDraft(q.data));

  const persist = (next: Draft) => {
    save.mutate({
      enabled: next.enabled, interestPct: Number(next.interestPct), flatFee: Number(next.flatFee),
      graceDays: Number(next.graceDays), interestRegisteredOnly: next.interestRegisteredOnly,
    }, {
      onSuccess: () => toast.success("Late charges setting saved"),
      onError: (e) => toastError(e, { fallback: "Setting not saved.", description: "Nothing changed. Only the owner can change it." }),
    });
  };

  const due = (all.data ?? []).filter((r) => r.view.applies && r.view.toBill > 0);
  const billable = due.filter((r) => r.view.taxRate !== null);
  const noRate = due.length - billable.length;
  const total = billable.reduce((s, r) => s + (r.view.grossToBill ?? 0), 0);

  const onBulk = async () => {
    const ok = await confirm({
      title: `Bill late charges on ${billable.length} ${billable.length === 1 ? "invoice" : "invoices"}?`,
      body: `One debit note per invoice, ${rupee(total)} in all including GST at each invoice's own rate. `
        + "The invoices themselves do not change. Nothing is sent to customers."
        + (noRate > 0 ? `\n${noRate} invoice(s) with no GST rate stored are skipped.` : ""),
      confirmLabel: "Bill all",
      icon: "receipt",
    });
    if (!ok) return;
    const res = await bulk.mutateAsync(billable);
    if (res.failed.length === 0) toast.success(`${res.ok.length} debit notes raised`);
    else toast.error(`${res.ok.length} billed, ${res.failed.length} not billed`, {
      description: res.failed.slice(0, 3).map((f) => `${f.invoiceId}: ${f.message}`).join("\n"),
    });
  };

  return (
    <Card className="p-4 md:p-5 mt-8">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Collections</p>
          <h2 className="font-serif text-xl">Late payment charges</h2>
          <p className="text-sm text-ink-3 mt-1 max-w-3xl">
            A one-time late fee plus simple interest on what is still owed, counted in IST days after the due date
            and grace. Charges count from the day this is switched on. Billing raises a separate debit note with GST at
            the invoice&apos;s own rate (CGST s.15(2)(d) — confirm with your CA); the invoice never changes.
            Customers, subscriptions and invoices can override this.
          </p>
        </div>
        {d && (
          <div className="flex items-center gap-2">
            <Switch
              id="late-fee-switch"
              aria-label="Late payment charges for the company"
              checked={d.enabled}
              disabled={!isOwner || save.isPending}
              onCheckedChange={(v) => { const next = { ...d, enabled: v }; setD(next); if (valid) persist(next); }}
            />
            <label htmlFor="late-fee-switch" className="text-sm font-medium">{d.enabled ? "On" : "Off"}</label>
          </div>
        )}
      </div>

      {q.isLoading || !d ? (
        q.isError ? <LoadError what="Late charges setting" onRetry={() => void q.refetch()} /> : <Skeleton className="h-16 w-full" />
      ) : (
        <>
          <div className="flex items-end gap-3 flex-wrap">
            <Field id="late-pct" label="Interest % a year" value={d.interestPct} disabled={!isOwner} onChange={(v) => setD({ ...d, interestPct: v })} step="0.01" />
            <Field id="late-fee" label="Late fee ₹ (once)" value={d.flatFee} disabled={!isOwner} onChange={(v) => setD({ ...d, flatFee: v })} />
            <Field id="late-grace" label="Grace days" value={d.graceDays} disabled={!isOwner} onChange={(v) => setD({ ...d, graceDays: v })} />
            <label className="flex items-center gap-2 text-sm pb-2">
              <Switch
                aria-label="Interest only for GST-registered customers"
                checked={d.interestRegisteredOnly}
                disabled={!isOwner}
                onCheckedChange={(v) => setD({ ...d, interestRegisteredOnly: v })}
              />
              Interest only for GST-registered customers
            </label>
            {isOwner && (
              <Button size="sm" variant="outline" disabled={!changed || !valid || save.isPending} onClick={() => persist(d)}>
                Save
              </Button>
            )}
          </div>
          <p className="text-xs text-ink-3 mt-2">
            {valid ? "Unregistered customers get the late fee only when the switch above is on." : "Interest 0–36%, fee ₹0–1,00,000, grace 0–90 days."}
            {!isOwner && " Only the owner can change this."}
          </p>

          <h3 className="text-sm font-semibold mt-5 mb-2">Not yet billed ({due.length})</h3>
          {all.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : all.isError ? (
            <LoadError what="Late charges" onRetry={() => void all.refetch()} />
          ) : due.length === 0 ? (
            <p className="text-sm text-ink-3">None.</p>
          ) : (
            <>
              <ul className="divide-y divide-hairline">
                {due.slice(0, 50).map((r) => (
                  <li key={r.invoiceId} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="min-w-0">
                      <Link href={invoiceHref(r.invoiceId)} className="underline">{r.invoiceId}</Link>
                      <span className="text-ink-3"> · {r.customerName}</span>
                    </span>
                    <span className="tabular-nums text-ink-2 text-xs">
                      {rupee(r.view.toBill)}{r.view.gstToBill !== null ? ` + GST ${rupee(r.view.gstToBill)}` : " · no GST rate — skipped"}
                    </span>
                  </li>
                ))}
              </ul>
              {due.length > 50 && <p className="text-xs text-ink-3 mt-1">and {due.length - 50} more.</p>}
              {isOwner && billable.length > 0 && (
                <Button size="sm" variant="primary" icon="receipt" className="mt-3" loading={bulk.isPending} onClick={onBulk}>
                  Bill late charges on {billable.length} {billable.length === 1 ? "invoice" : "invoices"}
                </Button>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}

function Field({ id, label, value, onChange, disabled, step }: {
  id: string; label: string; value: string; onChange: (v: string) => void; disabled: boolean; step?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-ink-3 mb-1">{label}</label>
      <Input id={id} type="number" inputMode="decimal" min={0} step={step ?? "1"} className="w-28"
        value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
