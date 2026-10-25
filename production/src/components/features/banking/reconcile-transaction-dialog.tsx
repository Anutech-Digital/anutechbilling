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
import { toast } from "sonner";

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
  useBookBankTxnAsCommission,
  useReconcileSalaryAdvanceSplit,
  type BankTransactionRow,
  type MatchSuggestion,
} from "@/lib/queries/bank";
import { EXPENSE_CATEGORIES, useUnreconciledExpenses, suggestCategory } from "@/lib/queries/expenses";
import { useTxnCategoryRules } from "@/lib/queries/txn-category-rules";
import { suggestForLine, categoriseByRules } from "@/lib/banking/categorise";
import { useUnreconciledSalaries, useEmployees } from "@/lib/queries/payroll";
import { useCustomers } from "@/lib/queries/customers";
import { rupee, formatDate } from "@/lib/utils";
import { useBookBankTxnAsTax } from "@/lib/queries/tax-payments";
import { fyLabel, fyStartYearOf } from "@/lib/accounting/tax-payments";
import { previousPeriod, titleCaseName, parseSalaryNarration, matchEmployee } from "@/lib/banking/salary-lines";
import { useBookSalaryLines } from "@/lib/queries/salary-from-bank";
import { detectGovtPayment } from "@/lib/banking/govt-payment";
import { payeeFromNarration, TEST_TRANSFER_MAX } from "@/lib/banking/narration";
import { usePrepaidAdvances } from "@/lib/queries/prepaid-advances";
import { useReferralCommissions } from "@/lib/queries/referral-commissions";
import { AddCustomerForm } from "@/components/features/customers/add-customer-form";
import { ProjectPaymentSection } from "@/components/features/banking/project-payment-section";
import { CreditPayForSection } from "@/components/features/banking/credit-pay-for-section";
import { DebitPayForSection } from "@/components/features/banking/debit-pay-for-section";
import { EmiRepaymentSection } from "@/components/features/banking/emi-repayment-section";
import { OwnerEquitySection } from "@/components/features/banking/owner-equity-section";
import { IncentiveFromBankSection } from "@/components/features/banking/incentive-from-bank-section";
import { EmployeeAdvanceBankSection } from "@/components/features/banking/employee-advance-bank-section";
import { useComplianceProfile } from "@/lib/compliance/profile";
import { ownerEquityWords } from "@/lib/accounting/owner-equity";
import { expenseGuard, sameVendor, type VendorFocus } from "@/lib/banking/vendor-line-guard";

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

  /* What this line probably IS, from the same layers the import uses: the category
     saved on the line at import, else the tenant's Category Rules, else the built-in
     keywords. Only an expense category counts — Salaries belong to Payroll. It PREFILLS
     the expense form and moves it to the top; nothing is booked until the click. */
  const { data: categoryRules } = useTxnCategoryRules();
  const expenseSuggestion = React.useMemo((): { category: string; reason: string } | null => {
    if (!transaction || transaction.debit <= 0) return null;
    const isExpenseCat = (c: string | null | undefined): c is string =>
      !!c && c !== "Salaries" && (EXPENSE_CATEGORIES as readonly string[]).includes(c);
    /* "SALARY TO DIRECTOR": booked as an expense, this is Director's Remuneration —
       never plain Salaries (which belongs to Payroll) and never a guessed category. */
    if (/\bDIRECTORS?\b/i.test(transaction.description ?? "")) {
      return { category: "Director's Remuneration", reason: "the word \"director\" in the narration" };
    }
    if (isExpenseCat(transaction.category)) return { category: transaction.category, reason: "set when the statement was imported" };
    const s = suggestForLine(transaction, categoryRules ?? [], suggestCategory);
    if (s && isExpenseCat(s.category)) return { category: s.category, reason: s.reason };
    /* Last layer: a ₹1–₹10 debit with nothing else to say about it is a test /
       account-verification ("penny drop") transfer. Real money left the bank, so it is
       booked — as a bank charge — rather than waved through as "reconciled". */
    if (transaction.debit <= TEST_TRANSFER_MAX) {
      return { category: "Bank Charges", reason: `a ₹${transaction.debit} debit — usually a test / account-verification transfer` };
    }
    return null;
  }, [transaction, categoryRules]);

  React.useEffect(() => {
    setBookCategory(expenseSuggestion?.category ?? ""); setBookGst("");
  }, [transaction?.id, expenseSuggestion?.category]);

  /* Names already used for vendor advances — so a rule's "FACEBK" reads as the existing "Facebook". */
  const { data: prepaidAdvances } = usePrepaidAdvances();
  const prepaidVendorNames = React.useMemo(
    () => [...new Set((prepaidAdvances ?? []).map((a) => a.vendor_name.trim()))].sort(),
    [prepaidAdvances],
  );

  /* Who was paid, for BOTH the expense and the advance forms: the Category Rule that
     matches this line names them ("FACEBOOK" → "Facebook"). Looked up directly — not
     parsed from the category's reason, which says "set at import" when the category
     came from the statement. A name already used for advances wins ("FACEBK" →
     the existing "Facebook"), so one vendor's top-ups stay one vendor. */
  const suggestedVendor = React.useMemo(() => {
    if (!transaction || transaction.debit <= 0) return "";
    const pattern = categoriseByRules(transaction, categoryRules ?? [])?.rule.pattern.trim() ?? "";
    /* No rule: the payee slot of an IMPS / NEFT / UPI narration, else blank. */
    if (!pattern) return payeeFromNarration(transaction.description) ?? "";
    const key = pattern.toUpperCase().slice(0, 5);
    return prepaidVendorNames.find((v) => v.toUpperCase().startsWith(key)) ?? titleCaseName(pattern);
  }, [transaction, categoryRules, prepaidVendorNames]);

  /* R-1917 (R-1906 audit B8): the vendor the "Paying a vendor?" section is on (guessed from the
     narration or picked) and its open items. With a vendor, that section is the ONE way: it is the
     only block open and its Record payment the only primary button; every other choice sits behind
     "Not a vendor payment?". "Book as expense" for the same vendor is refused when one of its open
     items equals this line (book_bank_txn_as_expense refuses it too). */
  const [vendorFocus, setVendorFocus] = React.useState<VendorFocus | null>(null);
  const [showOther, setShowOther] = React.useState(false);
  React.useEffect(() => { setVendorFocus(null); setShowOther(false); }, [transaction?.id]);
  /* The expense form's payee: the vendor the line is paid to, else the Category Rule / narration payee. */
  React.useEffect(() => {
    setBookVendor(vendorFocus?.vendorName || suggestedVendor);
  }, [transaction?.id, suggestedVendor, vendorFocus?.vendorName]);
  const expenseCheck = expenseGuard(vendorFocus, bookVendor, transaction?.debit ?? 0);
  const otherWaysRef = React.useRef<HTMLButtonElement>(null);
  const backToVendor = () => {
    setShowOther(false);
    otherWaysRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  };

  /* R-1866: paying a vendor (open bills, a new bill, an advance) is DebitPayForSection. R-1911: a
     payment ALREADY recorded on the Bills / Expenses page is matched there too (listed first and
     pre-ticked) — the separate "Already recorded this bill payment?" block is retired (one way).
     What stays here: referral commissions. */
  const bookCommission = useBookBankTxnAsCommission();
  const { data: allCommissions } = useReferralCommissions();
  const [showCommission, setShowCommission] = React.useState(false);
  const [commissionPick, setCommissionPick] = React.useState("");
  React.useEffect(() => { setShowCommission(false); setCommissionPick(""); }, [transaction?.id]);
  const commissionCandidates = React.useMemo(() => {
    const amt = transaction?.debit ?? 0;
    return (allCommissions ?? [])
      .filter((c) => c.status !== "cancelled" && (c.status === "earned" || c.net_payable === amt))
      .sort((a, b) => Math.abs(a.net_payable - amt) - Math.abs(b.net_payable - amt) || b.earned_date.localeCompare(a.earned_date))
      .slice(0, 40);
  }, [allCommissions, transaction?.debit]);
  const handleBookCommission = async () => {
    if (!transaction || !commissionPick) return;
    try {
      await bookCommission.mutateAsync({ transactionId: transaction.id, accountId: transaction.bank_account_id, commissionId: commissionPick });
      onOpenChange(false);
    } catch { /* hook toasts */ }
  };

  const handleBookExpense = async () => {
    if (!transaction || !bookCategory || expenseCheck?.blocked) return;
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

  /* R-1838: money from a customer — "This money is for:" (CreditPayForSection) picks the
     customer and WHAT it pays (renewal / add-seats / new-product quote, unpaid invoice, or a new
     sale with seats × unit price) and books it through record_payment in one transaction. It
     replaces the old "Create invoice" form, which booked every receipt as a one-off sale. */
  const { data: customers } = useCustomers();
  /* New customer from here opens the SAME side-sheet form the quote builder uses
     (components/features/customers — Billing's form, used as-is, not copied), and
     picks the customer it creates. */
  const [newCustomerOpen, setNewCustomerOpen] = React.useState(false);
  const [createdCustomer, setCreatedCustomer] = React.useState<string | null>(null);
  const [payForDone, setPayForDone] = React.useState(false);
  /* "Project payment" — which project (existing or new) this money is for; booked here
     instead of sending the operator off to the projects page. */
  const [showProject, setShowProject]   = React.useState(false);
  const [projCustomer, setProjCustomer] = React.useState("");
  React.useEffect(() => {
    setShowProject(false); setProjCustomer(""); setCreatedCustomer(null); setPayForDone(false);
  }, [transaction?.id]);

  // "Book this money-in as…" (credit lines): capital / director's loan. Books
  // the Balance-Sheet line AND reconciles this line in one step.
  const [creditKind, setCreditKind] = React.useState<"capital" | "director_loan">("capital");
  const [creditLabel, setCreditLabel] = React.useState("");
  React.useEffect(() => { setCreditKind("capital"); setCreditLabel(""); }, [transaction?.id]);

  /* R-1839: company type decides the owner's words; a firm's box here is only a partner's loan
     (capital goes in as a dated "Capital introduced" entry, OwnerEquitySection). */
  const profileQ = useComplianceProfile();
  const ownerWords = ownerEquityWords(profileQ.data?.businessType ?? null);
  const handleBookCredit = async () => {
    if (!transaction) return;
    const kind = ownerWords.allowed ? "director_loan" : creditKind;
    try {
      await bookCredit.mutateAsync({
        transactionId: transaction.id,
        accountId:     transaction.bank_account_id,
        kind,
        label:         creditLabel.trim() || (ownerWords.allowed ? "Loan from partner" : kind === "capital" ? "Owner's capital" : "Director's loan"),
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
  // GST and income tax go to tax_payments instead (migration 20260925140000), so
  // they never mix into the TDS/PF/ESI "dues payable" total.
  const [showStatutory, setShowStatutory] = React.useState(false);
  const [statutoryKind, setStatutoryKind] = React.useState<"esi" | "pf" | "tds" | "mixed" | "gst" | "income_tax">("esi");
  const bookTax = useBookBankTxnAsTax();
  const [gstPeriod, setGstPeriod] = React.useState("");
  const [duesPeriod, setDuesPeriod] = React.useState("");
  const [challanNo, setChallanNo] = React.useState("");
  const [taxInterest, setTaxInterest] = React.useState("");
  const [taxLateFee, setTaxLateFee] = React.useState("");
  const [itKind, setItKind] = React.useState<"advance_tax" | "self_assessment_tax">("advance_tax");
  const [itFy, setItFy] = React.useState("");
  const txnFyStart = transaction ? fyStartYearOf(transaction.txn_date) : 0;
  /* A money-out line whose narration names a government payment (ESIC, EPFO, TDS, GST,
     income tax): the statutory section opens first, with that kind already picked. */
  /* A salary transfer: employee + month read from the narration (lib/banking/salary-lines),
     booked through the same Payroll path as Banking → Salary lines. */
  const salaryHint = React.useMemo(
    () => (transaction && transaction.debit > 0 ? parseSalaryNarration(transaction.description ?? "", transaction.txn_date) : null),
    [transaction],
  );
  const { data: employees } = useEmployees();
  const bookSalary = useBookSalaryLines();
  const [salaryEmp, setSalaryEmp] = React.useState("");
  const [salaryPeriod, setSalaryPeriod] = React.useState("");
  React.useEffect(() => {
    if (!salaryHint) { setSalaryEmp(""); setSalaryPeriod(""); return; }
    const m = matchEmployee(salaryHint.name, employees ?? []);
    setSalaryEmp(m.kind === "match" ? m.id : m.kind === "none" && salaryHint.name ? "create" : "");
    setSalaryPeriod(salaryHint.period);
  }, [transaction?.id, salaryHint, employees]);
  const handleBookSalary = async () => {
    if (!transaction || !salaryHint || !salaryEmp || !salaryPeriod) return;
    try {
      const [r] = await bookSalary.mutateAsync({
        accountId: transaction.bank_account_id,
        groups: [{
          employee: salaryEmp === "create"
            ? { createName: titleCaseName(salaryHint.name ?? ""), monthlyGross: transaction.debit }
            : { id: salaryEmp },
          period: salaryPeriod,
          lines: [{ txnId: transaction.id, txnDate: transaction.txn_date, amount: transaction.debit, description: transaction.description ?? "" }],
        }],
      });
      /* The hook's toast gives the count; a refusal (e.g. month already paid) carries
         its own sentence — show it and keep the sheet open. */
      if (r && !r.ok) { toast.error(r.message); return; }
      onOpenChange(false);
    } catch { /* hook toasts */ }
  };

  const govtHint = React.useMemo(
    () => (transaction && transaction.debit > 0 ? detectGovtPayment(transaction.description) : null),
    [transaction],
  );
  React.useEffect(() => {
    setShowStatutory(govtHint !== null); setStatutoryKind(govtHint?.kind ?? "esi");
    /* GST is normally paid by the 20th for the month before; advance tax is paid
       during the year it is for. Both are only defaults — the operator can change them. */
    setGstPeriod(transaction ? previousPeriod(transaction.txn_date) : "");
    setTaxInterest(""); setTaxLateFee("");
    setItKind("advance_tax");
    setItFy(transaction ? fyLabel(fyStartYearOf(transaction.txn_date)) : "");
  }, [transaction?.id, transaction, govtHint]);
  /* Self-assessment tax is paid AFTER the year closes, for the year before. */
  const pickItKind = (k: "advance_tax" | "self_assessment_tax") => {
    setItKind(k);
    setItFy(fyLabel(k === "advance_tax" ? txnFyStart : txnFyStart - 1));
  };
  const interestNum = Math.max(0, Math.round(Number(taxInterest) || 0));
  const lateFeeNum  = Math.max(0, Math.round(Number(taxLateFee) || 0));
  const taxPortion  = (transaction?.debit ?? 0) - interestNum - lateFeeNum;
  const handleBookStatutory = async () => {
    if (!transaction) return;
    try {
      if (statutoryKind === "gst" || statutoryKind === "income_tax") {
        await bookTax.mutateAsync({
          transactionId: transaction.id,
          accountId:     transaction.bank_account_id,
          kind:          statutoryKind === "gst" ? "gst" : itKind,
          period:        gstPeriod,
          fy:            itFy,
          interest:      interestNum,
          lateFee:       lateFeeNum,
          notes:         transaction.description,
        });
      } else {
        await bookStatutory.mutateAsync({
          transactionId: transaction.id,
          accountId:     transaction.bank_account_id,
          kind:          statutoryKind,
          notes:         transaction.description,
          challanNo:     challanNo.trim() || null,
          period:        duesPeriod || null,
        });
      }
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
  /* R-1917: a money-out line with a known vendor — the vendor section is the one way. */
  const vendorLine = !isCredit && !govtHint && vendorFocus !== null && !payForDone;
  /* "Combine multiple expenses": the vendor's own unpaid bills are paid in its section above (with
     TDS) — not offered a second time here. */
  const combineCandidates = (candidateExpenses ?? []).filter((e) =>
    !vendorLine || !vendorFocus
      || !((vendorFocus.vendorId && e.vendor_id === vendorFocus.vendorId) || sameVendor(e.vendor_name ?? "", vendorFocus.vendorName)));


  /* The statutory / tax section, defined once and placed either first (a detected
     government payment) or in its usual spot. */
  const statutorySection = (
    <>
    {/* Statutory challan (TDS/PF/ESI) — money-out. Settles the statutory
        payable against THIS imported line; no duplicate line is made. */}
    {!isCredit && (
      <div className="rounded-md border border-hairline p-3">
        <button
          type="button"
          onClick={() => setShowStatutory((v) => !v)}
          className="w-full flex items-center justify-between text-left"
        >
          <span className="text-xs font-semibold text-ink-2">Statutory / tax payment (ESI / PF / TDS / GST / Income tax)?</span>
          <Icon name={showStatutory ? "chevron_up" : "chevron_down"} size={14} className="text-ink-3" />
        </button>
        {showStatutory && (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-ink-3">
              Records this {rupee(amount)} as a payment to the government. Pick what it is:
            </p>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
              {([
                ["esi", "ESI"], ["pf", "PF"], ["tds", "TDS"], ["mixed", "Mixed"],
                ["gst", "GST"], ["income_tax", "Income tax"],
              ] as const).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={statutoryKind === k}
                  onClick={() => setStatutoryKind(k)}
                  className={`rounded-md border px-2 py-1.5 text-xs font-medium ${statutoryKind === k ? "border-indigo bg-indigo/10 text-indigo" : "border-hairline text-ink-2"}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* What each choice does to the books — said before the click. */}
            {statutoryKind === "gst" ? (
              <div className="space-y-2">
                <p className="text-xs text-ink-3">
                  Reduces GST payable for the return month. Interest and late fee paid with it are booked as a
                  <b> Rates &amp; Taxes</b> expense — they are a cost, the tax is not.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <label className="text-xs text-ink-3 space-y-0.5">
                    <span className="block">Return month</span>
                    <Input type="month" value={gstPeriod} onChange={(e) => setGstPeriod(e.target.value)} aria-label="GST return month" />
                  </label>
                  <label className="text-xs text-ink-3 space-y-0.5">
                    <span className="block">Interest ₹ (if any)</span>
                    <Input type="number" min={0} value={taxInterest} onChange={(e) => setTaxInterest(e.target.value)} placeholder="0" aria-label="Interest" />
                  </label>
                  <label className="text-xs text-ink-3 space-y-0.5">
                    <span className="block">Late fee ₹ (if any)</span>
                    <Input type="number" min={0} value={taxLateFee} onChange={(e) => setTaxLateFee(e.target.value)} placeholder="0" aria-label="Late fee" />
                  </label>
                </div>
                <p className={`text-xs tabular-nums ${taxPortion > 0 ? "text-ink-2" : "text-rose-ink"}`}>
                  {taxPortion > 0
                    ? <>GST (tax) <b>{rupee(taxPortion)}</b>{interestNum + lateFeeNum > 0 && <> · expense <b>{rupee(interestNum + lateFeeNum)}</b></>}</>
                    : "Interest + late fee cannot be the whole amount — there must be some tax in it."}
                </p>
              </div>
            ) : statutoryKind === "income_tax" ? (
              <div className="space-y-2">
                <p className="text-xs text-ink-3">
                  Shows as <b>Advance tax paid</b> on the balance sheet for that year, and counts in the ITR pack. Not an expense.
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex gap-1.5" role="group" aria-label="Income tax type">
                    {([["advance_tax", "Advance tax"], ["self_assessment_tax", "Self-assessment"]] as const).map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        aria-pressed={itKind === k}
                        onClick={() => pickItKind(k)}
                        className={`rounded-md border px-2 py-1 text-xs font-medium ${itKind === k ? "border-indigo bg-indigo/10 text-indigo" : "border-hairline text-ink-2"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label className="text-xs text-ink-3 space-y-0.5">
                    <span className="block">For financial year</span>
                    <select
                      value={itFy}
                      onChange={(e) => setItFy(e.target.value)}
                      aria-label="Financial year"
                      className="rounded-md border border-hairline bg-paper px-2 py-1.5 text-xs text-ink"
                    >
                      {[txnFyStart - 1, txnFyStart, txnFyStart + 1].map((y) => (
                        <option key={y} value={fyLabel(y)}>FY {fyLabel(y)}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-ink-3">Clears it from your TDS / PF / ESI “dues payable”. Enter the month and challan number — they are quoted in 26Q / ECR.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input type="month" value={duesPeriod} onChange={(e) => setDuesPeriod(e.target.value)} aria-label="Month the challan paid for" />
                  <Input value={challanNo} onChange={(e) => setChallanNo(e.target.value)} placeholder="Challan / CIN no. (optional)" maxLength={40} aria-label="Challan number" />
                </div>
              </div>
            )}

            <Button
              size="sm"
              variant="primary"
              icon="check"
              disabled={bookStatutory.isPending || bookTax.isPending || (statutoryKind === "gst" && (taxPortion <= 0 || !gstPeriod))}
              loading={bookStatutory.isPending || bookTax.isPending}
              onClick={handleBookStatutory}
            >
              {statutoryKind === "gst"
                ? `Book ${rupee(amount)} as GST paid${gstPeriod ? ` (${gstPeriod})` : ""}`
                : statutoryKind === "income_tax"
                  ? `Book ${rupee(amount)} as ${itKind === "advance_tax" ? "advance tax" : "self-assessment tax"} · FY ${itFy}`
                  : `Book ${rupee(amount)} as ${statutoryKind.toUpperCase()} paid`}
            </Button>
          </div>
        )}
      </div>
    )}

    </>
  );
  const suggestionsBlock = (
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
          <p className="text-xs text-ink-3 mt-1">
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
                <p className="text-xs text-ink-3">
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
  );
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
                  <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold inline-flex items-center gap-1">
                    <Icon name={dirIcon} size={10} /> {dirLabel}
                  </p>
                  <p className="text-sm text-ink mt-0.5 break-words">
                    {transaction.description}
                  </p>
                  {transaction.reference && (
                    <p className="text-xs text-ink-3 font-mono mt-1">
                      Ref: {transaction.reference}
                    </p>
                  )}
                  <p className="text-xs text-ink-3 mt-1">
                    {formatDate(transaction.txn_date)}
                  </p>
                </div>
                <p className={`font-serif text-xl tabular-nums whitespace-nowrap ${isCredit ? "text-emerald" : "text-rose"}`}>
                  {isCredit ? "+" : "−"}{rupee(amount)}
                </p>
              </div>
            </div>

            {/* Suggested matches — hidden once "This money is for:" has booked the line (R-1838); behind
                "Not a vendor payment?" on a vendor line (R-1917). */}
            {!payForDone && !vendorLine && suggestionsBlock}

            {/* R-1838: money from a customer — FIRST, it is the commonest money-in. Says what
                the money is for (renewal / add seats / new-product quote, unpaid invoice, or a new
                sale with seats × unit price) and records it through record_payment. Project
                money keeps its own section. */}
            {isCredit && (showProject ? (
              <div className="rounded-md border border-amber/50 bg-amber-soft/25 p-3">
                <ProjectPaymentSection
                  txn={transaction}
                  amount={amount}
                  customers={customers ?? []}
                  customerId={projCustomer}
                  onCustomerChange={setProjCustomer}
                  onNewCustomer={() => setNewCustomerOpen(true)}
                  onCancel={() => setShowProject(false)}
                  onDone={() => { setShowProject(false); onOpenChange(false); }}
                />
              </div>
            ) : (
              <CreditPayForSection
                transaction={transaction}
                customers={customers ?? []}
                onNewCustomer={() => setNewCustomerOpen(true)}
                pickedCustomerId={createdCustomer}
                onProjectPayment={() => setShowProject(true)}
                onSaved={() => setPayForDone(true)}
                onDone={() => onOpenChange(false)}
              />
            ))}

            {/* R-1864: an EMI / loan repayment — matched to the loan's instalment and split into
                principal (reduces the loan) + interest (P&L); opens itself when the line looks like one. */}
            {!isCredit && !payForDone && !vendorLine && (
              <EmiRepaymentSection transaction={transaction} onDone={() => onOpenChange(false)} />
            )}

            {/* R-1866: money to a vendor — "This payment is for:" its open bills (several, part,
                net of TDS), a bill recorded on the spot, an advance, a bank charge. One transaction.
                A challan to the government (govtHint) is not a vendor — booked below instead.
                R-1917: once it knows the vendor it is the one way — everything else is folded below. */}
            {!isCredit && !govtHint && (
              <DebitPayForSection transaction={transaction} onSaved={() => setPayForDone(true)} onDone={() => onOpenChange(false)} onVendorChange={setVendorFocus} />
            )}

            {vendorLine && (
              <button
                ref={otherWaysRef}
                type="button"
                onClick={() => setShowOther((v) => !v)}
                aria-expanded={showOther}
                className="w-full flex items-center justify-between gap-2 rounded-md border border-hairline px-3 py-2 text-left hover:border-hairline-strong"
              >
                <span className="text-xs font-semibold text-ink-2">
                  Not a payment to {vendorFocus?.vendorName}? Other ways to book this line
                </span>
                <Icon name={showOther ? "chevron_up" : "chevron_down"} size={14} className="text-ink-3 shrink-0" />
              </button>
            )}

            {/* Once booked, only the result stays: the other choices no longer apply to this line.
                R-1917: on a vendor line they open only from "Not a payment to …?". */}
            {!payForDone && (!vendorLine || showOther) && (<>

            {vendorLine && suggestionsBlock}
            {vendorLine && <EmiRepaymentSection transaction={transaction} onDone={() => onOpenChange(false)} />}

            {/* Book money-IN as capital / a director's loan — credit lines only.
                Adds the Balance-Sheet line AND reconciles, in one step. */}
            {/* R-1839: a proprietor / firm books money the owner puts in as dated "Capital
                introduced" (OwnerEquitySection, below) — one way, not a lump line here. A firm
                keeps the loan-from-partner choice; a company keeps both choices as before. */}
            {isCredit && !(ownerWords.allowed && !ownerWords.needsPartner) && (
              <div className="rounded-md border border-emerald/40 bg-emerald/5 p-3">
                <p className="text-xs font-semibold text-ink-2 mb-1">{ownerWords.allowed ? "A loan from a partner?" : "Money put into the business?"}</p>
                <p className="text-xs text-ink-3 mb-3 leading-relaxed">
                  {ownerWords.allowed
                    ? <>Money a partner lent the firm, to be repaid — this {rupee(amount)} is <b>not income</b> and not capital.</>
                    : <>Account opening / promoter funds — this {rupee(amount)} is <b>not income</b>. Book it correctly and reconcile in one step.</>}
                </p>
                <div className="space-y-2">
                  {!ownerWords.allowed && (
                  <div className="grid grid-cols-1 gap-1.5">
                    <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer ${creditKind === "capital" ? "border-emerald bg-emerald/10" : "border-hairline"}`}>
                      <input type="radio" name="creditKind" checked={creditKind === "capital"} onChange={() => setCreditKind("capital")} className="mt-1" />
                      <span>
                        <span className="block text-sm text-ink">Owner&apos;s capital <span className="text-ink-3">(equity)</span></span>
                        <span className="block text-xs text-ink-3">Capital put into the business — not to be taken back.</span>
                      </span>
                    </label>
                    <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer ${creditKind === "director_loan" ? "border-emerald bg-emerald/10" : "border-hairline"}`}>
                      <input type="radio" name="creditKind" checked={creditKind === "director_loan"} onChange={() => setCreditKind("director_loan")} className="mt-1" />
                      <span>
                        <span className="block text-sm text-ink">Director&apos;s loan <span className="text-ink-3">(liability)</span></span>
                        <span className="block text-xs text-ink-3">Put in temporarily — the company will repay it.</span>
                      </span>
                    </label>
                  </div>
                  )}
                  <Input aria-label="Ledger label"
                    value={creditLabel}
                    onChange={(e) => setCreditLabel(e.target.value)}
                    placeholder={ownerWords.allowed ? "Label (default: Loan from partner)" : creditKind === "capital" ? "Label (default: Owner's capital)" : "Label (default: Director's loan)"}
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
                  Book {rupee(amount)} as {ownerWords.allowed ? "a loan from a partner" : creditKind === "capital" ? "capital" : "director's loan"}
                </Button>
              </div>
            )}

            {/* A salary transfer ("…-TPT-SALARY APR 2026-PAWAN", "NEFT DR-…-PRATIK-…-JULY
                SALARY"): lead with booking it as that employee's salary for that month —
                the same Payroll path as Banking → Salary lines — not as a plain expense. */}
            {salaryHint && (
              <div className="rounded-md border border-emerald/40 bg-emerald-soft/25 p-3 space-y-2">
                <p className="text-xs font-semibold text-ink-2">
                  Looks like salary{salaryHint.name ? <> for <b>{titleCaseName(salaryHint.name)}</b></> : ""}
                </p>
                <p className="text-xs text-ink-3 leading-relaxed">
                  Books this {rupee(amount)} as the employee&apos;s salary for the month — the salary record is created in
                  Payroll (or the existing one is used) and this line is reconciled to it.
                </p>
                {salaryHint.director && (
                  <p className="text-xs text-amber-ink bg-amber-soft/40 rounded px-2 py-1">
                    The narration says <b>director</b>. If the director is on the payroll (salary, TDS u/s 192), book it here.
                    Otherwise book it below as a <b>Director&apos;s Remuneration</b> expense — check with your CA which applies.
                  </p>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <select
                    value={salaryEmp}
                    onChange={(e) => setSalaryEmp(e.target.value)}
                    aria-label="Employee"
                    className="rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-emerald/40"
                  >
                    <option value="" disabled>Pick employee…</option>
                    {salaryHint.name && <option value="create">＋ New employee “{titleCaseName(salaryHint.name)}”</option>}
                    {(employees ?? []).filter((e) => e.is_active).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                  <Input type="month" value={salaryPeriod} onChange={(e) => setSalaryPeriod(e.target.value)} aria-label="Salary month" />
                </div>
                {!salaryHint.periodFromNarration && (
                  <p className="text-xs text-amber-ink">No month in the narration — assumed the month before payment. Change it if needed.</p>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  icon="check"
                  disabled={!salaryEmp || !salaryPeriod || bookSalary.isPending}
                  loading={bookSalary.isPending}
                  onClick={handleBookSalary}
                >
                  Book {rupee(amount)} as salary{salaryPeriod ? ` · ${salaryPeriod}` : ""}
                </Button>
              </div>
            )}

            {/* A challan to the government is not an expense: when the narration says
                so (ESIC, EPFO, ITNS 281, GST CIN…), lead with the statutory / tax booking. */}
            {govtHint && (
              <div className="space-y-1.5">
                <p className="text-xs text-indigo-ink bg-indigo-soft/40 border border-indigo/20 rounded-md px-3 py-2">
                  Looks like a <b>{govtHint.label}</b> — a payment to the government, not an expense. Book it below.
                </p>
                {statutorySection}
              </div>
            )}

            {/* Book directly as an expense — money-out lines only. Creates the
                expense (P&L) and reconciles this line, with NO extra cash leg.
                FIRST among the money-out choices: most money out is an expense, and
                when a rule or the import already named the category it is prefilled. */}
            {!isCredit && (
              <div className={`rounded-md border p-3 ${expenseSuggestion ? "border-amber bg-amber-soft/40" : "border-amber/40 bg-amber-soft/25"}`}>
                <p className="text-xs font-semibold text-ink-2 mb-1">
                  {expenseSuggestion ? <>Looks like a <b>{expenseSuggestion.category}</b> expense</> : "Book as a new expense"}
                </p>
                <p className="text-xs text-ink-3 mb-3 leading-relaxed">
                  {expenseSuggestion
                    ? <>Category filled from <b>{expenseSuggestion.reason}</b> — change it if that&apos;s wrong. </>
                    : "Not in your books yet? "}
                  Record this {rupee(amount)} as an expense and reconcile it in one step. No double entry — this bank line is the cash-out.
                </p>
                <div className="space-y-2">
                  <select
                    value={bookCategory}
                    onChange={(e) => setBookCategory(e.target.value)}
                    aria-label="Expense category"
                    className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                  >
                    <option value="" disabled>Choose category…</option>
                    {/* Salaries are NOT a plain expense — they're booked in Payroll
                        (payslip + statutory + paid-status), so they're excluded here. */}
                    {EXPENSE_CATEGORIES.filter((c) => c !== "Salaries").map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <div className="grid grid-cols-2 gap-2">
                    <Input aria-label="Vendor / payee (optional)" value={bookVendor} onChange={(e) => setBookVendor(e.target.value)} placeholder="Vendor / payee (optional)" />
                    <Input aria-label="GST paid ₹ (optional)" value={bookGst} onChange={(e) => setBookGst(e.target.value)} type="number" min={0} placeholder="GST paid ₹ (optional)" />
                  </div>
                </div>
                {/* R-1917 (B8): this vendor's open bill of this amount is PAID with this line, not booked again. */}
                {expenseCheck && (
                  <div role={expenseCheck.blocked ? "alert" : "note"} className={`mt-2.5 rounded-md border px-2.5 py-2 text-xs leading-relaxed ${expenseCheck.blocked ? "border-rose/40 bg-rose-soft/30 text-rose-ink" : "border-amber/40 bg-paper text-amber-ink"}`}>
                    <p>{expenseCheck.message}</p>
                    {expenseCheck.blocked && (
                      <button type="button" onClick={backToVendor} className="mt-1 font-medium underline hover:no-underline">
                        Go to Record payment
                      </button>
                    )}
                  </div>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  icon="check"
                  className="mt-3"
                  disabled={!bookCategory || bookExpense.isPending || Boolean(expenseCheck?.blocked)}
                  loading={bookExpense.isPending}
                  onClick={handleBookExpense}
                >
                  {bookCategory ? `Book ${rupee(amount)} as ${bookCategory}` : `Book ${rupee(amount)} expense`}
                </Button>
                <p className="mt-2.5 text-xs text-ink-3 leading-relaxed">
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

            {/* R-1839: not an expense — the owner's own money (drawings / capital introduced), or
                for a Pvt Ltd the "Paid to a director" choices; and an employee's incentive, which
                is salary (Payroll), never a plain expense. */}
            {!isCredit && <IncentiveFromBankSection transaction={transaction} onDone={() => onOpenChange(false)} />}
            {/* R-1871: office-expense advance to an employee (money-out: give / top-up, or a
                reimbursement owed) and its unused money coming back (money-in). An asset, not an expense. */}
            <EmployeeAdvanceBankSection transaction={transaction} onDone={() => onOpenChange(false)} />
            <OwnerEquitySection transaction={transaction} onDone={() => onOpenChange(false)} />

            {/* Referral commission paid from this line. */}
            {!isCredit && commissionCandidates.length > 0 && (
              <div className="rounded-md border border-hairline p-3">
                <button type="button" onClick={() => setShowCommission((v) => !v)} aria-expanded={showCommission} className="w-full flex items-center justify-between text-left">
                  <span className="text-xs font-semibold text-ink-2">Referral partner commission?</span>
                  <Icon name={showCommission ? "chevron_up" : "chevron_down"} size={14} className="text-ink-3" />
                </button>
                {showCommission && (
                  <div className="mt-2 space-y-2">
                    <select value={commissionPick} onChange={(e) => setCommissionPick(e.target.value)} aria-label="Referral commission" className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40">
                      <option value="">Select a commission…</option>
                      {commissionCandidates.map((c) => (
                        <option key={c.id} value={c.id}>{c.partner_name ?? "partner"} · {formatDate(c.earned_date)} · net {rupee(c.net_payable)}{c.status === "paid" ? " (paid — replaces the manual line)" : ""}</option>
                      ))}
                    </select>
                    <p className="text-xs text-ink-3">The line amount must equal the commission's net payable (after TDS).</p>
                    <Button size="sm" variant="primary" icon="check" disabled={!commissionPick || bookCommission.isPending} loading={bookCommission.isPending} onClick={handleBookCommission}>
                      Book {rupee(amount)} as commission paid
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Loan / advance between you and a person — BOTH sides. Not income,
                not expense: books a balance-sheet ASSET (you lent) or LIABILITY
                (you borrowed) so the P&L is untouched; the pair nets to zero once
                settled. Two choices cover all four cases. */}
            <div className="rounded-md border border-indigo/40 bg-indigo-soft/25 p-3">
              <p className="text-xs font-semibold text-ink-2 mb-1">Loan / advance with a person?</p>
              <p className="text-xs text-ink-3 mb-2.5 leading-relaxed">
                This {rupee(amount)} is <b>not income or expense</b> — it&apos;s a loan/advance. Pick who lent, so it books correctly (P&amp;L stays clean).
              </p>
              <div className="grid grid-cols-1 gap-1.5 mb-2.5">
                <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer ${advanceKind === "given" ? "border-indigo bg-indigo/10" : "border-hairline"}`}>
                  <input type="radio" name="advanceKind" checked={advanceKind === "given"} onChange={() => setAdvanceKind("given")} className="mt-1" />
                  <span>
                    <span className="block text-sm text-ink">
                      {isCredit ? "A loan/advance I GAVE has come back" : "I am GIVING a loan/advance"}
                    </span>
                    <span className="block text-xs text-ink-3">I gave it — my money, to be received back (asset).</span>
                  </span>
                </label>
                <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer ${advanceKind === "received" ? "border-indigo bg-indigo/10" : "border-hairline"}`}>
                  <input type="radio" name="advanceKind" checked={advanceKind === "received"} onChange={() => setAdvanceKind("received")} className="mt-1" />
                  <span>
                    <span className="block text-sm text-ink">
                      {isCredit ? "Someone GAVE me a loan" : "I am REPAYING a loan someone gave me"}
                    </span>
                    <span className="block text-xs text-ink-3">I received it — their money, to be repaid (liability).</span>
                  </span>
                </label>
              </div>
              <Input aria-label="Person's name (e.g. Julie Rawat)"
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
                <p className="text-xs text-ink-3 mb-2.5 leading-relaxed">
                  Paid more than the salary by mistake? Pick the salary — its balance is settled and the EXTRA is booked as a recoverable <b>advance</b> (recover it later via a salary deduction). No double cash-out — this line is the payment.
                </p>
                <select aria-label="Salary to settle"
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
                      <p className="text-xs text-ink-2 mb-2">
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


            {!govtHint && statutorySection}

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
                  <p className="text-xs text-ink-3 mt-1 leading-relaxed">
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
                              <span className="block text-xs text-ink-3">
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
            {!isCredit && combineCandidates.length > 0 && (
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
                  <p className="text-xs text-ink-3 mt-1 leading-relaxed">
                    Paid several bills — or 2 months&apos; salary — in one transfer? Tick the expenses that add up to {rupee(amount)}.
                  </p>
                )}
                {showSplit && (
                  <div className="mt-2 space-y-2">
                    <ul className="max-h-52 overflow-y-auto space-y-1 pr-1">
                      {combineCandidates.map((e) => (
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
                              <span className="block text-xs text-ink-3 truncate">
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
              <p className="text-xs text-ink-3 mb-3 leading-relaxed">
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
            </>)}
          </div>
        )}

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>

      {/* Nested inside the reconcile sheet so closing the form returns here with the
          new customer already picked. */}
      <AddCustomerForm
        open={newCustomerOpen}
        onOpenChange={setNewCustomerOpen}
        onCreated={(id) => { setCreatedCustomer(id); setProjCustomer(id); setNewCustomerOpen(false); }}
      />
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
