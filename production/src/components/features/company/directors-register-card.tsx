/**
 * R-1850 (epic R-1841, Phase 3) — Settings → Company → Directors.
 *
 * The directors register of a Pvt Ltd: name, DIN, PAN, designation, appointed / ceased, DSC
 * expiry, last DIR-3 KYC year, email / phone. Shown only when the business type resolves to
 * Pvt Ltd (lib/compliance/entity.ts — an empty type is Pvt Ltd) and only to the roles that can
 * read and change it (owner, manager, accountant — the RPCs check the same).
 *
 * Each current director shows "DSC expires in N days" and "KYC due 30 Jun <year>" (rules in
 * lib/company/directors.ts — R-1856's 3-yearly DIR-3 KYC). Reminders are R-1857's job.
 * A director who left gets a cessation date and moves to "Former directors" — not deleted.
 * Email / phone arrive masked for a role without can_view_contact_details (R-1009).
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { LoadErrorInline } from "@/components/shared/load-error";
import { useConfirm } from "@/components/providers/confirm-provider";
import { formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useComplianceProfile } from "@/lib/compliance/profile";
import {
  DESIGNATIONS, DESIGNATION_LABEL, showsDirectorsRegister, isActiveDirector, dscStatus, kycDue,
  directorFormErrors, normaliseDirectorInput,
  type CompanyDirector, type Designation, type DirectorFormInput, type DirectorFormErrors, type DscStatus,
} from "@/lib/company/directors";
import { useCompanyDirectors, useSaveCompanyDirector, useDeleteCompanyDirector } from "@/lib/queries/company-directors";

const REGISTER_ROLES = new Set(["owner", "manager", "accountant"]);

const EMPTY: DirectorFormInput = {
  name: "", din: "", pan: "", designation: "director", appointed_on: "", ceased_on: "",
  dsc_expiry: "", last_kyc_year: "", email: "", phone: "",
};

function toForm(d: CompanyDirector): DirectorFormInput {
  return {
    name: d.name, din: d.din, pan: d.pan ?? "", designation: d.designation,
    appointed_on: d.appointed_on ?? "", ceased_on: d.ceased_on ?? "", dsc_expiry: d.dsc_expiry ?? "",
    last_kyc_year: d.last_kyc_year ? String(d.last_kyc_year) : "", email: d.email ?? "", phone: d.phone ?? "",
  };
}

const DSC_TONE: Record<DscStatus["kind"], string> = {
  none: "text-ink-3", ok: "text-ink-2", soon: "text-amber-ink", expired: "text-rose",
};

// ── Add / edit dialog ──────────────────────────────────────────────────────────────────────

function DirectorDialog({ open, editing, directors, onClose }: {
  open: boolean; editing: CompanyDirector | null; directors: CompanyDirector[]; onClose: () => void;
}) {
  const save = useSaveCompanyDirector();
  const [form, setForm] = React.useState<DirectorFormInput>(EMPTY);
  const [errors, setErrors] = React.useState<DirectorFormErrors>({});

  React.useEffect(() => {
    if (!open) return;
    setForm(editing ? toForm(editing) : EMPTY);
    setErrors({});
  }, [open, editing]);

  const set = (k: keyof DirectorFormInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    const e = directorFormErrors(form, directors, editing?.id ?? null, istToday());
    setErrors(e);
    if (Object.keys(e).length) return;
    try {
      await save.mutateAsync({ id: editing?.id ?? null, ...normaliseDirectorInput(form) });
      onClose();
    } catch { /* the hook shows the error */ }
  }

  const err = (m?: string) => (m ? <p role="alert" className="text-xs text-rose mt-1">{m}</p> : null);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : "Add director"}</DialogTitle>
          <DialogDescription>As on the MCA master data for the company (mca.gov.in).</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <FormField label="Name" required htmlFor="cd-name">
            <Input id="cd-name" value={form.name} onChange={set("name")} maxLength={200} placeholder="As on PAN" />
            {err(errors.name)}
          </FormField>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="DIN" required htmlFor="cd-din">
              <Input id="cd-din" value={form.din} onChange={set("din")} maxLength={8} inputMode="numeric" placeholder="8 digits" />
              {err(errors.din)}
            </FormField>
            <FormField label="PAN" htmlFor="cd-pan">
              <Input id="cd-pan" value={form.pan} onChange={set("pan")} maxLength={10} placeholder="ABCDE1234F" autoCapitalize="characters" />
              {err(errors.pan)}
            </FormField>
            <FormField label="Designation" required htmlFor="cd-designation">
              <select id="cd-designation" value={form.designation} onChange={set("designation")}
                className="w-full h-9 rounded-md border border-hairline bg-paper px-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo/40">
                {DESIGNATIONS.map((d: Designation) => <option key={d} value={d}>{DESIGNATION_LABEL[d]}</option>)}
              </select>
            </FormField>
            <FormField label="DSC expiry date" htmlFor="cd-dsc">
              <Input id="cd-dsc" type="date" value={form.dsc_expiry} onChange={set("dsc_expiry")} />
            </FormField>
            <FormField label="Appointed on" htmlFor="cd-appointed">
              <Input id="cd-appointed" type="date" value={form.appointed_on} onChange={set("appointed_on")} />
            </FormField>
            <FormField label="Ceased on" htmlFor="cd-ceased">
              <Input id="cd-ceased" type="date" value={form.ceased_on} onChange={set("ceased_on")} />
              {err(errors.dates)}
            </FormField>
            <FormField label="Last DIR-3 KYC year" htmlFor="cd-kyc">
              <Input id="cd-kyc" value={form.last_kyc_year} onChange={set("last_kyc_year")} maxLength={4} inputMode="numeric" placeholder="e.g. 2025" />
              {err(errors.kyc)}
            </FormField>
            <FormField label="Email" htmlFor="cd-email">
              <Input id="cd-email" type="email" value={form.email} onChange={set("email")} maxLength={320} placeholder="name@company.in" />
              {err(errors.email)}
            </FormField>
            <FormField label="Phone" htmlFor="cd-phone">
              <Input id="cd-phone" type="tel" value={form.phone} onChange={set("phone")} maxLength={20} placeholder="10-digit mobile" />
              {err(errors.phone)}
            </FormField>
          </div>
          <p className="text-xs text-ink-3">
            The year you last filed DIR-3 KYC sets the next one: once every 3 years, by 30 June.
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={save.isPending} onClick={submit}>
            {editing ? "Save director" : "Add director"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── The card ───────────────────────────────────────────────────────────────────────────────

export function DirectorsRegisterCard() {
  const me = useCurrentUser();
  const profileQ = useComplianceProfile();
  const visible = profileQ.isSuccess && showsDirectorsRegister(profileQ.data?.businessType ?? null)
    && REGISTER_ROLES.has(me.data?.role ?? "");
  const directorsQ = useCompanyDirectors(visible);
  const del = useDeleteCompanyDirector();
  const confirm = useConfirm();
  const [dialog, setDialog] = React.useState<{ editing: CompanyDirector | null } | null>(null);

  if (!visible) return null;
  const today = istToday();
  const directors = directorsQ.data ?? [];
  const current = directors.filter((d) => isActiveDirector(d, today));
  const former = directors.filter((d) => !isActiveDirector(d, today));

  async function remove(d: CompanyDirector) {
    const ok = await confirm({
      title: `Remove ${d.name}?`,
      body: "Only for a director added by mistake. A director who resigned keeps their history — set a cessation date instead.",
      confirmLabel: "Remove", danger: true,
    });
    if (ok) del.mutate(d.id);
  }

  const row = (d: CompanyDirector, isCurrent: boolean) => {
    const dsc = dscStatus(d.dsc_expiry, today);
    const kyc = kycDue(d.last_kyc_year, today);
    const contact = [d.email, d.phone].filter(Boolean).join(" · ");
    return (
      <li key={d.id} className="py-2.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-ink font-medium flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 break-words">{d.name}</span>
            <Badge kind="muted">{DESIGNATION_LABEL[d.designation] ?? d.designation}</Badge>
            {d.ceased_on && <Badge kind="muted">{isCurrent ? "Leaves" : "Ceased"} {formatDate(d.ceased_on)}</Badge>}
          </p>
          <p className="text-xs text-ink-3 mt-0.5 tabular-nums break-words">
            DIN {d.din}
            {d.pan ? ` · PAN ${d.pan}` : " · PAN not added"}
            {d.appointed_on ? ` · appointed ${formatDate(d.appointed_on)}` : ""}
          </p>
          {isCurrent && (
            <p className="text-xs mt-0.5 flex flex-wrap gap-x-2">
              <span className={DSC_TONE[dsc.kind]}>{dsc.text}</span>
              <span className="text-ink-3" aria-hidden>·</span>
              <span className={kyc.overdue ? "text-rose" : "text-ink-2"}>
                {kyc.text}{kyc.fromCycle ? " (add the last KYC year to be sure)" : ""}
              </span>
            </p>
          )}
          {contact && <p className="text-xs text-ink-3 mt-0.5 break-words">{contact}</p>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant="ghost" onClick={() => setDialog({ editing: d })} aria-label={`Edit ${d.name}`}>Edit</Button>
          <button type="button" onClick={() => remove(d)} aria-label={`Remove ${d.name}`} className="text-ink-3 hover:text-rose p-1.5">
            <Icon name="trash" size={14} />
          </button>
        </div>
      </li>
    );
  };

  return (
    <Card id="directors" className="p-5 max-w-3xl scroll-mt-20">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">Directors</h2>
          <p className="text-xs text-ink-3 mt-1 max-w-xl leading-relaxed">
            The company&apos;s directors with their DIN, DSC expiry and next DIR-3 KYC. All ROC forms need a director&apos;s valid DSC.
          </p>
        </div>
        <Button size="sm" variant="primary" icon="plus" onClick={() => setDialog({ editing: null })}>Add director</Button>
      </div>

      {directorsQ.error ? (
        <div className="mt-3"><LoadErrorInline what="directors" onRetry={() => directorsQ.refetch()} error={directorsQ.error} /></div>
      ) : directorsQ.isLoading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : directors.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">No directors yet. A Pvt Ltd has at least 2 — add each with their DIN.</p>
      ) : (
        <>
          <ul className="mt-3 divide-y divide-hairline border-t border-hairline">{current.map((d) => row(d, true))}</ul>
          {former.length > 0 && (
            <>
              <p className="mt-4 text-3xs uppercase tracking-wider text-ink-3 font-semibold">Former directors</p>
              <ul className="divide-y divide-hairline">{former.map((d) => row(d, false))}</ul>
            </>
          )}
          <p className="mt-3 pt-2 border-t border-hairline text-3xs text-ink-3">
            DIR-3 KYC Web: once every 3 years by 30 June (MCA, G.S.R. 943(E)). Company filings:{" "}
            <Link href={"/compliance/roc" as never} className="text-indigo underline">Compliance Calendar → ROC</Link>.
          </p>
        </>
      )}

      <DirectorDialog open={dialog !== null} editing={dialog?.editing ?? null} directors={directors} onClose={() => setDialog(null)} />
    </Card>
  );
}
