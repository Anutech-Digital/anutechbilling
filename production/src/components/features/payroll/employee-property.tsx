/**
 * Company property with an employee + the exit checklist — a section of the employee
 * drawer. lib/payroll/employee-assets.ts decides; this only shows and records.
 */
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { FormField } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useConfirm } from "@/components/providers/confirm-provider";
import { rupee, formatDate, cn } from "@/lib/utils";
import { useEmployeeAssets, useIssueEmployeeAsset, useReturnEmployeeAsset, useDeleteEmployeeAsset, useOffboardingFacts, type EmployeeAsset } from "@/lib/queries/employee-assets";
import { useFixedAssets } from "@/lib/queries/fixed-assets";
import { ASSET_KINDS, RETURN_LABEL, holdings, offboardingChecklist, type AssetKind, type ReturnCondition } from "@/lib/payroll/employee-assets";
import { istToday } from "@/lib/dates/ist";

function todayIso(): string { return istToday(); }

export function EmployeeProperty({ employee }: { employee: { id: string; name: string; is_active: boolean } }) {
  const { data: rows } = useEmployeeAssets(employee.id);
  const facts = useOffboardingFacts(employee);
  const ret = useReturnEmployeeAsset();
  const del = useDeleteEmployeeAsset();
  const confirm = useConfirm();
  const [issueOpen, setIssueOpen] = React.useState(false);
  const [returning, setReturning] = React.useState<EmployeeAsset | null>(null);
  const [showChecklist, setShowChecklist] = React.useState(!employee.is_active);
  const h = holdings(rows ?? []);
  const checklist = facts.data ? offboardingChecklist({ employeeName: employee.name, isActive: employee.is_active, assets: rows ?? [], ...facts.data }) : null;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs font-semibold text-ink-2">Company property — <span className="font-normal text-ink-3">{h.summary}</span></p>
        <Button size="sm" variant="outline" icon="plus" onClick={() => setIssueOpen(true)}>Issue</Button>
      </div>

      {h.open.length === 0 && h.returned.length === 0 ? (
        <p className="text-xs text-ink-3 rounded-md border border-dashed border-hairline p-3">Laptop, phone, SIM, logins (Workspace / GitHub / bank portal), keys, ID card — record whatever the company has given here. This is the list to collect back when they leave.</p>
      ) : (
        <ul className="space-y-1">
          {h.open.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 rounded-md border border-hairline px-2.5 py-1.5 text-xs">
              <div className="min-w-0">
                <span className="font-medium text-ink">{a.name}</span>
                <span className="text-ink-3"> · {ASSET_KINDS[a.kind].label}{a.identifier ? ` · ${a.identifier}` : ""} · since {formatDate(a.issued_on)}</span>
              </div>
              <div className="shrink-0 flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => setReturning(a as EmployeeAsset)}>{ASSET_KINDS[a.kind].group === "access" ? "Revoke" : "Return"}</Button>
                <button type="button" aria-label="Delete entry" className="rounded p-1 text-ink-3 hover:text-rose" onClick={async () => { if (await confirm({ title: "Remove entry?", body: `${a.name} — remove only if it was entered by mistake; if it was given back, use Return.`, confirmLabel: "Remove", danger: true })) del.mutate(a.id); }}><Icon name="trash" size={13} /></button>
              </div>
            </li>
          ))}
          {h.returned.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1 text-xs text-ink-3">
              <span className="truncate">{a.name} · {a.return_condition ? RETURN_LABEL[a.return_condition] : "returned"} {a.returned_on ? formatDate(a.returned_on) : ""}</span>
              <button type="button" className="underline" onClick={() => ret.mutate({ id: a.id, returnedOn: null, condition: null })}>undo</button>
            </li>
          ))}
        </ul>
      )}

      {/* Exit checklist — open by default for an inactive employee, on demand otherwise. */}
      <div className="mt-3">
        <button type="button" className="text-xs text-amber-ink underline" onClick={() => setShowChecklist((v) => !v)}>
          {showChecklist ? "Hide exit checklist" : "View exit / offboarding checklist"}
        </button>
        {showChecklist && checklist && (
          <div className={cn("mt-2 rounded-md border p-3", checklist.ready ? "border-emerald/40 bg-emerald/5" : "border-amber/40 bg-amber-soft/20")}>
            <p className="text-xs font-semibold text-ink mb-1.5">{checklist.ready ? "All clear — you can mark them inactive." : "Before marking inactive:"}</p>
            <ul className="space-y-1">
              {checklist.items.map((it) => (
                <li key={it.key} className="flex items-start gap-2 text-xs">
                  <Icon name={it.status === "done" ? "check" : it.status === "todo" ? "x" : "alert"} size={13} className={cn("mt-0.5 shrink-0", it.status === "done" ? "text-emerald" : it.status === "todo" ? "text-rose" : "text-amber-ink")} />
                  <span><b className="text-ink">{it.title}</b> <span className="text-ink-2">— {it.detail}</span></span>
                </li>
              ))}
            </ul>
            {facts.data && facts.data.loanOutstanding > 0 && <p className="mt-1.5 text-xs text-ink-3">Advance {rupee(facts.data.loanOutstanding)} — enter it under "Advance recovered" in the full & final payslip.</p>}
          </div>
        )}
      </div>

      {issueOpen && <IssueDialog employeeId={employee.id} employeeName={employee.name} onClose={() => setIssueOpen(false)} />}
      {returning && (
        <ReturnDialog asset={returning} onClose={() => setReturning(null)}
          onSave={(d, c, n) => ret.mutate({ id: returning.id, returnedOn: d, condition: c, notes: n }, { onSuccess: () => setReturning(null) })} pending={ret.isPending} />
      )}
    </div>
  );
}

