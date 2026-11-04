/**
 * R-1871 — Banking → Reconcile: an employee's office-expense advance (imprest).
 *
 *   money-out → "Advance to employee (office expenses)": a new advance, or a top-up of the one
 *               they already hold. An ASSET (company money in their hand), never an expense —
 *               the expenses are the bills, added later on Accounting → Advances → Add bills.
 *             → "Reimbursement to employee": pays a reimbursement still owed (e.g. bills that
 *               went over the advance) — shown only when one of exactly this amount is pending.
 *   money-in  → "Advance returned by employee": the whole balance settles the advance; part of
 *               it leaves the rest with them (carried forward).
 *             → R-2407 "Paid to us by mistake — owe it back": ANY active employee (not only one
 *               with an open advance). Booked as owed back to them (a payable, not income); the
 *               salary payout that later carries it back shows "also pays back ₹X".
 * The employee is suggested from the bank text and the employee list. One atomic RPC per choice
 * (book_bank_txn_as_employee_advance), and un-reconciling the line reverses it.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rupee, formatDate } from "@/lib/utils";
import { useEmployees } from "@/lib/queries/payroll";
import { useEmployeeAdvances } from "@/lib/queries/advances";
import { suggestEmployee } from "@/lib/queries/incentive-from-bank";
import { useBookBankTxnAsEmployeeAdvance, usePendingReimbursements } from "@/lib/queries/employee-advance-bank";
import { advanceForReturn, openAdvancesOf, samePerson } from "@/lib/accounting/employee-advance";
import { compactName } from "@/lib/banking/salary-lines";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { useFooterSaveReport, type FooterSave } from "./reconcile-who-tiles";

const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";

/** The person a narration names: an employee first, else someone who already holds an advance. */
function suggestPerson(description: string | null, employees: { id: string; name: string; is_active?: boolean }[], holders: string[]): string {
  const id = suggestEmployee(description, employees);
  if (id) return employees.find((e) => e.id === id)?.name ?? "";
  const text = compactName(description ?? "");
  const hits = holders.filter((n) => {
    const first = compactName(n.split(/\s+/)[0] ?? "");
    return first.length >= 3 && text.includes(first);
  });
  return hits.length === 1 ? hits[0] : "";
}

