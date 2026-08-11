/**
 * ReconcileTransactionDialog — match a bank transaction to an internal record.
 *
 * Opens as a side drawer when the operator clicks "Reconcile" on a row in
 * the bank account detail page. The body has two parts:
 *
 *   1. The transaction header: date, description, amount + reference, so
 *      the operator can confirm at a glance which line they're reconciling.
 *   2. A list of server-suggested matches (payments / expenses near in
 *      amount + date) — one click on "Match" links the two and closes.
 *
 * If none of the suggestions are right, the operator can pick "Mark as
 * reconciled (no internal match)" — used for bank charges, interest
 * income, owner's-own transfers between accounts. Future Phase 2: typeahead
 * search across all payments/expenses for the rare case where amount /
 * date drift more than ±₹100 / ±7 days from any candidate.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useSuggestMatches,
  useReconcileTransaction,
  useReconcileExpensesToBankTxn,
  useBookTxnAsExpense,
  useBookBankCredit,
  useBookBankAdvance,
  useBookBankTxnAsStatutory,
  useBookCreditAsInvoice,
  useReconcileSalaryAdvanceSplit,
  type BankTransactionRow,
  type MatchSuggestion,
} from "@/lib/queries/bank";
import { EXPENSE_CATEGORIES, useUnreconciledExpenses } from "@/lib/queries/expenses";
import { useUnreconciledSalaries } from "@/lib/queries/payroll";
import { useCustomers } from "@/lib/queries/customers";
import { rupee, formatDate } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: BankTransactionRow | null;
}

export function ReconcileTransactionDialog({ open, onOpenChange, transaction }: Props) {
  const router = useRouter();
  const { data: suggestions, isLoading: sugLoading } = useSuggestMatches(transaction?.id ?? null);
  const reconcile = useReconcileTransaction();
  const bookExpense = useBookTxnAsExpense();
  const bookCredit = useBookBankCredit();
  const bookAdvance = useBookBankAdvance();
  const bookStatutory = useBookBankTxnAsStatutory();
  const reconcileExpenses = useReconcileExpensesToBankTxn();
  const { data: candidateExpenses } = useUnreconciledExpenses();
  const { data: payableSalaries } = useUnreconciledSalaries();

  // Multi-expense "split" match (money-out lines): pick several expenses that
  // add up to this one bank line (e.g. several bills, or 2 months' salary —
  // salaries are booked as expenses — paid in one transfer).
  const [pickedExpenses, setPickedExpenses] = React.useState<Set<string>>(new Set());
  const [showSplit, setShowSplit] = React.useState(false);
  const [showSalary, setShowSalary] = React.useState(false);
  React.useEffect(() => { setPickedExpenses(new Set()); setShowSplit(false); setShowSalary(false); }, [transaction?.id]);
  const toggleExpense = (id: string) =>
    setPickedExpenses((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const pickedExpenseTotal = (candidateExpenses ?? [])
    .filter((e) => pickedExpenses.has(e.id))
    .reduce((sum, e) => sum + e.amount, 0);

  const handleExpenseSplit = async () => {
    if (!transaction || pickedExpenses.size === 0) return;
    try {
      await reconcileExpenses.mutateAsync({ transactionId: transaction.id, expenseIds: Array.from(pickedExpenses) });
      onOpenChange(false);
    } catch { /* hook toasts */ }
  };

  // Apply this money-out line to a salary (full or partial). The line's amount
  // is added to the salary's paid_amount by the DB trigger; if it's less than
  // the salary's remaining, the salary goes "partially paid" and the balance
  // stays owed until another line clears it.
  const handleSalaryMatch = async (salaryId: string) => {
    if (!transaction) return;
    try {
      await reconcile.mutateAsync({
        transactionId: transaction.id,
        matchedToType: "salary",
        matchedToId:   salaryId,
        confidence:    "manual",
      });
      onOpenChange(false);
    } catch { /* hook toasts */ }
  };

  // Overpaid a salary: split THIS line into salary (its remaining) + a recoverable
  // advance (the excess), in one atomic RPC. Only offered when the line is bigger
  // than the picked salary's balance.
  const salarySplit = useReconcileSalaryAdvanceSplit();
  const [splitSalaryId, setSplitSalaryId] = React.useState("");
  React.useEffect(() => { setSplitSalaryId(""); }, [transaction?.id]);
  const handleSalarySplit = async () => {
    if (!transaction || !splitSalaryId) return;
    const sal = (payableSalaries ?? []).find((s) => s.id === splitSalaryId);
    if (!sal) return;
    const advance = (transaction.debit ?? 0) - sal.remaining;
    if (advance <= 0) return;
    try {
      await salarySplit.mutateAsync({
        transactionId: transaction.id,
        salaryId: sal.id,
        advanceAmount: advance,
        employeeName: sal.employee_name,
      });
      onOpenChange(false);
    } catch { /* hook toasts */ }
  };

  // "Book as expense" form (money-out lines only).
  const [bookCategory, setBookCategory] = React.useState("");
  const [bookVendor, setBookVendor]     = React.useState("");
  const [bookGst, setBookGst]           = React.useState("");
  React.useEffect(() => {
    setBookCategory(""); setBookVendor(""); setBookGst("");
  }, [transaction?.id]);

  const handleBookExpense = async () => {
    if (!transaction || !bookCategory) return;
    try {
      await bookExpense.mutateAsync({
        transactionId: transaction.id,
        accountId:     transaction.bank_account_id,
        category:      bookCategory,
        vendor:        bookVendor || null,
        gst:           Math.max(0, Math.round(Number(bookGst) || 0)),
        notes:         transaction.description,
      });
      onOpenChange(false);
    } catch { /* hook toasts the error */ }
  };

  // "Book as income / invoice" (credit lines): raise a GST invoice (+ its
  // one-off quote), record its payment, and reconcile this line — one step.
  const bookInvoice = useBookCreditAsInvoice();
  const { data: customers } = useCustomers();
  const [showInvoice, setShowInvoice]   = React.useState(false);
  const [invCustomer, setInvCustomer]   = React.useState("");
  const [invLineName, setInvLineName]   = React.useState("");
  const [invTaxable, setInvTaxable]     = React.useState("");
  React.useEffect(() => {
    setShowInvoice(false); setInvCustomer(""); setInvLineName(""); setInvTaxable("");
  }, [transaction?.id]);

  const handleBookInvoice = async () => {
    if (!transaction || !invCustomer || !(Number(invTaxable) > 0)) return;
    try {
      await bookInvoice.mutateAsync({
        transactionId: transaction.id,
        bankAccountId: transaction.bank_account_id,
        customerId:    invCustomer,
        lineName:      invLineName || transaction.description || "Sale",
        taxableAmount: Math.round(Number(invTaxable)),
        reference:     transaction.reference,
      });
      onOpenChange(false);
    } catch { /* hook toasts */ }
  };

  // "Book this money-in as…" (credit lines): capital / director's loan. Books
  // the Balance-Sheet line AND reconciles this line in one step.
  const [creditKind, setCreditKind] = React.useState<"capital" | "director_loan">("capital");
  const [creditLabel, setCreditLabel] = React.useState("");
  React.useEffect(() => { setCreditKind("capital"); setCreditLabel(""); }, [transaction?.id]);

  const handleBookCredit = async () => {
    if (!transaction) return;
    try {
      await bookCredit.mutateAsync({
        transactionId: transaction.id,
        accountId:     transaction.bank_account_id,
        kind:          creditKind,
        label:         creditLabel.trim() || (creditKind === "capital" ? "Owner's capital" : "Director's loan"),
        notes:         transaction.description,
      });
      onOpenChange(false);
    } catch { /* hook toasts the error */ }
  };

  // "Money given to / returned by a person" (loan/advance) — works for BOTH
  // money-out (given) and money-in (returned). Books a balance-sheet asset,
  // never P&L. Just needs the person's name.
  // "given" = I lent (asset) · "received" = someone lent me (liability).
  const [advanceParty, setAdvanceParty] = React.useState("");
  const [advanceKind, setAdvanceKind] = React.useState<"given" | "received">("given");
  React.useEffect(() => { setAdvanceParty(""); setAdvanceKind("given"); }, [transaction?.id]);
  const handleBookAdvance = async () => {
    if (!transaction || !advanceParty.trim()) return;
    try {
      await bookAdvance.mutateAsync({
        transactionId: transaction.id,
        accountId:     transaction.bank_account_id,
        counterparty:  advanceParty.trim(),
        kind:          advanceKind,
        notes:         transaction.description,
      });
      onOpenChange(false);
    } catch { /* hook toasts the error */ }
  };

  // Statutory (TDS/PF/ESI) challan — money-out. Records a statutory-dues
  // payment against THIS imported line (settles the payable) — no phantom line.
  const [showStatutory, setShowStatutory] = React.useState(false);
  const [statutoryKind, setStatutoryKind] = React.useState<"esi" | "pf" | "tds" | "mixed">("esi");
  React.useEffect(() => { setShowStatutory(false); setStatutoryKind("esi"); }, [transaction?.id]);
  const handleBookStatutory = async () => {
    if (!transaction) return;
    try {
      await bookStatutory.mutateAsync({
        transactionId: transaction.id,
        accountId:     transaction.bank_account_id,
        kind:          statutoryKind,
        notes:         transaction.description,
      });
      onOpenChange(false);
    } catch { /* hook toasts the error */ }
  };

  const handleMatch = async (s: MatchSuggestion) => {
    if (!transaction) return;
    try {
      await reconcile.mutateAsync({
        transactionId: transaction.id,
        matchedToType: s.match_type,
        matchedToId:   s.match_id,
        confidence:    s.match_confidence,
      });
      onOpenChange(false);
    } catch {
      /* hook toasts the error */
    }
  };

  const handleManualReconcile = async () => {
    if (!transaction) return;
    try {
      await reconcile.mutateAsync({
        transactionId: transaction.id,
        matchedToType: "manual",
        matchedToId:   null,
        confidence:    "manual",
      });
      onOpenChange(false);
    } catch {
      /* hook toasts the error */
    }
  };

  // Direction + amount hint
  const isCredit = (transaction?.credit ?? 0) > 0;
  const amount   = isCredit ? transaction?.credit ?? 0 : transaction?.debit ?? 0;
  const dirIcon  = isCredit ? "arrow_left" : "arrow_right";
  const dirLabel = isCredit ? "Money in"   : "Money out";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[520px] md:max-w-[560px] p-0 flex flex-col overflow-x-hidden"
      >
        <SheetHeader>
          <SheetTitle>Reconcile transaction</SheetTitle>
          <SheetDescription>
            Match this bank line to a customer payment, vendor expense, or
            mark it reconciled manually (e.g., bank charges).
          </SheetDescription>
        </SheetHeader>

        {!transaction ? (
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
            <Skeleton className="h-32" />
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
            {/* Transaction summary card */}
            <div className="rounded-md border border-hairline bg-paper-2/40 p-4">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold inline-flex items-center gap-1">
                    <Icon name={dirIcon} size={10} /> {dirLabel}
                  </p>
                  <p className="text-sm text-ink mt-0.5 break-words">
                    {transaction.description}
                  </p>
                  {transaction.reference && (
                    <p className="text-[11px] text-ink-3 font-mono mt-1">
                      Ref: {transaction.reference}
                    </p>
                  )}
                  <p className="text-[11px] text-ink-3 mt-1">
                    {formatDate(transaction.txn_date)}
                  </p>
                </div>
                <p className={`font-serif text-xl tabular-nums whitespace-nowrap ${isCredit ? "text-emerald" : "text-rose"}`}>
                  {isCredit ? "+" : "−"}{rupee(amount)}
                </p>
              </div>
            </div>

            {/* Suggested matches */}
            <div>
              <p className="text-xs font-semibold text-ink-2 mb-2">
                Suggested matches
              </p>

              {sugLoading ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}
                </div>
              ) : !suggestions || suggestions.length === 0 ? (
                <div className="rounded-md border border-dashed border-hairline bg-paper-2/20 px-4 py-6 text-center">
                  <Icon name="info" size={18} className="text-ink-3 mx-auto mb-1" />
                  <p className="text-sm text-ink-2">No close matches found</p>
                  <p className="text-[11px] text-ink-3 mt-1">
                    We looked for {isCredit ? "payments" : "expenses"} within ±₹100 and
                    ±7 days. Use &ldquo;Mark reconciled manually&rdquo; below for bank
                    charges, interest, or owner transfers.
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {suggestions.map((s) => (
                    <li
                      key={`${s.match_type}-${s.match_id}`}
                      className="rounded-md border border-hairline bg-paper hover:border-hairline-strong transition-colors p-3 flex items-center gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <Badge
                            kind={s.match_type === "payment" ? "success" : s.match_type === "project" ? "info" : s.match_type === "salary" ? "warning" : "muted"}
                            size="sm"
                          >
                            {s.match_type === "payment" ? "Payment" : s.match_type === "project" ? "Project" : s.match_type === "salary" ? "Salary" : "Expense"}
                          </Badge>
                          <ConfidencePill confidence={s.match_confidence} />
                        </div>
                        <p className="text-sm font-medium text-ink truncate">
                          {s.match_label}
                        </p>
                        <p className="text-[11px] text-ink-3">
                          {rupee(s.match_amount)} · {formatDate(s.match_date)}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => handleMatch(s)}
                        disabled={reconcile.isPending}
                      >
                        Match
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Income from a sale — credit lines only. Most money-in with no
                match is a customer paying for a sale that wasn't invoiced yet.
                Route to the proper invoice/project builder (amount prefilled);
                once the payment is recorded it shows here as a suggested match
                to reconcile. Kept FIRST — it's the commonest money-in. */}
            {isCredit && (
              <div className="rounded-md border border-amber/50 bg-amber-soft/25 p-3">
                <p className="text-xs font-semibold text-ink-2 mb-1">Kisi sale / customer ka paisa?</p>
                <p className="text-[11px] text-ink-3 mb-3 leading-relaxed">
                  Income aksar invoice se aati hai. Is {rupee(amount)} ki invoice abhi nahi bani? Yahan se invoice (ya project payment) banao — uska payment record karte hi ye line neeche <b>suggested match</b> me aa jayegi, phir ek click me reconcile.
                </p>
                {!showInvoice ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      icon="file"
                      onClick={() => {
                        setShowInvoice(true);
                        setInvLineName(transaction?.description ?? "");
                        setInvTaxable(String(Math.round(amount / 1.18)));
                      }}
                    >
                      Invoice banao
                    </Button>
                    <Button
                      size="sm"
                      variant="default"
                      icon="external"
                      onClick={() => {
                        onOpenChange(false);
                        router.push(`/projects?amount=${Math.round(amount)}&reconcile=${transaction?.id ?? ""}` as never);
                      }}
                    >
                      Project payment
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <select
                      value={invCustomer}
                      onChange={(e) => setInvCustomer(e.target.value)}
                      className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                    >
                      <option value="" disabled>Customer chuno…</option>
                      {(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <Input value={invLineName} onChange={(e) => setInvLineName(e.target.value)} placeholder="Kya becha? (e.g. Website / Setup fee)" />
                    <Input value={invTaxable} onChange={(e) => setInvTaxable(e.target.value)} type="number" min={0} placeholder="Taxable amount ₹ (ex-GST)" />
                    <p className="text-[10px] text-ink-3">GST customer ke place-of-supply se apne-aap lagega. {rupee(amount)} received ka taxable (÷1.18) prefill kiya — theek kar lena.</p>
                    <div className="flex gap-2 pt-1">
                      <Button
                        size="sm"
                        variant="primary"
                        icon="check"
                        loading={bookInvoice.isPending}
                        disabled={!invCustomer || !(Number(invTaxable) > 0)}
                        onClick={handleBookInvoice}
                      >
                        Invoice banao &amp; reconcile
                      </Button>
                      <Button size="sm" variant="default" onClick={() => setShowInvoice(false)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Book money-IN as capital / a director's loan — credit lines only.
                Adds the Balance-Sheet line AND reconciles, in one step. */}
            {isCredit && (
              <div className="rounded-md border border-emerald/40 bg-emerald/5 p-3">
                <p className="text-xs font-semibold text-ink-2 mb-1">Money put into the business?</p>
                <p className="text-[11px] text-ink-3 mb-3 leading-relaxed">
                  Account opening / promoter funds — this {rupee(amount)} is <b>not income</b>. Book it correctly and reconcile in one step.
                </p>
                <div className="space-y-2">
                  <div className="grid grid-cols-1 gap-1.5">
                    <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer ${creditKind === "capital" ? "border-emerald bg-emerald/10" : "border-hairline"}`}>
                      <input type="radio" name="creditKind" checked={creditKind === "capital"} onChange={() => setCreditKind("capital")} className="mt-1" />
                      <span>
                        <span className="block text-sm text-ink">Owner&apos;s capital <span className="text-ink-3">(equity)</span></span>
                        <span className="block text-[11px] text-ink-3">Poonji — business me daali, wapas nahi leni.</span>
                      </span>
                    </label>
                    <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer ${creditKind === "director_loan" ? "border-emerald bg-emerald/10" : "border-hairline"}`}>
                      <input type="radio" name="creditKind" checked={creditKind === "director_loan"} onChange={() => setCreditKind("director_loan")} className="mt-1" />
                      <span>
                        <span className="block text-sm text-ink">Director&apos;s loan <span className="text-ink-3">(liability)</span></span>
                        <span className="block text-[11px] text-ink-3">Temporary daala — company wapas degi.</span>
                      </span>
                    </label>
                  </div>
                  <Input
                    value={creditLabel}
                    onChange={(e) => setCreditLabel(e.target.value)}
                    placeholder={creditKind === "capital" ? "Label (default: Owner's capital)" : "Label (default: Director's loan)"}
                  />
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  icon="check"
                  className="mt-3"
                  loading={bookCredit.isPending}
                  onClick={handleBookCredit}
                >
                  Book {rupee(amount)} as {creditKind === "capital" ? "capital" : "director's loan"}
                </Button>
              </div>
            )}

            {/* Loan / advance between you and a person — BOTH sides. Not income,
                not expense: books a balance-sheet ASSET (you lent) or LIABILITY
                (you borrowed) so the P&L is untouched; the pair nets to zero once
                settled. Two choices cover all four cases. */}
            <div className="rounded-md border border-indigo/40 bg-indigo-soft/25 p-3">
              <p className="text-xs font-semibold text-ink-2 mb-1">Loan / advance with a person?</p>
              <p className="text-[11px] text-ink-3 mb-2.5 leading-relaxed">
                This {rupee(amount)} is <b>not income or expense</b> — it&apos;s a loan/advance. Pick who lent, so it books correctly (P&amp;L stays clean).
              </p>
              <div className="grid grid-cols-1 gap-1.5 mb-2.5">
                <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer ${advanceKind === "given" ? "border-indigo bg-indigo/10" : "border-hairline"}`}>
                  <input type="radio" name="advanceKind" checked={advanceKind === "given"} onChange={() => setAdvanceKind("given")} className="mt-1" />
                  <span>
                    <span className="block text-sm text-ink">
                      {isCredit ? "A loan/advance I GAVE has come back" : "I am GIVING a loan/advance"}
                    </span>
                    <span className="block text-[11px] text-ink-3">Maine diya — paisa mera, wapas aana hai (asset).</span>
                  </span>
                </label>
                <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer ${advanceKind === "received" ? "border-indigo bg-indigo/10" : "border-hairline"}`}>
                  <input type="radio" name="advanceKind" checked={advanceKind === "received"} onChange={() => setAdvanceKind("received")} className="mt-1" />
                  <span>
                    <span className="block text-sm text-ink">
                      {isCredit ? "Someone GAVE me a loan" : "I am REPAYING a loan someone gave me"}
                    </span>
                    <span className="block text-[11px] text-ink-3">Mujhe mila — paisa unka, wapas dena hai (liability).</span>
                  </span>
                </label>
              </div>
              <Input
                value={advanceParty}
                onChange={(e) => setAdvanceParty(e.target.value)}
                placeholder="Person's name (e.g. Julie Rawat)"
              />
              <Button
                size="sm"
                variant="primary"
                icon="check"
                className="mt-3"
                disabled={!advanceParty.trim()}
                loading={bookAdvance.isPending}
                onClick={handleBookAdvance}
              >
                Book {rupee(amount)} as{" "}
                {advanceKind === "given"
                  ? (isCredit ? "an advance returned to you (asset)" : "a loan/advance you gave (asset)")
                  : (isCredit ? "a loan received (liability)" : "a loan you repaid (liability)")}
              </Button>
            </div>

            {/* Overpaid a salary — split THIS line into salary + recoverable
                advance (one atomic RPC). Only when the line exceeds a salary's due. */}
            {!isCredit && (payableSalaries ?? []).some((s) => s.remaining > 0 && s.remaining < amount) && (
              <div className="rounded-md border border-indigo/40 bg-indigo-soft/20 p-3">
                <p className="text-xs font-semibold text-ink-2 mb-1">Overpaid a salary? (salary + advance)</p>
                <p className="text-[11px] text-ink-3 mb-2.5 leading-relaxed">
                  Paid more than the salary by mistake? Pick the salary — its balance is settled and the EXTRA is booked as a recoverable <b>advance</b> (recover it later via a salary deduction). No double cash-out — this line is the payment.
                </p>
                <select
                  value={splitSalaryId}
                  onChange={(e) => setSplitSalaryId(e.target.value)}
                  className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo/40 mb-2"
                >
                  <option value="">Choose the salary…</option>
                  {(payableSalaries ?? []).filter((s) => s.remaining > 0 && s.remaining < amount).map((s) => (
                    <option key={s.id} value={s.id}>{s.employee_name} · {s.period} · {rupee(s.remaining)} due</option>
                  ))}
                </select>
                {(() => {
                  const sal = (payableSalaries ?? []).find((s) => s.id === splitSalaryId);
                  if (!sal) return null;
                  const advance = amount - sal.remaining;
                  return (
                    <>
                      <p className="text-[11px] text-ink-2 mb-2">
                        <span className="text-emerald font-medium">{rupee(sal.remaining)}</span> → salary (paid)
                        {" · "}
                        <span className="text-amber-ink font-medium">{rupee(advance)}</span> → advance (recoverable)
                      </p>
                      <Button size="sm" variant="primary" icon="check" loading={salarySplit.isPending} onClick={handleSalarySplit}>
                        Pay salary + book {rupee(advance)} advance
                      </Button>
                    </>
                  );
                })()}
              </div>
            )}

            {/* Book directly as an expense — money-out lines only. Creates the
                expense (P&L) and reconciles this line, with NO extra cash leg. */}
            {!isCredit && (
              <div className="rounded-md border border-amber/40 bg-amber-soft/25 p-3">
                <p className="text-xs font-semibold text-ink-2 mb-1">Book as a new expense</p>
                <p className="text-[11px] text-ink-3 mb-3 leading-relaxed">
                  Not in your books yet? Record this {rupee(amount)} as an expense and reconcile it in one step. No double entry — this bank line is the cash-out.
                </p>
                <div className="space-y-2">
                  <select
                    value={bookCategory}
                    onChange={(e) => setBookCategory(e.target.value)}
                    className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                  >
                    <option value="" disabled>Choose category…</option>
                    {/* Salaries are NOT a plain expense — they're booked in Payroll
                        (payslip + statutory + paid-status), so they're excluded here. */}
                    {EXPENSE_CATEGORIES.filter((c) => c !== "Salaries").map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <div className="grid grid-cols-2 gap-2">
                    <Input value={bookVendor} onChange={(e) => setBookVendor(e.target.value)} placeholder="Vendor / payee (optional)" />
                    <Input value={bookGst} onChange={(e) => setBookGst(e.target.value)} type="number" min={0} placeholder="GST paid ₹ (optional)" />
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  icon="check"
                  className="mt-3"
                  disabled={!bookCategory || bookExpense.isPending}
                  loading={bookExpense.isPending}
                  onClick={handleBookExpense}
                >
                  Book {rupee(amount)} expense
                </Button>
                <p className="mt-2.5 text-[11px] text-ink-3 leading-relaxed">
                  Paying a salary?{" "}
                  <button
                    type="button"
                    onClick={() => { onOpenChange(false); router.push("/accounting/payroll" as never); }}
                    className="text-amber-ink font-medium underline hover:no-underline"
                  >
                    Open Payroll &amp; Leave →
                  </button>{" "}
                  run it there (payslip + statutory), then reconcile this line to it under “Combine multiple expenses”.
                </p>
              </div>
            )}

            {/* Statutory challan (TDS/PF/ESI) — money-out. Settles the statutory
                payable against THIS imported line; no duplicate line is made. */}
            {!isCredit && (
              <div className="rounded-md border border-hairline p-3">
                <button
                  type="button"
                  onClick={() => setShowStatutory((v) => !v)}
                  className="w-full flex items-center justify-between text-left"
                >
                  <span className="text-xs font-semibold text-ink-2">Statutory payment (ESI / PF / TDS challan)?</span>
                  <Icon name={showStatutory ? "chevron_up" : "chevron_down"} size={14} className="text-ink-3" />
                </button>
                {showStatutory && (
                  <div className="mt-2 space-y-2">
                    <p className="text-[11px] text-ink-3">
                      Records this {rupee(amount)} as a statutory payment to the government and clears it from your “dues payable”. Pick which challan this is:
                    </p>
                    <div className="grid grid-cols-4 gap-1.5">
                      {(["esi", "pf", "tds", "mixed"] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setStatutoryKind(k)}
                          className={`rounded-md border px-2 py-1.5 text-xs font-medium uppercase ${statutoryKind === k ? "border-indigo bg-indigo/10 text-indigo" : "border-hairline text-ink-2"}`}
                        >
                          {k}
                        </button>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      variant="primary"
                      icon="check"
                      disabled={bookStatutory.isPending}
                      loading={bookStatutory.isPending}
                      onClick={handleBookStatutory}
                    >
                      Book {rupee(amount)} as {statutoryKind.toUpperCase()} paid
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Pay (part of) a salary — money-out lines. Applies THIS line's
                amount to a chosen salary. If it's less than the full salary,
                the salary goes "partially paid" and the rest stays owed. */}
            {!isCredit && (payableSalaries ?? []).length > 0 && (
              <div className="rounded-md border border-hairline p-3">
                <button
                  type="button"
                  onClick={() => setShowSalary((v) => !v)}
                  className="w-full flex items-center justify-between text-left"
                >
                  <span className="text-xs font-semibold text-ink-2">Pay a salary (full or part)</span>
                  <Icon name={showSalary ? "chevron_up" : "chevron_down"} size={14} className="text-ink-3" />
                </button>
                {!showSalary ? (
                  <p className="text-[11px] text-ink-3 mt-1 leading-relaxed">
                    Paid a salary from this {rupee(amount)}? Pick it — if it&apos;s less than the full salary, the rest stays owed as a balance.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1 max-h-56 overflow-y-auto pr-1">
                    {(payableSalaries ?? []).map((s) => {
                      const fits = s.remaining >= amount; // guard against over-paying a salary
                      const full = s.remaining === amount;
                      return (
                        <li key={s.id}>
                          <div className="flex items-center gap-2 rounded-md border border-hairline px-2.5 py-1.5">
                            <span className="flex-1 min-w-0">
                              <span className="block text-sm text-ink truncate">
                                {s.employee_name} · {s.period}
                              </span>
                              <span className="block text-[10px] text-ink-3">
                                {s.paid_status === "partial"
                                  ? `Paid ${rupee(s.paid_amount)} / ${rupee(s.net)} · ${rupee(s.remaining)} left`
                                  : `Salary ${rupee(s.net)}`}
                              </span>
                            </span>
                            <Button
                              size="sm"
                              variant={fits ? "primary" : "ghost"}
                              disabled={!fits || reconcile.isPending}
                              title={fits ? undefined : `This line (${rupee(amount)}) is more than the ${rupee(s.remaining)} left on this salary`}
                              onClick={() => handleSalaryMatch(s.id)}
                            >
                              {full ? "Pay in full" : `Apply ${rupee(amount)}`}
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {/* Combine several expenses into one bank line (money-out only).
                e.g. multiple bills, or 2 months' salary, paid in one transfer. */}
            {!isCredit && (candidateExpenses ?? []).length > 0 && (
              <div className="rounded-md border border-hairline p-3">
                <button
                  type="button"
                  onClick={() => setShowSplit((v) => !v)}
                  className="w-full flex items-center justify-between text-left"
                >
                  <span className="text-xs font-semibold text-ink-2">Combine multiple expenses</span>
                  <Icon name={showSplit ? "chevron_up" : "chevron_down"} size={14} className="text-ink-3" />
                </button>
                {!showSplit && (
                  <p className="text-[11px] text-ink-3 mt-1 leading-relaxed">
                    Paid several bills — or 2 months&apos; salary — in one transfer? Tick the expenses that add up to {rupee(amount)}.
                  </p>
                )}
                {showSplit && (
                  <div className="mt-2 space-y-2">
                    <ul className="max-h-52 overflow-y-auto space-y-1 pr-1">
                      {(candidateExpenses ?? []).map((e) => (
                        <li key={e.id}>
                          <label className="flex items-center gap-2 rounded-md border border-hairline px-2.5 py-1.5 cursor-pointer hover:border-hairline-strong">
                            <input
                              type="checkbox"
                              checked={pickedExpenses.has(e.id)}
                              onChange={() => toggleExpense(e.id)}
                              className="rounded border-hairline"
                            />
                            <span className="flex-1 min-w-0">
                              <span className="block text-sm text-ink truncate">
                                {e.category}{e.vendor_name ? ` · ${e.vendor_name}` : ""}
                              </span>
                              <span className="block text-[10px] text-ink-3 truncate">
                                {formatDate(e.expense_date)}{e.description ? ` · ${e.description}` : ""}
                              </span>
                            </span>
                            <span className="font-mono text-sm text-ink shrink-0">{rupee(e.amount)}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                    <div className={`flex items-center justify-between text-[12px] font-medium ${pickedExpenseTotal === amount ? "text-emerald" : "text-ink-3"}`}>
                      <span>{pickedExpenses.size} selected</span>
                      <span className="font-mono">
                        {rupee(pickedExpenseTotal)} / {rupee(amount)}{pickedExpenseTotal === amount ? " ✓" : ""}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="primary"
                      icon="check"
                      disabled={pickedExpenses.size === 0 || pickedExpenseTotal !== amount || reconcileExpenses.isPending}
                      loading={reconcileExpenses.isPending}
                      onClick={handleExpenseSplit}
                    >
                      Reconcile {pickedExpenses.size || ""} expense{pickedExpenses.size === 1 ? "" : "s"}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Manual reconcile escape hatch */}
            <div className="rounded-md border border-hairline bg-paper-2/30 p-3">
              <p className="text-xs font-semibold text-ink-2 mb-1">
                None of these match? / Failed or reversed?
              </p>
              <p className="text-[11px] text-ink-3 mb-3 leading-relaxed">
                Mark this reconciled without any income/expense entry. Use it for
                bank charges, interest, own-account transfers — and for a{" "}
                <b>failed / reversed transaction</b> (e.g. ATM didn&apos;t dispense
                but was debited, then reversed): mark <b>both</b> the −₹ and the +₹
                line this way. They cancel out, so nothing needs to be booked.
              </p>
              <Button
                size="sm"
                variant="default"
                icon="check_circle"
                onClick={handleManualReconcile}
                disabled={reconcile.isPending}
              >
                Mark reconciled manually
              </Button>
            </div>
          </div>
        )}

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ============================================================
// Helpers
// ============================================================
function ConfidencePill({ confidence }: { confidence: MatchSuggestion["match_confidence"] }) {
  if (confidence === "exact") {
    return <Badge kind="success" size="sm" dot>Exact</Badge>;
  }
  if (confidence === "high") {
    return <Badge kind="warning" size="sm" dot>High</Badge>;
  }
  return <Badge kind="muted" size="sm" dot>Low</Badge>;
}
