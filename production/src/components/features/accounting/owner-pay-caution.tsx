/**
 * R-1846 — the caution in Add expense when a proprietor / partner books their own "salary".
 *
 * The rule is lib/accounting/owner-salary-guard.ts (pure, tested). This box shows it and offers
 * ONE click: record the same amount, date and account as drawings (R-1839's
 * record_owner_equity_movement — the bank / cash line moves in the same step) and close the
 * form without saving an expense. It never blocks: the person can still save the expense.
 * A Pvt Ltd (or an empty type) never sees it — R-1852: it sees instead "a director's salary goes
 * through Payroll" when the payee is a director on the payroll or the note says "director salary".
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { useComplianceProfile } from "@/lib/compliance/profile";
import { useFirmPartners } from "@/lib/queries/partners";
import { useRecordOwnerEquity } from "@/lib/queries/owner-equity";
import { showsPartnersRegister } from "@/lib/accounting/partners";
import { ownerPayCaution, drawingsFromExpense } from "@/lib/accounting/owner-salary-guard";
import { PartnerPicker } from "@/components/features/partners/partner-picker";
import Link from "next/link";
import { useCompanyDirectors } from "@/lib/queries/company-directors";
import { showsDirectorsRegister } from "@/lib/company/directors";
import { directorPaidByExpenseCaution } from "@/lib/accounting/director-remuneration";

export function OwnerPayCautionBox({ category, payee, text, amount, method, bankAccountId, pettyCashAccountId, date, today, onRecorded }: {
  category: string | null | undefined;
  payee: string;
  /** The note(s) as typed. */
  text: string;
  amount: number;
  method: string | null | undefined;
  bankAccountId: string;
  pettyCashAccountId: string;
  /** The expense date, YYYY-MM-DD. */
  date: string;
  today: string;
  /** Drawings recorded — close the expense form (nothing else is saved). */
  onRecorded: () => void;
}) {
  const businessType = useComplianceProfile().data?.businessType ?? null;
  const partnersQ = useFirmPartners(showsPartnersRegister(businessType));
  const record = useRecordOwnerEquity();
  const [pickedPartner, setPickedPartner] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);

  /* R-1852: a company paying a director's SALARY as an expense → Payroll (TDS on salary, s.192). */
  const directorsQ = useCompanyDirectors(showsDirectorsRegister(businessType));
  const directorCaution = directorPaidByExpenseCaution({
    businessType, category, payee, text, directors: directorsQ.data ?? [], onDate: date || today,
  });

  const caution = ownerPayCaution({ businessType, category, payee, text, partners: partnersQ.data ?? [], onDate: date });
  if (!caution && directorCaution) {
    return (
      <div role="status" data-testid="director-pay-caution" className="rounded-md border border-amber/50 bg-amber-soft px-3 py-2.5 text-xs text-ink-2 space-y-2">
        <p className="font-semibold text-amber-ink">{directorCaution.title}</p>
        <p className="leading-relaxed">{directorCaution.body}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm"><Link href="/accounting/payroll">Open Payroll</Link></Button>
          <span className="text-ink-3">You can still save this expense — nothing is blocked.</span>
        </div>
      </div>
    );
  }
  if (!caution) return null;

  async function recordAsDrawings() {
    if (!caution) return;
    const r = drawingsFromExpense({ amount, method, bankAccountId, pettyCashAccountId });
    if (!r.ok) { setErr(r.error); return; }
    const partner = caution.who === "partner" ? (caution.partnerName ?? pickedPartner) : null;
    if (caution.who === "partner" && !partner) { setErr("Pick the partner who took the money."); return; }
    if (!date || date > today) { setErr("Pick the date the money was taken (not a future date)."); return; }
    setErr(null);
    const note = [payee.trim(), text.trim()].filter(Boolean).join(" — ") || null;
    try {
      await record.mutateAsync({ kind: "drawings", date, amount: r.amount, accountId: r.accountId, partner, note });
      onRecorded();
    } catch { /* the hook shows the error */ }
  }

  return (
    <div role="status" data-testid="owner-pay-caution" className="rounded-md border border-amber/50 bg-amber-soft px-3 py-2.5 text-xs text-ink-2 space-y-2">
      <p className="font-semibold text-amber-ink">{caution.title}</p>
      <p className="leading-relaxed">{caution.body}</p>
      {caution.who === "partner" && !caution.partnerName && (
        <div>
          <label htmlFor="owner-pay-partner" className="text-xs font-medium text-ink-2">Partner</label>
          <div className="mt-1">
            <PartnerPicker id="owner-pay-partner" partners={partnersQ.data ?? []} onDate={date || today}
              value={pickedPartner} onChange={setPickedPartner} loading={partnersQ.isLoading} />
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => void recordAsDrawings()} disabled={record.isPending}>
          {record.isPending ? "Recording…" : "Record as drawings instead"}
        </Button>
        <span className="text-ink-3">Uses the amount, date and the account below. No expense is saved.</span>
      </div>
      {err && <p role="alert" className="text-rose">{err}</p>}
    </div>
  );
}