export function EmployeeAdvanceBankSection({ transaction, onDone, onFooterSave }: {
  transaction: BankTransactionRow;
  onDone: () => void;
  /** R-2008: the Reconcile sheet draws the open form's Save (advance / top-up / return, or
   *  reimbursement) in its sticky footer. Given → no inline Save; same label, rule and submit(). */
  onFooterSave?: (save: FooterSave | null) => void;
}) {
  const isCredit = (transaction.credit ?? 0) > 0;
  const amount = isCredit ? transaction.credit : transaction.debit;
  const { data: employees } = useEmployees();
  const { data: advances } = useEmployeeAdvances();
  const pending = usePendingReimbursements(!isCredit);
  const book = useBookBankTxnAsEmployeeAdvance();

  const [open, setOpen] = React.useState<"" | "advance" | "reimburse">("");
  const [person, setPerson] = React.useState("");
  const [mode, setMode] = React.useState<"top_up" | "give">("give");
  const [advanceId, setAdvanceId] = React.useState("");
  const [note, setNote] = React.useState("");
  const [reimbId, setReimbId] = React.useState("");
  /* R-2407: money-in — an advance coming back, or money paid to us by mistake (owed back). */
  const [inKind, setInKind] = React.useState<"return" | "owed_back">("return");

  const activeEmployees = React.useMemo(() => (employees ?? []).filter((e) => e.is_active), [employees]);
  const openAdvances = React.useMemo(() => (advances ?? []).filter((a) => a.status === "active"), [advances]);
  const holders = React.useMemo(() => [...new Set(openAdvances.map((a) => a.employee_name))], [openAdvances]);
  const people = React.useMemo(() => {
    const names = activeEmployees.map((e) => e.name);
    for (const h of holders) if (!names.some((n) => samePerson(n, h))) names.push(h);
    return names.sort((a, b) => a.localeCompare(b));
  }, [activeEmployees, holders]);
  const suggested = React.useMemo(() => suggestPerson(transaction.description, activeEmployees, holders),
    [transaction.description, activeEmployees, holders]);

  const theirs = React.useMemo(() => (person ? openAdvancesOf(person, openAdvances) : []), [person, openAdvances]);
  const returnable = React.useMemo(() => openAdvances.filter((a) => a.remaining_balance > 0), [openAdvances]);
  const matchingReimb = React.useMemo(() => (pending.data ?? []).filter((r) => r.amount === amount), [pending.data, amount]);

  React.useEffect(() => { setOpen(""); setPerson(""); setAdvanceId(""); setNote(""); setReimbId(""); }, [transaction.id]);
  /* R-2407: what money-in is, on opening — an advance coming back when there is one to return and
     the bank text names nobody, a holder, or one with exactly this balance; else owed back. */
  const owedPeople = React.useMemo(() => activeEmployees.map((e) => e.name).sort((a, b) => a.localeCompare(b)), [activeEmployees]);
  const owedPerson = owedPeople.find((n) => samePerson(n, person)) ?? "";
  React.useEffect(() => {
    if (!isCredit || open !== "advance") return;
    const holds = suggested ? returnable.some((a) => samePerson(a.employee_name, suggested)) : false;
    const exact = returnable.some((a) => a.remaining_balance === amount);
    setInKind(returnable.length > 0 && (!suggested || holds || exact) ? "return" : "owed_back");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- decided once per opening; the owner's switch is kept
  }, [isCredit, open, transaction.id]);
  // Opening: pre-pick the person from the bank text; for a return, their advance that fits.
  React.useEffect(() => {
    if (open !== "advance" || person) return;
    if (suggested) setPerson(suggested);
  }, [open, person, suggested]);
  // Money-in: the named person's advance that fits, else the only one with exactly this balance.
  // A choice the person already made is kept.
  React.useEffect(() => {
    if (!isCredit || open !== "advance") return;
    const byPerson = person ? advanceForReturn(amount, person, returnable) : null;
    const exact = returnable.filter((a) => a.remaining_balance === amount);
    setAdvanceId((prev) => (prev && returnable.some((a) => a.id === prev))
      ? prev : (byPerson?.id ?? (exact.length === 1 ? exact[0].id : "")));
  }, [isCredit, open, person, amount, returnable]);
  // Money-out: someone who already holds an advance → top it up (changeable); else a new one.
  const theirKey = theirs.map((a) => a.id).join(",");
  React.useEffect(() => {
    if (isCredit) return;
    setAdvanceId(theirs[0]?.id ?? "");
    setMode(theirs.length > 0 ? "top_up" : "give");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-pick only when the person's advances change
  }, [isCredit, theirKey]);
  React.useEffect(() => {
    if (open === "reimburse" && !reimbId && matchingReimb.length === 1) setReimbId(matchingReimb[0].id);
  }, [open, reimbId, matchingReimb]);

  const picked = openAdvances.find((a) => a.id === advanceId) ?? null;
  const owedBack = isCredit && inKind === "owed_back";
  const tooMuch = isCredit && !owedBack && picked != null && amount > picked.remaining_balance;
  const canBook = owedBack ? Boolean(owedPerson)
    : isCredit
    ? Boolean(picked) && !tooMuch
    : Boolean(person.trim()) && (mode === "give" || Boolean(picked));

  /* R-2008: the open form's Save — same label, same rule, same submit() — in the footer. Nothing
     open (or nothing to show) → nothing in the footer. It books the whole line. */
  const advanceLabel = owedBack
    ? `Book ${rupee(amount)} as owed back to ${owedPerson || "the employee"}`
    : isCredit
    ? `Book ${rupee(amount)} as advance returned`
    : mode === "top_up" && theirs.length > 0
      ? `Book ${rupee(amount)} as top-up`
      : `Book ${rupee(amount)} as advance${person ? ` to ${person}` : ""}`;
  const reimburseLabel = `Book ${rupee(amount)} as reimbursement paid`;
  /* R-2407: money-in shows whenever there is an advance to return OR any active employee. */
  const shown = amount > 0 && !(isCredit && returnable.length === 0 && owedPeople.length === 0);
  useFooterSaveReport(onFooterSave, !shown ? null
    : open === "advance" ? { label: advanceLabel, onSave: () => { void submit(); }, disabled: !canBook, loading: book.isPending }
    : open === "reimburse" && !isCredit && matchingReimb.length > 0
      ? { label: reimburseLabel, onSave: () => { void submit(); }, disabled: !reimbId, loading: book.isPending }
    : null);
  const footerHasSave = Boolean(onFooterSave);

  if (!shown) return null;

  async function submit() {
    try {
      if (open === "reimburse") {
        await book.mutateAsync({ transactionId: transaction.id, kind: "reimburse", reimbursementId: reimbId });
      } else if (owedBack) {
        await book.mutateAsync({ transactionId: transaction.id, kind: "owed_back", name: owedPerson });
      } else if (isCredit) {
        await book.mutateAsync({ transactionId: transaction.id, kind: "return", advanceId });
      } else if (mode === "top_up") {
        await book.mutateAsync({ transactionId: transaction.id, kind: "top_up", advanceId });
      } else {
        await book.mutateAsync({ transactionId: transaction.id, kind: "give", name: person.trim(), note: note.trim() || null });
      }
      onDone();
    } catch { /* the hook shows the error */ }
  }

  const title = isCredit ? "Money in from an employee?" : "Advance to employee (office expenses)?";
  const blurb = isCredit
    ? "Unused office-expense advance paid back, or money they paid us by mistake (owed back to them — pay it with their salary). Not income."
    : "Money given to an employee to spend on office expenses. Held as company money with them (an asset) — the expenses are booked when their bills come in.";

  return (
    <div className="rounded-md border border-indigo/30 bg-indigo/5 p-3" data-testid="employee-advance-bank">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-2">{title}</p>
          <p className="text-xs text-ink-3 mt-0.5 leading-relaxed">{blurb}</p>
        </div>
        {open !== "advance" && (
          <Button size="sm" variant="default" onClick={() => setOpen("advance")}>{isCredit ? "Book return" : "Book advance"}</Button>
        )}
      </div>

      {open === "advance" && (
        <div className="mt-3 space-y-2">
          {isCredit && returnable.length > 0 && (
            <div className="space-y-1.5" role="radiogroup" aria-label="What is this money">
              <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer text-xs ${inKind === "return" ? "border-indigo bg-indigo/10" : "border-hairline"}`}>
                <input type="radio" name="emp-in-kind" checked={inKind === "return"} onChange={() => setInKind("return")} className="mt-0.5" />
                <span>Their office-expense advance coming back</span>
              </label>
              <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer text-xs ${inKind === "owed_back" ? "border-indigo bg-indigo/10" : "border-hairline"}`}>
                <input type="radio" name="emp-in-kind" checked={inKind === "owed_back"} onChange={() => setInKind("owed_back")} className="mt-0.5" />
                <span>Paid to us by mistake — we owe it back</span>
              </label>
            </div>
          )}
          {owedBack ? (
            /* R-2407: every active employee — not only those holding an advance. */
            <select value={owedPerson} onChange={(e) => setPerson(e.target.value)} aria-label="Employee" className={selectCls}>
              <option value="" disabled>Pick employee…</option>
              {owedPeople.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          ) : isCredit ? (
            <select value={advanceId} onChange={(e) => setAdvanceId(e.target.value)} aria-label="Employee advance" className={selectCls}>
              <option value="" disabled>Pick whose advance…</option>
              {returnable.map((a) => (
                <option key={a.id} value={a.id}>{a.employee_name} · {rupee(a.remaining_balance)} with them · given {formatDate(a.disbursed_date, "short")}</option>
              ))}
            </select>
          ) : (
            <>
              <select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Employee" className={selectCls}>
                <option value="" disabled>Pick employee…</option>
                {people.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              {person && theirs.length > 0 && (
                <div className="space-y-1.5" role="radiogroup" aria-label="New advance or top-up">
                  <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer text-xs ${mode === "top_up" ? "border-indigo bg-indigo/10" : "border-hairline"}`}>
                    <input type="radio" name="emp-adv-mode" checked={mode === "top_up"} onChange={() => setMode("top_up")} className="mt-0.5" />
                    <span>Top up their open advance{theirs.length === 1 ? ` (${rupee(theirs[0].remaining_balance)} with them now)` : ""}</span>
                  </label>
                  {mode === "top_up" && theirs.length > 1 && (
                    <select value={advanceId} onChange={(e) => setAdvanceId(e.target.value)} aria-label="Which advance" className={selectCls}>
                      {theirs.map((a) => <option key={a.id} value={a.id}>Given {formatDate(a.disbursed_date, "short")} · {rupee(a.remaining_balance)} with them</option>)}
                    </select>
                  )}
                  <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer text-xs ${mode === "give" ? "border-indigo bg-indigo/10" : "border-hairline"}`}>
                    <input type="radio" name="emp-adv-mode" checked={mode === "give"} onChange={() => setMode("give")} className="mt-0.5" />
                    <span>A separate new advance</span>
                  </label>
                </div>
              )}
              {mode === "give" && (
                <Input aria-label="Purpose (optional)" placeholder="Purpose (optional) — e.g. Office expenses, October" value={note} onChange={(e) => setNote(e.target.value)} />
              )}
            </>
          )}

          {owedBack && owedPerson && (
            <p className="text-xs text-ink-2 bg-paper rounded px-2 py-1.5 border border-hairline">
              {rupee(amount)} will be owed back to {owedPerson} (a payable, not income). When it goes back with their salary, reconcile that salary line — it shows &ldquo;also pays back {rupee(amount)}&rdquo;.
            </p>
          )}
          {isCredit && !owedBack && picked && (
            <p className="text-xs text-ink-2 bg-paper rounded px-2 py-1.5 border border-hairline">
              {tooMuch
                ? <span className="text-rose">Only {rupee(picked.remaining_balance)} is with {picked.employee_name} — this line is {rupee(amount)}.</span>
                : amount === picked.remaining_balance
                  ? <>{picked.employee_name}&apos;s advance is settled — {rupee(0)} left with them.</>
                  : <>{rupee(picked.remaining_balance - amount)} stays with {picked.employee_name} (carried forward).</>}
            </p>
          )}
          {!isCredit && person && (mode === "give" || picked) && (
            <p className="text-xs text-ink-2 bg-paper rounded px-2 py-1.5 border border-hairline">
              {mode === "top_up" && picked
                ? <>{rupee(picked.remaining_balance + amount)} will be with {person}. Add their bills on Accounting → Advances.</>
                : <>{rupee(amount)} will be with {person}. Add their bills on Accounting → Advances when they come in.</>}
            </p>
          )}

          <div className="flex gap-2 flex-wrap">
            {!footerHasSave && (
              <Button size="sm" variant="primary" icon="check" loading={book.isPending} disabled={!canBook} onClick={submit}>
                {advanceLabel}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setOpen("")}>Cancel</Button>
          </div>
          {!isCredit && (
            <p className="text-xs text-ink-3">Advance from Petty Cash? Give it on Accounting → Advances with Petty Cash. A salary advance or staff loan is not this — use Loans.</p>
          )}
        </div>
      )}

      {!isCredit && matchingReimb.length > 0 && (
        <div className="mt-3 border-t border-hairline pt-2">
          {open !== "reimburse" ? (
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs text-ink-2">
                Or paying a reimbursement owed to {matchingReimb.length === 1 ? matchingReimb[0].person_name : "an employee"} ({rupee(amount)})?
              </p>
              <Button size="sm" variant="default" onClick={() => setOpen("reimburse")}>Book reimbursement</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <select value={reimbId} onChange={(e) => setReimbId(e.target.value)} aria-label="Reimbursement" className={selectCls}>
                <option value="" disabled>Pick the reimbursement…</option>
                {matchingReimb.map((r) => (
                  <option key={r.id} value={r.id}>{r.person_name} · {rupee(r.amount)} · {formatDate(r.incurred_on, "short")} · {r.purpose}</option>
                ))}
              </select>
              <div className="flex gap-2 flex-wrap">
                {!footerHasSave && (
                  <Button size="sm" variant="primary" icon="check" loading={book.isPending} disabled={!reimbId} onClick={submit}>
                    {reimburseLabel}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setOpen("")}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
