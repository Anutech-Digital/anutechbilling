/**
 * R-1839 — the "not an expense, not income" owner choice in Banking → Reconcile.
 *
 *   money OUT (debit):
 *     proprietor / partnership / LLP → "Owner drawings" / "Partner drawings" / "Partner withdrawal":
 *       book this line as drawings — or, when an entry was recorded by hand for the same amount
 *       on this account, use that entry (its manual line is replaced, so nothing counts twice).
 *     Pvt Ltd → "Paid to a director?": salary / loan to the director (s.185 caution) /
 *       reimbursement / dividend — each points to the path that already exists. Never drawings.
 *   money IN (credit), non-company types → "Capital introduced", same two ways.
 *
 * Every booking goes through book_bank_txn_as_owner_equity (one transaction, P&L untouched).
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rupee, formatDate } from "@/lib/utils";
import { useComplianceProfile } from "@/lib/compliance/profile";
import { DIRECTOR_CHOICES, ownerEquityWords, type OwnerEquityMovement } from "@/lib/accounting/owner-equity";
import { useOwnerEquityMovements, useBookBankTxnAsOwnerEquity } from "@/lib/queries/owner-equity";
import type { BankTransactionRow } from "@/lib/queries/bank";

const dayGap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** Entries recorded by hand that this line could be: same account, same direction, same amount, nearest date first. */
export function ownerEntryCandidates(
  movements: readonly OwnerEquityMovement[],
  txn: Pick<BankTransactionRow, "bank_account_id" | "txn_date" | "debit" | "credit">,
): OwnerEquityMovement[] {
  const isDebit = (txn.debit ?? 0) > 0;
  const amount = isDebit ? txn.debit : txn.credit;
  return movements
    .filter((m) => m.own_line && m.bank_account_id === txn.bank_account_id && m.amount === amount
      && m.kind === (isDebit ? "drawings" : "capital_introduced"))
    .sort((a, b) => dayGap(a.movement_date, txn.txn_date) - dayGap(b.movement_date, txn.txn_date))
    .slice(0, 3);
}

export function OwnerEquitySection({ transaction, onDone }: { transaction: BankTransactionRow; onDone: () => void }) {
  const profileQ = useComplianceProfile();
  const words = ownerEquityWords(profileQ.data?.businessType ?? null);
  const movementsQ = useOwnerEquityMovements(words.allowed);
  const book = useBookBankTxnAsOwnerEquity();
  const [partner, setPartner] = React.useState("");
  const [note, setNote] = React.useState("");
  React.useEffect(() => { setPartner(""); setNote(""); }, [transaction.id]);

  const isDebit = (transaction.debit ?? 0) > 0;
  const amount = isDebit ? transaction.debit : transaction.credit;
  const candidates = ownerEntryCandidates(movementsQ.data ?? [], transaction);
  const partners = [...new Set((movementsQ.data ?? []).map((m) => m.partner_name).filter((p): p is string => !!p))].sort();

  async function submit(movementId: string | null) {
    try {
      await book.mutateAsync({
        transactionId: transaction.id,
        partner: partner.trim() || null,
        note: note.trim() || null,
        movementId,
      });
      onDone();
    } catch { /* the hook shows the error */ }
  }

  if (!words.allowed) {
    // Pvt Ltd: money in is share capital / a director's loan — the existing box above covers it.
    if (!isDebit) return null;
    return (
      <div className="rounded-md border border-hairline bg-paper-2/30 p-3">
        <p className="text-xs font-semibold text-ink-2 mb-1">Paid to a director?</p>
        <p className="text-xs text-ink-3 mb-2 leading-relaxed">
          A company has no owner drawings. Money a director takes is one of these — book it where it belongs:
        </p>
        <ul className="space-y-1.5">
          {DIRECTOR_CHOICES.map((c) => (
            <li key={c.key} className="text-xs">
              <span className="text-ink font-medium">{c.label}</span>
              <span className="text-ink-3"> — {c.hint}</span>
              {c.key !== "dividend" && <> <Link href={c.href as never} className="text-indigo underline">Open</Link></>}
              {c.caution && <span className="block text-amber-ink bg-amber-soft/40 rounded px-2 py-1 mt-1">{c.caution}</span>}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const label = isDebit ? words.drawings : words.capital;
  const needPartner = words.needsPartner && !partner.trim();

  return (
    <div className={`rounded-md border p-3 ${isDebit ? "border-indigo/40 bg-indigo/5" : "border-emerald/40 bg-emerald/5"}`}>
      <p className="text-xs font-semibold text-ink-2 mb-1">
        {isDebit ? `Money the ${words.person} took out?` : `Money the ${words.person} put in?`}
      </p>
      <p className="text-xs text-ink-3 mb-3 leading-relaxed">
        {isDebit
          ? <>Personal use — cash, a transfer to a personal account, a personal bill. Book this {rupee(amount)} as <b>{label.toLowerCase()}</b>: it lowers the {words.person}&apos;s capital and is <b>not an expense</b>.</>
          : <>Book this {rupee(amount)} as <b>{label.toLowerCase()}</b>: it adds to the {words.person}&apos;s capital and is <b>not income</b>.</>}
      </p>

      {candidates.length > 0 && (
        <div className="mb-3 space-y-1.5">
          <p className="text-xs text-ink-2">Already recorded by hand? Use that entry — its manual line is replaced by this one:</p>
          {candidates.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-2 rounded-md border border-hairline bg-paper px-2.5 py-1.5">
              <span className="text-xs text-ink min-w-0">
                {formatDate(m.movement_date)} · {rupee(m.amount)}{m.partner_name ? ` · ${m.partner_name}` : ""}{m.note ? ` · ${m.note}` : ""}
              </span>
              <Button size="sm" variant="default" loading={book.isPending} onClick={() => submit(m.id)}>Use this entry</Button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {words.needsPartner && (
          <>
            <Input aria-label="Partner" list="oe-reconcile-partners" placeholder="Partner's name" value={partner}
              onChange={(e) => setPartner(e.target.value)} maxLength={200} />
            <datalist id="oe-reconcile-partners">{partners.map((p) => <option key={p} value={p} />)}</datalist>
          </>
        )}
        <Input aria-label="Note" placeholder={isDebit ? "Note (optional) — e.g. Home rent" : "Note (optional)"} value={note}
          onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </div>
      <Button size="sm" variant="primary" icon="check" className="mt-3"
        loading={book.isPending} disabled={needPartner} onClick={() => submit(null)}>
        Book {rupee(amount)} as {label.toLowerCase()}
      </Button>
      {needPartner && <p className="text-xs text-ink-3 mt-1">Enter the partner&apos;s name first — each partner has their own capital account.</p>}
    </div>
  );
}