function IssueDialog({ employeeId, employeeName, onClose }: { employeeId: string; employeeName: string; onClose: () => void }) {
  const issue = useIssueEmployeeAsset();
  const { data: fixed } = useFixedAssets();
  const { data: allIssued } = useEmployeeAssets();
  const held = new Set((allIssued ?? []).filter((a) => !a.returned_on && a.fixed_asset_id).map((a) => a.fixed_asset_id));
  const [kind, setKind] = React.useState<AssetKind>("laptop");
  const [name, setName] = React.useState("");
  const [identifier, setIdentifier] = React.useState("");
  const [fixedId, setFixedId] = React.useState("");
  const [issuedOn, setIssuedOn] = React.useState(todayIso());
  const [notes, setNotes] = React.useState("");
  const pickFixed = (id: string) => {
    setFixedId(id);
    const f = (fixed ?? []).find((x) => x.id === id);
    if (f) { setName(f.name); if (f.block === "computers") setKind("laptop"); else if (f.block === "vehicles") setKind("vehicle"); else setKind("other"); }
  };
  const valid = name.trim().length > 0 && !!issuedOn;
  async function submit() {
    if (!valid) return;
    try {
      await issue.mutateAsync({ employeeId, kind, name, identifier: identifier || null, fixedAssetId: fixedId || null, issuedOn, notes: notes || null });
      onClose();
    } catch { /* hook toasts */ }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Issue to {employeeName}</DialogTitle>
          <DialogDescription>Company property being handed to them. If it is in the asset register, pick it from there — one asset can be with only one person at a time.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {(fixed ?? []).filter((f) => !f.disposed_on).length > 0 && (
            <FormField label="From fixed asset register" htmlFor="ea_fixed">
              <select id="ea_fixed" value={fixedId} onChange={(e) => pickFixed(e.target.value)} className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink">
                <option value="">— none, separate item —</option>
                {(fixed ?? []).filter((f) => !f.disposed_on).map((f) => <option key={f.id} value={f.id} disabled={held.has(f.id)}>{f.name} · {rupee(f.cost)}{held.has(f.id) ? " (with someone else)" : ""}</option>)}
              </select>
            </FormField>
          )}
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Item type" required htmlFor="ea_kind">
              <select id="ea_kind" value={kind} onChange={(e) => setKind(e.target.value as AssetKind)} className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink">
                {(Object.keys(ASSET_KINDS) as AssetKind[]).map((k) => <option key={k} value={k}>{ASSET_KINDS[k].label}</option>)}
              </select>
              <p className="text-xs text-ink-3 mt-1">{ASSET_KINDS[kind].examples}</p>
            </FormField>
            <FormField label="Date" required htmlFor="ea_date"><Input id="ea_date" type="date" value={issuedOn} max={todayIso()} onChange={(e) => setIssuedOn(e.target.value)} /></FormField>
          </div>
          <FormField label="Name" required htmlFor="ea_name"><Input id="ea_name" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "access" ? "e.g. Google Workspace — asha@anutech.in" : "e.g. MacBook Air M3"} /></FormField>
          <FormField label="Serial / IMEI / number / login" htmlFor="ea_ident"><Input id="ea_ident" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="optional" /></FormField>
          <FormField label="Note" htmlFor="ea_notes"><Input id="ea_notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="with charger, condition…" /></FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" disabled={!valid} loading={issue.isPending} onClick={submit}>Issue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReturnDialog({ asset, onClose, onSave, pending }: { asset: EmployeeAsset; onClose: () => void; onSave: (d: string, c: ReturnCondition, n: string | null) => void; pending: boolean }) {
  const isAccess = ASSET_KINDS[asset.kind].group === "access";
  const [date, setDate] = React.useState(todayIso());
  const [cond, setCond] = React.useState<ReturnCondition>(isAccess ? "revoked" : "ok");
  const [notes, setNotes] = React.useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-sm">
        <DialogHeader>
          <DialogTitle>{isAccess ? "Revoke access" : "Mark returned"} — {asset.name}</DialogTitle>
          <DialogDescription>{isAccess ? "Reset the password / suspend the account, then mark it here." : "Note the condition — if damaged or lost, also check the fixed asset register."}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Date" required htmlFor="er_date"><Input id="er_date" type="date" value={date} min={asset.issued_on} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></FormField>
          <FormField label="Condition" htmlFor="er_cond">
            <select id="er_cond" value={cond} onChange={(e) => setCond(e.target.value as ReturnCondition)} className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink">
              {(isAccess ? (["revoked"] as ReturnCondition[]) : (["ok", "damaged", "lost"] as ReturnCondition[])).map((c) => <option key={c} value={c}>{RETURN_LABEL[c]}</option>)}
            </select>
          </FormField>
        </div>
        <FormField label="Note" htmlFor="er_notes"><Input id="er_notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" /></FormField>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={pending} disabled={!date} onClick={() => onSave(date, cond, notes || null)}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
