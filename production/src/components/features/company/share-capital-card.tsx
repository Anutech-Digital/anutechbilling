/**
 * R-1851 (epic R-1841, Phase 3) — Settings → Company → Share capital.
 *
 * Authorised capital + face value per share, and the shareholders (name, PAN, shares, date of
 * allotment). Paid-up = the holders' shares × face value; each holder's % of the paid-up shares.
 * The Balance Sheet's "Share capital" reads paid-up from here. Only a Pvt Ltd (empty type = Pvt
 * Ltd), only the owner / manager / accountant (the RPCs check the same).
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { LoadErrorInline } from "@/components/shared/load-error";
import { useConfirm } from "@/components/providers/confirm-provider";
import { formatDate, num, rupee } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useComplianceProfile } from "@/lib/compliance/profile";
import {
  showsShareCapital, shareCapitalSummary, capitalFormErrors, normaliseCapitalInput,
  shareholderFormErrors, normaliseShareholderInput,
  type ShareCapital, type Shareholder, type CapitalFormErrors, type ShareholderFormInput, type ShareholderFormErrors,
} from "@/lib/company/share-capital";
import { useShareCapital, useSaveShareCapital, useSaveShareholder, useDeleteShareholder } from "@/lib/queries/share-capital";

const REGISTER_ROLES = new Set(["owner", "manager", "accountant"]);
const EMPTY: ShareholderFormInput = { name: "", pan: "", shares: "", allotted_on: "" };

// ── Authorised capital + face value ───────────────────────────────────────────────────────

function CapitalForm({ capital, issuedShares }: { capital: ShareCapital | null; issuedShares: number }) {
  const save = useSaveShareCapital();
  const [authorised, setAuthorised] = React.useState(capital ? String(capital.authorised_capital) : "");
  const [faceValue, setFaceValue] = React.useState(capital ? String(capital.face_value) : "10");
  const [errors, setErrors] = React.useState<CapitalFormErrors>({});
  React.useEffect(() => {
    if (!capital) return;
    setAuthorised(String(capital.authorised_capital));
    setFaceValue(String(capital.face_value));
  }, [capital]);

  const dirty = !capital || String(capital.authorised_capital) !== authorised.trim() || String(capital.face_value) !== faceValue.trim();

  function submit() {
    const input = { authorised_capital: authorised, face_value: faceValue };
    const e = capitalFormErrors(input, issuedShares);
    setErrors(e);
    if (Object.keys(e).length) return;
    save.mutate(normaliseCapitalInput(input));
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-[1fr_10rem_auto] gap-3 items-start">
      <FormField label="Authorised capital (₹)" required htmlFor="sc-authorised">
        <Input id="sc-authorised" value={authorised} onChange={(e) => setAuthorised(e.target.value)} inputMode="numeric" placeholder="e.g. 1000000" />
        {errors.authorised && <p role="alert" className="text-xs text-rose mt-1">{errors.authorised}</p>}
      </FormField>
      <FormField label="Face value per share (₹)" required htmlFor="sc-fv">
        <Input id="sc-fv" value={faceValue} onChange={(e) => setFaceValue(e.target.value)} inputMode="numeric" placeholder="e.g. 10" />
        {errors.faceValue && <p role="alert" className="text-xs text-rose mt-1">{errors.faceValue}</p>}
      </FormField>
      <div className="sm:pt-6">
        <Button size="sm" variant="primary" icon="check" loading={save.isPending} disabled={!dirty || save.isPending} onClick={submit}>
          Save capital
        </Button>
      </div>
    </div>
  );
}

// ── Add / edit shareholder ────────────────────────────────────────────────────────────────

function ShareholderDialog({ open, editing, holders, capital, onClose }: {
  open: boolean; editing: Shareholder | null; holders: Shareholder[]; capital: ShareCapital | null; onClose: () => void;
}) {
  const save = useSaveShareholder();
  const [form, setForm] = React.useState<ShareholderFormInput>(EMPTY);
  const [errors, setErrors] = React.useState<ShareholderFormErrors>({});
  React.useEffect(() => {
    if (!open) return;
    setForm(editing ? { name: editing.name, pan: editing.pan ?? "", shares: String(editing.shares), allotted_on: editing.allotted_on ?? "" } : EMPTY);
    setErrors({});
  }, [open, editing]);
  const set = (k: keyof ShareholderFormInput) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    const e = shareholderFormErrors(form, holders, editing?.id ?? null, capital);
    setErrors(e);
    if (Object.keys(e).length) return;
    try {
      await save.mutateAsync({ id: editing?.id ?? null, ...normaliseShareholderInput(form) });
      onClose();
    } catch { /* the hook shows the error */ }
  }
  const err = (m?: string) => (m ? <p role="alert" className="text-xs text-rose mt-1">{m}</p> : null);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : "Add shareholder"}</DialogTitle>
          <DialogDescription>As in the register of members (MGT-1). Shares are taken as fully paid.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormField label="Name" required htmlFor="sh-name">
            <Input id="sh-name" value={form.name} onChange={set("name")} maxLength={200} placeholder="Person or company" />
            {err(errors.name)}
          </FormField>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="PAN" htmlFor="sh-pan">
              <Input id="sh-pan" value={form.pan} onChange={set("pan")} maxLength={10} placeholder="ABCDE1234F" autoCapitalize="characters" />
              {err(errors.pan)}
            </FormField>
            <FormField label="Number of shares" required htmlFor="sh-shares">
              <Input id="sh-shares" value={form.shares} onChange={set("shares")} inputMode="numeric" placeholder="e.g. 50000" />
            </FormField>
            <FormField label="Date of allotment" htmlFor="sh-date">
              <Input id="sh-date" type="date" value={form.allotted_on} onChange={set("allotted_on")} />
            </FormField>
          </div>
          {err(errors.shares)}
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={save.isPending} onClick={submit}>
            {editing ? "Save shareholder" : "Add shareholder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── The card ───────────────────────────────────────────────────────────────────────────────

export function ShareCapitalCard() {
  const me = useCurrentUser();
  const profileQ = useComplianceProfile();
  const visible = profileQ.isSuccess && showsShareCapital(profileQ.data?.businessType ?? null)
    && REGISTER_ROLES.has(me.data?.role ?? "");
  const q = useShareCapital(visible);
  const del = useDeleteShareholder();
  const confirm = useConfirm();
  const [dialog, setDialog] = React.useState<{ editing: Shareholder | null } | null>(null);

  if (!visible) return null;
  const capital = q.data?.capital ?? null;
  const holders = q.data?.holders ?? [];
  const s = shareCapitalSummary(capital, holders);

  async function remove(h: Shareholder) {
    const ok = await confirm({
      title: `Remove ${h.name}?`,
      body: "Only for a shareholder added by mistake. Shares that were transferred: edit the holders so the register matches the transfer.",
      confirmLabel: "Remove", danger: true,
    });
    if (ok) del.mutate(h.id);
  }

  return (
    <Card id="share-capital" className="p-5 max-w-3xl scroll-mt-20">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">Share capital</h2>
          <p className="text-xs text-ink-3 mt-1 max-w-xl leading-relaxed">
            Authorised capital, face value and who holds the shares. The Balance Sheet&apos;s Share capital is the paid-up amount from here.
          </p>
        </div>
        {capital && <Button size="sm" variant="primary" icon="plus" onClick={() => setDialog({ editing: null })}>Add shareholder</Button>}
      </div>

      {q.error ? (
        <div className="mt-3"><LoadErrorInline what="share capital" onRetry={() => q.refetch()} error={q.error} /></div>
      ) : q.isLoading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : (
        <>
          <div className="mt-3"><CapitalForm capital={capital} issuedShares={s.paidUpShares} /></div>

          {capital && (
            <dl className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <div className="rounded bg-paper-2 px-2.5 py-2"><dt className="text-ink-3">Paid-up shares</dt><dd className="text-sm text-ink font-medium tabular-nums">{num(s.paidUpShares)}</dd></div>
              <div className="rounded bg-paper-2 px-2.5 py-2"><dt className="text-ink-3">Paid-up capital</dt><dd className="text-sm text-ink font-medium tabular-nums">{rupee(s.paidUpCapital)}</dd></div>
              <div className="rounded bg-paper-2 px-2.5 py-2"><dt className="text-ink-3">Not yet issued</dt><dd className="text-sm text-ink font-medium tabular-nums">{rupee(s.unissuedCapital)}</dd></div>
            </dl>
          )}
          {s.overAuthorised && (
            <p role="alert" className="mt-2 text-xs text-amber-ink bg-amber-soft/40 rounded px-2 py-1.5">
              Paid-up capital is more than the authorised capital — raise the authorised capital (ordinary resolution + SH-7 with the ROC).
            </p>
          )}

          {!capital ? (
            <p className="mt-3 text-sm text-ink-3">Save the authorised capital and face value first, then add the shareholders.</p>
          ) : holders.length === 0 ? (
            <p className="mt-3 text-sm text-ink-3">No shareholders yet. Add each one with the number of shares allotted.</p>
          ) : (
            <ul className="mt-3 divide-y divide-hairline border-t border-hairline">
              {s.holders.map((h) => (
                <li key={h.id} className="py-2.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-ink font-medium break-words">{h.name}</p>
                    <p className="text-xs text-ink-3 mt-0.5 tabular-nums">
                      {num(h.shares)} shares · {h.pct}% · {rupee(h.shares * (capital?.face_value ?? 0))}
                      {h.pan ? ` · PAN ${h.pan}` : " · PAN not added"}
                      {h.allotted_on ? ` · allotted ${formatDate(h.allotted_on)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ editing: h })} aria-label={`Edit ${h.name}`}>Edit</Button>
                    <button type="button" onClick={() => remove(h)} aria-label={`Remove ${h.name}`} className="text-ink-3 hover:text-rose p-1.5">
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {capital && holders.length > 0 && (
            <p className="text-xs text-ink-3 pt-2 border-t border-hairline">
              Shown on the <Link href={"/accounting/balance-sheet" as never} className="text-indigo underline">Balance Sheet</Link> as Share capital {rupee(s.paidUpCapital)}.
            </p>
          )}
        </>
      )}

      <ShareholderDialog open={dialog !== null} editing={dialog?.editing ?? null} holders={holders} capital={capital} onClose={() => setDialog(null)} />
    </Card>
  );
}
