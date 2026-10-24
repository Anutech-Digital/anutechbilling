/**
 * R-1847 (epic R-1841, Phase 2) — Settings → Company → Partners.
 *
 * The partners register of a partnership firm or LLP: name, PAN, DIN/DPIN + designated partner
 * (LLP), profit share %, capital contribution, joined / left. Shown only when the business
 * type is Partnership or LLP (lib/compliance/entity.ts resolver — an empty type is Pvt Ltd),
 * and only to the money roles (owner, manager, accountant) who can read and change it.
 * Shares that do not add up to 100 % get an amber warning — saving is never blocked.
 * A partner who has drawings / capital entries is not deleted — they get a leaving date.
 */
"use client";

import * as React from "react";

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
import { rupee, formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useComplianceProfile } from "@/lib/compliance/profile";
import {
  showsPartnersRegister, isActivePartner, shareWarning, shareTotal, partnerFormErrors, normalisePartnerInput,
  type FirmPartner, type PartnerFormInput, type PartnerFormErrors,
} from "@/lib/accounting/partners";
import { useFirmPartners, useSaveFirmPartner, useDeleteFirmPartner } from "@/lib/queries/partners";

const MONEY_ROLES = new Set(["owner", "manager", "accountant"]);

const EMPTY: PartnerFormInput = { name: "", pan: "", din_dpin: "", profit_share_pct: "", capital_contribution: "", joined_on: "", left_on: "" };

function toForm(p: FirmPartner): PartnerFormInput {
  return {
    name: p.name, pan: p.pan ?? "", din_dpin: p.din_dpin ?? "",
    profit_share_pct: String(p.profit_share_pct), capital_contribution: p.capital_contribution ? String(p.capital_contribution) : "",
    joined_on: p.joined_on ?? "", left_on: p.left_on ?? "",
  };
}

// ── Add / edit dialog ──────────────────────────────────────────────────────────────────────

function PartnerDialog({ open, editing, partners, isLlp, onClose }: {
  open: boolean; editing: FirmPartner | null; partners: FirmPartner[]; isLlp: boolean; onClose: () => void;
}) {
  const save = useSaveFirmPartner();
  const [form, setForm] = React.useState<PartnerFormInput>(EMPTY);
  const [designated, setDesignated] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [errors, setErrors] = React.useState<PartnerFormErrors>({});

  React.useEffect(() => {
    if (!open) return;
    setForm(editing ? toForm(editing) : EMPTY);
    setDesignated(editing?.is_designated ?? false);
    setNote(editing?.note ?? "");
    setErrors({});
  }, [open, editing]);

  const set = (k: keyof PartnerFormInput) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    const e = partnerFormErrors(form, partners, editing?.id ?? null);
    setErrors(e);
    if (Object.keys(e).length) return;
    try {
      await save.mutateAsync({ id: editing?.id ?? null, ...normalisePartnerInput(form), is_designated: isLlp && designated, note: note.trim() || null });
      onClose();
    } catch { /* the hook shows the error */ }
  }

  const err = (m?: string) => (m ? <p role="alert" className="text-xs text-rose mt-1">{m}</p> : null);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : "Add partner"}</DialogTitle>
          <DialogDescription>
            As in the {isLlp ? "LLP agreement" : "partnership deed"}. Drawings and capital entries are recorded against this partner.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <FormField label="Name" required htmlFor="fp-name">
            <Input id="fp-name" value={form.name} onChange={set("name")} maxLength={200} placeholder="As on PAN" />
            {err(errors.name)}
          </FormField>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="PAN" htmlFor="fp-pan">
              <Input id="fp-pan" value={form.pan} onChange={set("pan")} maxLength={10} placeholder="ABCDE1234F" autoCapitalize="characters" />
              {err(errors.pan)}
            </FormField>
            {isLlp && (
              <FormField label="DPIN / DIN" htmlFor="fp-din">
                <Input id="fp-din" value={form.din_dpin} onChange={set("din_dpin")} maxLength={8} inputMode="numeric" placeholder="8 digits" />
                {err(errors.din)}
              </FormField>
            )}
            <FormField label="Profit share (%)" required htmlFor="fp-share">
              <Input id="fp-share" value={form.profit_share_pct} onChange={set("profit_share_pct")} inputMode="decimal" placeholder="e.g. 60" />
              {err(errors.share)}
            </FormField>
            <FormField label="Capital contribution (₹)" htmlFor="fp-capital">
              <Input id="fp-capital" value={form.capital_contribution} onChange={set("capital_contribution")} inputMode="numeric" placeholder="e.g. 100000" />
              {err(errors.capital)}
            </FormField>
            <FormField label="Joined on" htmlFor="fp-joined">
              <Input id="fp-joined" type="date" value={form.joined_on} onChange={set("joined_on")} />
            </FormField>
            <FormField label="Left on" htmlFor="fp-left">
              <Input id="fp-left" type="date" value={form.left_on} onChange={set("left_on")} />
              {err(errors.dates)}
            </FormField>
          </div>
          <p className="text-xs text-ink-3">
            Capital contribution = the partner&apos;s capital before the entries recorded in this app (from the deed or your CA). Money put in later: Balance Sheet → Record capital.
          </p>
          {isLlp && (
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={designated} onChange={(e) => setDesignated(e.target.checked)} className="h-4 w-4" />
              Designated partner (signs LLP Form 8 / Form 11)
            </label>
          )}
          <FormField label="Note (optional)" htmlFor="fp-note">
            <Input id="fp-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="e.g. Deed dated 1 Apr 2024" />
          </FormField>
        </div>

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={save.isPending} onClick={submit}>
            {editing ? "Save partner" : "Add partner"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── The card ───────────────────────────────────────────────────────────────────────────────

export function PartnersRegisterCard() {
  const me = useCurrentUser();
  const profileQ = useComplianceProfile();
  const type = profileQ.data?.businessType ?? null;
  const visible = showsPartnersRegister(type) && MONEY_ROLES.has(me.data?.role ?? "");
  const partnersQ = useFirmPartners(visible);
  const del = useDeleteFirmPartner();
  const confirm = useConfirm();
  const [dialog, setDialog] = React.useState<{ editing: FirmPartner | null } | null>(null);

  if (!visible) return null;
  const isLlp = type === "llp";
  const today = istToday();
  const partners = partnersQ.data ?? [];
  const warning = shareWarning(partners, today);
  const current = partners.filter((p) => isActivePartner(p, today));
  const former = partners.filter((p) => !isActivePartner(p, today));

  async function remove(p: FirmPartner) {
    const ok = await confirm({
      title: `Remove ${p.name}?`,
      body: "Only for a partner added by mistake. A partner who has left keeps their history — set a leaving date instead.",
      confirmLabel: "Remove", danger: true,
    });
    if (ok) del.mutate(p.id);
  }

  const row = (p: FirmPartner) => (
    <li key={p.id} className="py-2.5 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-ink font-medium flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 break-words">{p.name}</span>
          {isLlp && p.is_designated && <Badge kind="muted">Designated</Badge>}
          {p.left_on && <Badge kind="muted">Left {formatDate(p.left_on)}</Badge>}
        </p>
        <p className="text-xs text-ink-3 mt-0.5 tabular-nums">
          {Number(p.profit_share_pct)}% share · capital {rupee(p.capital_contribution)}
          {p.pan ? ` · PAN ${p.pan}` : " · PAN not added"}
          {isLlp && p.din_dpin ? ` · DPIN ${p.din_dpin}` : ""}
          {p.joined_on ? ` · joined ${formatDate(p.joined_on)}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" onClick={() => setDialog({ editing: p })} aria-label={`Edit ${p.name}`}>Edit</Button>
        <button type="button" onClick={() => remove(p)} aria-label={`Remove ${p.name}`} className="text-ink-3 hover:text-rose p-1.5">
          <Icon name="trash" size={14} />
        </button>
      </div>
    </li>
  );

  return (
    <Card id="partners" className="p-5 max-w-3xl scroll-mt-20">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">Partners</h2>
          <p className="text-xs text-ink-3 mt-1 max-w-xl leading-relaxed">
            {isLlp ? "The LLP's partners" : "The firm's partners"} and their profit share. Drawings and capital entries are recorded against a partner from this list.
          </p>
        </div>
        <Button size="sm" variant="primary" icon="plus" onClick={() => setDialog({ editing: null })}>Add partner</Button>
      </div>

      {partnersQ.error ? (
        <div className="mt-3"><LoadErrorInline what="partners" onRetry={() => partnersQ.refetch()} error={partnersQ.error} /></div>
      ) : partnersQ.isLoading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : partners.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">No partners yet. Add each partner with their profit share (together 100%).</p>
      ) : (
        <>
          {warning && <p role="alert" className="mt-3 text-xs text-amber-ink bg-amber-soft/40 rounded px-2 py-1.5">{warning}</p>}
          <ul className="mt-3 divide-y divide-hairline border-t border-hairline">{current.map(row)}</ul>
          {current.length > 0 && (
            <p className="text-xs text-ink-3 pt-2 border-t border-hairline tabular-nums">Total share: {shareTotal(current, today)}%</p>
          )}
          {former.length > 0 && (
            <>
              <p className="mt-4 text-3xs uppercase tracking-wider text-ink-3 font-semibold">Former partners</p>
              <ul className="divide-y divide-hairline">{former.map(row)}</ul>
            </>
          )}
        </>
      )}

      <PartnerDialog open={dialog !== null} editing={dialog?.editing ?? null} partners={partners} isLlp={isLlp} onClose={() => setDialog(null)} />
    </Card>
  );
}
