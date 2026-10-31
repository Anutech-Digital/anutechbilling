/**
 * R-1838 — "This money is for:" on a money-in bank line (Banking → Reconcile).
 *
 * Pardeep (24 Oct): Create invoice asked only a product and a total — not the seats, not the
 * unit price, not WHICH quote the money paid — so renewals, add-seats and new subscriptions were
 * booked as one-off invoices. Now, in one place:
 *
 *   1. Customer — guessed from the narration (or a certain invoice match), changeable.
 *   2. What the money is for —
 *        (a) one of that customer's open items: renewal / add-seats / new-product quotes and
 *            unpaid invoices, the one whose due equals the credit pre-selected; or
 *        (b) a new sale: product, seats, unit price, term — GST shown; or
 *        (c) R-1863: an advance — nothing to invoice yet; the whole credit becomes the customer's
 *            advance credit (reconcile_bank_credit_as_advance), offered on their next payment; or
 *        (d) R-2098: several of the open items (+ an optional new sale) — one bar shows allocated /
 *            bank / left; the rest is advance or, up to ₹50, a round-off (reconcile_bank_credit_split).
 *      A new subscription sale offers "Create subscription" (ticked) with start + renewal dates.
 *   3. Amount check — exact / short (TDS deducted, or part payment) / over (kept as credit).
 *   4. One button → one server transaction (lib/queries/bank-credit-pay-for.ts), then the sheet
 *      says what happened, with links.
 *
 * Loans, refunds, capital and transfers stay in the "not a sale" sections below this one.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { useItems } from "@/lib/queries/items";
import { useGstRegistration } from "@/lib/compliance/gst-registration-query";
import { billOfSupplyStatus } from "@/lib/quotes/bill-of-supply";
import { isExportSupply } from "@/lib/gst/place-of-supply";
import { useOpenInvoicesForCreditMatch, type BankTransactionRow } from "@/lib/queries/bank";
import { matchCreditToInvoices } from "@/lib/banking/invoice-credit-match";
import {
  useAdvanceFromBankCredit, useBankCreditOpenItems, useNewSaleFromBankCredit, usePayItemFromBankCredit,
  useRelinkOneOffSale, useSplitFromBankCredit, type RelinkTarget,
} from "@/lib/queries/bank-credit-pay-for";
import {
  amountCheck, commitmentOptions, customerOptions, defaultCycle, defaultRenewal, guessCustomer, itemDetail, itemKey, kindLabel,
  laterBillsText, linesAreMonthly, paymentChoice, preselectItem, rateFromShownPrice, repriceLine, resultLines, saleBillingCycle,
  paidUpText, saleLineFromItem, saleLinesPayload, saleMakesSubscription, salePaidUp, salePreview, saleSchedule, saleTermsMixed, saleTermText, shownPriceUnit, shownUnitPrice, splitRenewalProblem,
  tdsRateToRecord, tdsToRecord, shortChoices, roundOffSplit, saleLineDomainProblem,
  typedPriceCheck, convertTypedPrice, keepTypedPrice, undoTypedConversion,
  type AmountCheck, type OldOneOffBooking, type OpenItem, type PayForResult, type PaymentChoice, type SaleCycle, type SaleLine, type ShortChoice,
} from "@/lib/banking/credit-pay-for";
import { tdsSectionGuess, TDS_SECTION_CHOICES } from "@/lib/banking/tds-section";
import type { BillingCycle } from "@/lib/supabase/database.types";
import { PAYER_RELATIONS, payerFromNarration, payerMatchesCustomer, type PayerRelation } from "@/lib/banking/customer-payer";
import { usePayerMemory, useSetBankLinePayer } from "@/lib/queries/customer-payers";
import { cleanAmount, pickDefault, pickProblem, splitBlocked, splitPartPaid, splitRest, splitSummary, type SplitRest } from "@/lib/banking/credit-pay-for-multi";
import { CreditPaySplit } from "./credit-pay-for-split";
import { NEEDS_APPROVAL_LABEL } from "@/lib/quotes/payment-approval";

const NEW_CUSTOMER = "__new_customer__";

export interface PayForCustomer { id: string; name: string; country?: string | null; gstin?: string | null; domain?: string | null }

interface Props {
  transaction: BankTransactionRow;
  customers: readonly PayForCustomer[];
  /** Opens the shared Add-customer form; the parent passes back the new id via `pickedCustomerId`.
   *  Left out (relink) → no "New customer" choice. */
  onNewCustomer?: () => void;
  /** A customer the parent just created — picked here. */
  pickedCustomerId?: string | null;
  /** Left out (relink) → no "Project payment" button. Gets the customer chosen in "Who paid?"
   *  ("" when none) so the project section opens on that customer's project (R-2004). */
  onProjectPayment?: (customerId: string) => void;
  /** The line is booked — the parent hides the choices that no longer apply. */
  onSaved?: () => void;
  onDone: () => void;
  /** R-1863: an old one-off bank sale being moved — save goes through relink_bank_one_off_sale
   *  (undo the old sale + book this choice, one transaction). */
  relink?: OldOneOffBooking | null;
  /** R-2007: the Suggestion card's open item (and whether the gap is TDS) — "Change" opens this
   *  section with it ticked. */
  suggested?: { itemKey: string; tds: boolean } | null;
}

type Mode = "item" | "sale" | "advance" | "split";
/* R-2025 (0) — Pardeep 27 Oct: after picking the customer NOTHING is pre-chosen. "A new sale" used
   to be pre-selected when the customer had nothing open, so one Save booked a sale + GST invoice +
   subscription on money that was really an advance. Each choice now says what it will do, and Save
   stays locked until one is picked. Only the Suggestion card's "Change" (R-2007, a confident guess
   the owner opened on purpose) arrives with the open item already ticked. */
const MODES: ReadonlyArray<readonly [Mode, string, string]> = [
  ["item", "An open quote / invoice", "Pays the quote → service starts + GST invoice"],
  ["sale", "A new sale (no quote yet)", "Records a sale → GST invoice + subscription"],
  ["advance", "Advance — nothing to invoice yet", "Customer credit, no invoice — use it on the next bill"],
  /* R-2098: one line, several items. Not offered on a relink (one old sale → one target). */
  ["split", "Several quotes / invoices", "Splits this money — the rest as advance or round-off"],
];

const selectCls =
  "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";

export function CreditPayForSection({ transaction, customers, onNewCustomer, pickedCustomerId, onProjectPayment, onSaved, onDone, relink, suggested }: Props) {
  const credit = transaction.credit;

  /* ── 1. Customer ─────────────────────────────────────────────────────────────── */
  const { data: openInvoices } = useOpenInvoicesForCreditMatch(credit > 0);
  /* R-2025: the customers' known payers and our own name (never the payer). */
  const memory = usePayerMemory();
  const guess = React.useMemo(() => {
    const ms = matchCreditToInvoices(
      { amount: credit, txnDate: transaction.txn_date, description: transaction.description, reference: transaction.reference },
      openInvoices ?? [],
    );
    return guessCustomer(transaction, customers, ms, memory);
  }, [transaction, customers, openInvoices, credit, memory]);
  const [customerId, setCustomerId] = React.useState("");
  const [touchedCustomer, setTouchedCustomer] = React.useState(false);
  React.useEffect(() => { setCustomerId(""); setTouchedCustomer(false); }, [transaction.id]);
  React.useEffect(() => {
    if (!touchedCustomer && guess && !customerId) setCustomerId(guess.customerId);
  }, [guess, touchedCustomer, customerId]);
  React.useEffect(() => {
    if (pickedCustomerId) { setCustomerId(pickedCustomerId); setTouchedCustomer(true); }
  }, [pickedCustomerId]);
  const customer = customers.find((c) => c.id === customerId) ?? null;
  /* R-2026 (5): each customer once, each name once (the "JAK GROUP…JAK GROUP…" screenshot). */
  const customerChoices = React.useMemo(() => customerOptions(customers), [customers]);

  /* ── 1b. R-2025: who REALLY paid — the payer the narration names. When it is not the chosen
     customer (by name, or one of their known payers) the sheet warns and Save needs an answer.
     Not on a relink (the line is already booked). ─────────────────────────────── */
  const payer = React.useMemo(
    () => (relink ? null : payerFromNarration(transaction.description, memory.ownNames)),
    [relink, transaction.description, memory.ownNames],
  );
  const knownForCustomer = React.useMemo(() => memory.payers.filter((k) => k.customer_id === customerId), [memory.payers, customerId]);
  const knownHit = payer ? knownForCustomer.find((k) => k.payer_name_key === payer.key) ?? null : null;
  const payerMismatch = Boolean(customer && payer && !payerMatchesCustomer(payer, customer.name, knownForCustomer));
  const [payerAnswer, setPayerAnswer] = React.useState<{ relation: PayerRelation; note: string } | null>(null);
  React.useEffect(() => { setPayerAnswer(null); }, [customerId, transaction.id]);
  const setLinePayer = useSetBankLinePayer();
  const payerToRecord: { relation: PayerRelation; note: string | null } | null = !payer
    ? null
    : payerMismatch
      ? payerAnswer && { relation: payerAnswer.relation, note: payerAnswer.note.trim() || null }
      : knownHit ? { relation: knownHit.relation, note: null } : null;
  const wrongCustomer = () => { setCustomerId(""); setTouchedCustomer(true); };

  /* ── 2. What for ─────────────────────────────────────────────────────────────── */
  const { data: items, isLoading: itemsLoading } = useBankCreditOpenItems(customerId || null);
  const [mode, setMode] = React.useState<Mode | null>(null);
  const [pickKey, setPickKey] = React.useState("");
  /* A new customer or bank line → no choice made yet (R-2025 (0)). */
  React.useEffect(() => { setMode(null); }, [customerId, transaction.id]);
  React.useEffect(() => {
    if (!items) return;
    const fromCard = suggested ? items.find((i) => itemKey(i) === suggested.itemKey) ?? null : null;
    const pre = fromCard ?? preselectItem(items, credit);
    setPickKey(pre ? itemKey(pre) : "");
    if (fromCard) setMode("item");
  }, [items, credit, suggested]);
  const picked = (items ?? []).find((i) => itemKey(i) === pickKey) ?? null;

  /* R-2098: several items — key → amount on it; an optional new sale; what the rest is. */
  const [picks, setPicks] = React.useState<Record<string, number>>({});
  const [splitSale, setSplitSale] = React.useState(false);
  const [splitSaleAmount, setSplitSaleAmount] = React.useState<number | null>(null);   // null = its first bill
  const [restChoice, setRestChoice] = React.useState<SplitRest>("advance");
  React.useEffect(() => { setPicks({}); setSplitSale(false); setSplitSaleAmount(null); setRestChoice("advance"); }, [customerId, transaction.id]);
  const togglePick = (i: OpenItem) => setPicks((p) => {
    const k = itemKey(i);
    if (k in p) return Object.fromEntries(Object.entries(p).filter(([x]) => x !== k));
    const d = pickDefault(i);
    return { ...p, [d.key]: d.amount };
  });

  /* New sale lines. */
  const { data: catalog } = useItems();
  const activeCatalog = React.useMemo(() => (catalog ?? []).filter((i) => i.is_active), [catalog]);
  const [lines, setLines] = React.useState<SaleLine[]>([]);
  React.useEffect(() => { setLines([]); }, [transaction.id]);
  const gst = useGstRegistration();
  const gstRate = billOfSupplyStatus(gst.data?.saved ?? null) || isExportSupply(customer?.country ?? null) ? 0 : 18;
  const preview = salePreview(lines, gstRate);
  /* R-2026: Payment — how often an annual commitment is billed (the quote's billing_cycle). */
  const [payCycle, setPayCycle] = React.useState<BillingCycle>("yearly");
  React.useEffect(() => { setPayCycle("yearly"); }, [transaction.id]);
  const payment = paymentChoice(lines);
  const saleCycle = saleBillingCycle(lines, payCycle);

  /* Subscription choice (new subscription sale only). */
  const saleShown = mode === "sale" || (mode === "split" && splitSale);
  const makesSub = mode === "item" ? Boolean(picked?.makes_subscription) : saleShown && saleMakesSubscription(lines);
  const monthly = mode === "item" ? linesAreMonthly(picked?.lines ?? null) : lines.some((l) => l.cycle === "monthly");
  const [createSub, setCreateSub] = React.useState(true);
  const [subStart, setSubStart] = React.useState(transaction.txn_date);
  const [subRenewal, setSubRenewal] = React.useState<string | null>(null);   // null = follows the term
  React.useEffect(() => { setCreateSub(true); setSubStart(transaction.txn_date); setSubRenewal(null); }, [transaction.id, transaction.txn_date, pickKey, mode]);
  const renewalShown = subRenewal ?? defaultRenewal(subStart || transaction.txn_date, monthly);
  /* R-2095: a 1-year commitment billed in parts renews at the end of the year, not on the next part. */
  const renewalProblem = makesSub && createSub && saleShown ? splitRenewalProblem(subStart, renewalShown, saleCycle, monthly) : null;
  const datesBad = makesSub && createSub && (!subStart || renewalShown <= subStart || Boolean(renewalProblem));
  const termText = mode === "sale" ? saleTermText(subStart, renewalShown) : null;

  /* ── 3. Amount check ─────────────────────────────────────────────────────────── */
  /* R-2026: a new sale paid in parts is due its FIRST bill now (Annual + Quarterly = one
     quarter + GST); the rest of the schedule is shown under it. */
  const schedule = saleSchedule(lines, gstRate, saleCycle, subStart || transaction.txn_date);
  const laterText = saleShown && preview.total > 0 ? laterBillsText(schedule, saleCycle) : null;
  /* An advance has nothing due — the whole credit is kept as the customer's credit. */
  const due = mode === "item" ? (picked?.amount_due ?? null) : mode === "sale" && preview.total > 0 ? schedule.dueNow : null;
  const taxable = mode === "item" ? (picked?.taxable_value ?? 0) : schedule.dueTaxable;
  const check: AmountCheck | null = due === null ? null : amountCheck(credit, due, taxable);
  /* R-2052: annual commitment billed in parts — Renews on stays the end of the year; this says
     how far the money pays, and takes over the "Next N bills" line (the next bill said once). */
  const paidUp = mode === "sale" && makesSub && createSub && preview.total > 0
    ? salePaidUp(schedule, check?.kind === "over" ? check.overBy : 0, renewalShown, saleCycle)
    : null;
  /* R-2098: the split's bar. */
  const splitPicked = (items ?? []).filter((i) => itemKey(i) in picks);
  const saleAmt = splitSale ? cleanAmount(splitSaleAmount ?? schedule.dueNow) : 0;
  /* R-2098: a round-off only when every item (and the new sale) ends settled in full. */
  const splitPart = splitPartPaid([
    ...splitPicked.map((i) => ({ amount: picks[itemKey(i)], due: i.amount_due })),
    ...(splitSale ? [{ amount: saleAmt, due: preview.total }] : []),
  ]);
  const split = splitSummary(credit, [...splitPicked.map((i) => picks[itemKey(i)]), saleAmt], { partPaid: splitPart });
  const rest = splitRest(split.state, restChoice);
  const splitInvalid = (splitPicked.length === 0 && !splitSale)
    || splitPicked.some((i) => pickProblem(i, picks[itemKey(i)]) !== null)
    || (splitSale && (saleInvalidOf(lines, preview.taxable) || saleAmt <= 0 || saleAmt > preview.total))
    || splitBlocked(split.state)
    || splitPicked.some((i) => Boolean(i.approval_block));
  /* R-2213: the picked quote (or a ticked one in a split) is below cost and waits for approval. */
  const blockedItem = mode === "item" ? (picked?.approval_block ? picked : null)
    : mode === "split" ? splitPicked.find((i) => Boolean(i.approval_block)) ?? null : null;
  const approvalBlocked = blockedItem?.approval_block && blockedItem.quote_id
    ? { reason: blockedItem.approval_block, quoteId: blockedItem.quote_id } : null;
  const [shortChoice, setShortChoice] = React.useState<ShortChoice>("part");
  /* TDS pre-chosen when the gap IS a common TDS rate; else part payment. Re-decided per item. */
  const tdsLikely = check?.kind === "short" && check.tdsRatePct !== null;
  const cardSaysTds = Boolean(suggested?.tds && suggested.itemKey === pickKey);
  React.useEffect(() => { setShortChoice(tdsLikely || cardSaysTds ? "tds" : "part"); }, [tdsLikely, cardSaysTds, pickKey, mode]);

  /* ── 4. Save ─────────────────────────────────────────────────────────────────── */
  const payItem = usePayItemFromBankCredit();
  const newSale = useNewSaleFromBankCredit();
  const advance = useAdvanceFromBankCredit();
  const relinkSale = useRelinkOneOffSale();
  const splitPay = useSplitFromBankCredit();
  const [result, setResult] = React.useState<PayForResult | null>(null);
  React.useEffect(() => { setResult(null); }, [transaction.id]);
  const splitCount = splitPicked.length + (splitSale ? 1 : 0);
  const busy = payItem.isPending || newSale.isPending || advance.isPending || relinkSale.isPending || splitPay.isPending || setLinePayer.isPending;
  const saveErrorObj = splitPay.error ?? newSale.error ?? payItem.error ?? advance.error ?? relinkSale.error ?? setLinePayer.error;
  const saveError = saveErrorObj ? (saveErrorObj as { message?: string }).message ?? String(saveErrorObj) : null;

  const tdsAmount = check ? tdsToRecord(check, shortChoice) : 0;
  const tdsRate = check ? tdsRateToRecord(check, taxable) : null;
  /* R-2095: the section follows the rate and the customer's PAN type (lib/banking/tds-section); changeable. */
  const tdsGuess = tdsSectionGuess(check?.kind === "short" ? check.tdsRatePct : null, customer?.gstin ?? null);
  const [tdsSectionPick, setTdsSectionPick] = React.useState<string | null>(null);
  React.useEffect(() => { setTdsSectionPick(null); }, [pickKey, mode, customerId]);
  const tdsSection = tdsSectionPick ?? tdsGuess.section;
  const saleInvalid = saleInvalidOf(lines, preview.taxable);
  const payerUnanswered = payerMismatch && !payerAnswer;
  const canSave = Boolean(customerId) && mode !== null && !busy && !datesBad && !payerUnanswered
    && !approvalBlocked
    && (mode === "item" ? Boolean(picked) : mode === "sale" ? !saleInvalid : mode === "split" ? !splitInvalid : true);

  const save = async () => {
    if (!canSave || mode === null) return;
    const subArgs = {
      createSubscription: makesSub ? createSub : null,
      subStart: makesSub && createSub ? subStart : null,
      subRenewal: makesSub && createSub ? subRenewal : null,
    };
    /* R-2095: a round-off (≤ ₹50) on one sale / item settles it in full — saved through the split
       RPC, which books the difference (R-2098's rule) in the same transaction. */
    const roundOff = !relink && shortChoice === "round_off" && check?.kind === "short" && (mode === "sale" || (mode === "item" && picked))
      ? roundOffSplit(mode === "sale" ? { mode: "sale", saleTotal: preview.total } : { mode: "item", item: picked! })
      : null;
    if (roundOff) {
      try {
        if (payer && payerToRecord) {
          await setLinePayer.mutateAsync({ transactionId: transaction.id, customerId, payer, relation: payerToRecord.relation, note: payerToRecord.note });
        }
        const r = await splitPay.mutateAsync({
          transactionId: transaction.id, customerId, customerName: customer?.name ?? null,
          items: roundOff.items,
          sale: roundOff.saleAmount !== null
            ? { lines: saleLinesPayload(lines), billingCycle: saleCycle, createSubscription: makesSub ? createSub : false,
                subStart: subArgs.subStart, subRenewal: subArgs.subRenewal, amount: roundOff.saleAmount }
            : null,
          rest: roundOff.rest,
        });
        setResult(r);
        onSaved?.();
      } catch { /* the hook toasts */ }
      return;
    }
    if (mode === "split") {
      try {
        if (payer && payerToRecord) {
          await setLinePayer.mutateAsync({ transactionId: transaction.id, customerId, payer, relation: payerToRecord.relation, note: payerToRecord.note });
        }
        const r = await splitPay.mutateAsync({
          transactionId: transaction.id, customerId, customerName: customer?.name ?? null,
          items: splitPicked.map((i) => ({ quote_id: i.quote_id, invoice_id: i.invoice_id, amount: picks[itemKey(i)] })),
          sale: splitSale
            ? { lines: saleLinesPayload(lines), billingCycle: saleCycle, createSubscription: makesSub ? createSub : false,
                subStart: subArgs.subStart, subRenewal: subArgs.subRenewal, amount: saleAmt }
            : null,
          rest,
        });
        setResult(r);
        onSaved?.();
      } catch { /* the hook toasts */ }
      return;
    }
    const target: RelinkTarget = mode === "item" && picked
      ? {
          path: "item", transactionId: transaction.id, quoteId: picked.quote_id, invoiceId: picked.invoice_id,
          tdsAmount, tdsRatePct: tdsRate, tdsSection, ...subArgs,
        }
      : mode === "sale"
        ? {
            path: "new_sale", transactionId: transaction.id, customerId, lines, billingCycle: saleCycle,
            createSubscription: subArgs.createSubscription ?? false, subStart: subArgs.subStart, subRenewal: subArgs.subRenewal,
            tdsAmount, tdsRatePct: tdsRate, tdsSection,
          }
        : { path: "advance", transactionId: transaction.id, customerId };
    try {
      /* R-2025: the answer first — the save's own transaction then puts it on the receipt and
         learns the payer (trigger). If it cannot be stored, nothing is booked. */
      if (payer && payerToRecord && !relink) {
        await setLinePayer.mutateAsync({ transactionId: transaction.id, customerId, payer, relation: payerToRecord.relation, note: payerToRecord.note });
      }
      const r = relink
        ? await relinkSale.mutateAsync(target)
        : target.path === "item"
          ? await payItem.mutateAsync(target)
          : target.path === "new_sale"
            ? await newSale.mutateAsync(target)
            : await advance.mutateAsync(target);
      setResult(r);
      onSaved?.();
    } catch { /* the hook toasts */ }
  };

  if (credit <= 0) return null;

  if (result) {
    return (
      <section aria-labelledby="payfor-done-h" className="rounded-md border border-emerald/40 bg-emerald-soft/25 p-3 space-y-2">
        <p id="payfor-done-h" className="text-xs font-semibold text-ink-2 inline-flex items-center gap-1">
          <Icon name="check" size={14} className="text-emerald" /> Done — this bank line is reconciled
        </p>
        <ul className="space-y-1">
          {resultLines(result).map((l, i) => (
            <li key={i} className={`text-sm break-words ${l.tone === "warn" ? "text-amber-ink" : "text-ink"}`}>
              {l.href ? <Link href={l.href as never} className="underline hover:no-underline">{l.text}</Link> : l.text}
            </li>
          ))}
        </ul>
        <Button size="sm" variant="primary" onClick={onDone}>Close</Button>
      </section>
    );
  }

  const setLine = (idx: number, patch: Partial<SaleLine>) =>
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const addProduct = (id: string) => {
    const it = activeCatalog.find((c) => c.id === id);
    if (it) setLines((ls) => [...ls, saleLineFromItem(it, defaultCycle(it))]);
  };

  const saleEditorNode = (
    <SaleEditor
      customerDomain={customer?.domain ?? null}
      lines={lines}
      catalog={activeCatalog}
      gstRate={gstRate}
      preview={preview}
      payment={payment}
      payCycle={saleCycle}
      onPayCycle={setPayCycle}
      dueNow={schedule.dueNow}
      laterText={paidUp ? null : laterText}
      onAdd={addProduct}
      onChange={setLine}
      onRemove={(idx) => setLines((ls) => ls.filter((_, i) => i !== idx))}
    />
  );

  return (
    <section aria-labelledby="payfor-h" className="rounded-md border border-amber/50 bg-amber-soft/25 p-3 space-y-3">
      <div>
        <p id="payfor-h" className="text-xs font-semibold text-ink-2">{relink ? "This money was really for:" : "Money from a customer? This money is for:"}</p>
        <p className="text-xs text-ink-3 mt-0.5">Pick the customer and what they paid — the renewal, extra seats or new subscription is updated with the payment.</p>
      </div>

      {/* 1. Customer */}
      <div className="space-y-1">
        <select
          value={customerId}
          onChange={(e) => {
            if (e.target.value === NEW_CUSTOMER) { onNewCustomer?.(); return; }
            setCustomerId(e.target.value); setTouchedCustomer(true);
          }}
          aria-label="Customer who paid"
          className={selectCls}
        >
          <option value="" disabled>Who paid? Select a customer…</option>
          {onNewCustomer && <option value={NEW_CUSTOMER}>＋ New customer</option>}
          {customerChoices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        {guess && customerId === guess.customerId && !touchedCustomer && (
          <p className="text-xs text-ink-3">Guessed from {guess.reason} — change it if wrong.</p>
        )}
      </div>

      {/* 1b. R-2025: the money came from someone else's account */}
      {payerMismatch && payer && customer && (
        <PayerWarning
          payerName={payer.name}
          customerName={customer.name}
          answer={payerAnswer}
          onAnswer={setPayerAnswer}
          onWrongCustomer={wrongCustomer}
        />
      )}

      {customerId && (
        <>
          {/* 2. What for */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5" role="group" aria-label="What this money is for">
            {MODES.filter(([k]) => !(relink && k === "split")).map(([k, label, effect]) => (
              <button
                key={k}
                type="button"
                aria-pressed={mode === k}
                aria-label={label}
                aria-describedby={`payfor-mode-${k}`}
                onClick={() => setMode(k)}
                className={`rounded-md border px-2 py-1.5 text-xs text-left ${mode === k ? "border-amber bg-amber/10 text-amber-ink" : "border-hairline bg-paper text-ink-2"}`}
              >
                <span className="block font-medium">{label}</span>
                <span id={`payfor-mode-${k}`} className="block text-ink-3 mt-0.5">{effect}</span>
              </button>
            ))}
          </div>

          {mode === null ? (
            <p className="text-xs text-ink-3">Choose what this money is for — nothing is booked until you do.</p>
          ) : mode === "advance" ? (
            <p className="text-xs text-ink-2 bg-paper rounded-md border border-hairline px-2.5 py-2">
              The whole {rupee(credit)} is kept as {customer?.name ?? "the customer"}&apos;s advance credit, with a receipt voucher.
              Nothing is invoiced now — it is offered when you record their next payment.
            </p>
          ) : mode === "split" ? (
            itemsLoading ? <Skeleton className="h-16" /> : (
              <CreditPaySplit
                items={items ?? []}
                picks={picks}
                onToggle={togglePick}
                onAmount={(k, a) => setPicks((p) => ({ ...p, [k]: cleanAmount(a) }))}
                saleOn={splitSale}
                onSaleOn={setSplitSale}
                saleAmount={saleAmt}
                saleTotal={preview.total}
                onSaleAmount={(a) => setSplitSaleAmount(cleanAmount(a))}
                saleEditor={saleEditorNode}
                summary={split}
                rest={rest}
                restChoice={restChoice}
                onRestChoice={setRestChoice}
              />
            )
          ) : mode === "item" ? (
            itemsLoading ? <Skeleton className="h-16" /> : (items ?? []).length === 0 ? (
              <p className="text-xs text-ink-3">
                {customer?.name ?? "This customer"} has nothing open — no unpaid quote or invoice. Book it as a new sale, or keep it as an advance.
              </p>
            ) : (
              <ul className="space-y-1.5" role="radiogroup" aria-label="Open quotes and invoices">
                {(items ?? []).map((i) => (
                  <OpenItemRow key={itemKey(i)} item={i} credit={credit} selected={pickKey === itemKey(i)} onPick={() => setPickKey(itemKey(i))} />
                ))}
              </ul>
            )
          ) : saleEditorNode}

          {/* R-2213: a below-cost quote waiting for the owner takes no money — the DB refuses it, so
              Save is locked here with the same reason and the way forward. */}
          {approvalBlocked && (
            <div role="alert" className="rounded-md border border-amber/60 bg-amber-soft p-2.5 space-y-1.5">
              <p className="text-xs text-amber-ink break-words">
                <b>{NEEDS_APPROVAL_LABEL}.</b> {approvalBlocked.reason}
              </p>
              <Button size="sm" variant="default" asChild>
                <Link href={`/quotes/${approvalBlocked.quoteId}` as never}>Open approval</Link>
              </Button>
            </div>
          )}

          {/* Subscription choice — a new subscription sale only */}
          {makesSub && (saleShown || (mode === "item" && picked)) && (
            <div className="rounded-md border border-hairline bg-paper p-2.5 space-y-2">
              <label className="flex items-start gap-2 text-sm text-ink cursor-pointer">
                <input type="checkbox" checked={createSub} onChange={(e) => setCreateSub(e.target.checked)} className="mt-1" />
                <span>
                  <span className="block font-medium">Create subscription</span>
                  <span className="block text-xs text-ink-3">It renews on its own date and is chased for renewal. Untick only if it already exists elsewhere.</span>
                </span>
              </label>
              {createSub ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label className="text-xs text-ink-3 space-y-0.5">
                    <span className="block">Start date</span>
                    <Input type="date" value={subStart} onChange={(e) => setSubStart(e.target.value)} aria-label="Subscription start date" />
                  </label>
                  <label className="text-xs text-ink-3 space-y-0.5">
                    <span className="block">Renews on</span>
                    <Input type="date" value={renewalShown} onChange={(e) => setSubRenewal(e.target.value || null)} aria-label="Subscription renewal date" />
                  </label>
                  {datesBad && <p className="text-xs text-rose-ink sm:col-span-2">{renewalProblem ?? "The renewal date must be after the start date."}</p>}
                  {/* R-2053: the term once, then (R-2052) how far the money pays — no date twice. */}
                  {(termText || paidUp) && (
                    <div className="text-xs sm:col-span-2 space-y-0.5 tabular-nums">
                      {termText && <p className="text-ink-3">{termText}</p>}
                      {paidUp && <p className="text-ink-2">{paidUpText(paidUp)}</p>}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-amber-ink">No subscription will be created. The quote will show “paid but has no subscription” with a button to create it later.</p>
              )}
            </div>
          )}

          {/* 3. Amount check */}
          {check && <AmountCheckBox check={check} credit={credit} due={due ?? 0} choice={shortChoice} onChoice={setShortChoice}
            section={tdsSection} sectionReason={tdsSectionPick ? null : tdsGuess.reason} onSection={setTdsSectionPick} noRoundOff={Boolean(relink)} />}

          {/* R-2095 (staging, 30 Oct): a refused save left the drawer open with nothing said — the
              server's reason is shown here too, not only as a toast. */}
          {saveError && !busy && (
            <p role="alert" className="text-xs text-rose-ink break-words">Not saved: {saveError}</p>
          )}

          <div className="flex flex-wrap gap-2">
            {/* Wraps on a phone: the quote number makes the label longer than 375px allows. */}
            <Button size="sm" variant="primary" icon="check" disabled={!canSave} loading={busy} onClick={save}
              className="whitespace-normal h-auto min-h-8 py-1.5 text-left max-w-full">

              {relink ? "Relink: " : ""}
              {mode === null
                ? "Choose what this money is for"
                : mode === "item"
                ? picked ? `Record ${rupee(credit)} on ${picked.invoice_id ?? picked.quote_id} & reconcile` : "Pick what it pays"
                : mode === "split"
                  ? `Record on ${splitCount} item${splitCount === 1 ? "" : "s"} & reconcile ${rupee(credit)}`
                : mode === "sale"
                  ? `Record sale & reconcile ${rupee(credit)}`
                  : `Keep ${rupee(credit)} as advance & reconcile`}
            </Button>
            {onProjectPayment && <Button size="sm" variant="default" icon="briefcase" onClick={() => onProjectPayment(customerId)}>Project payment</Button>}
          </div>
          {payerUnanswered && mode !== null && <p className="text-xs text-amber-ink">Say who paid (above) before saving.</p>}
        </>
      )}
    </section>
  );
}

function OpenItemRow({ item, credit, selected, onPick }: { item: OpenItem; credit: number; selected: boolean; onPick: () => void }) {
  const exact = item.amount_due === credit;
  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onPick}
        className={`w-full text-left rounded-md border p-2.5 flex items-start gap-2 ${selected ? "border-amber bg-amber/10" : "border-hairline bg-paper hover:border-hairline-strong"}`}
      >
        <span aria-hidden className={`mt-1 h-3 w-3 shrink-0 rounded-full border ${selected ? "border-amber bg-amber" : "border-hairline-strong"}`} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge kind={item.kind === "renewal" ? "info" : item.kind === "add_seats" ? "warning" : item.kind === "new" ? "success" : "muted"} size="sm">
              {kindLabel(item.kind)}
            </Badge>
            {exact && <Badge kind="success" size="sm">Exact amount</Badge>}
            {item.approval_block && <Badge kind="warning" size="sm">{NEEDS_APPROVAL_LABEL}</Badge>}
          </span>
          <span className="block text-sm text-ink break-words mt-0.5">{itemDetail(item)}</span>
          <span className="block text-xs text-ink-3">Due {rupee(item.amount_due)} · {formatDate(item.doc_date)}</span>
        </span>
      </button>
    </li>
  );
}

function AmountCheckBox({ check, credit, due, choice, onChoice, section, sectionReason, onSection, noRoundOff }: {
  check: AmountCheck; credit: number; due: number; choice: ShortChoice; onChoice: (c: ShortChoice) => void;
  section: string; sectionReason: string | null; onSection: (s: string) => void; noRoundOff?: boolean;
}) {
  const choices = shortChoices(check).filter((c) => !(noRoundOff && c.value === "round_off"));
  if (check.kind === "exact") {
    return <p className="text-xs text-emerald inline-flex items-center gap-1"><Icon name="check" size={12} /> {rupee(credit)} received = {rupee(due)} due.</p>;
  }
  if (check.kind === "over") {
    return (
      <p className="text-xs text-ink-2 bg-paper rounded-md border border-hairline px-2.5 py-2">
        {rupee(credit)} received is <b>{rupee(check.overBy)} more</b> than {rupee(due)} due — the extra is kept as the customer&apos;s advance credit and used on their next bill.
      </p>
    );
  }
  return (
    <div className="rounded-md border border-hairline bg-paper px-2.5 py-2 space-y-1.5">
      <p className="text-xs text-ink-2">
        {rupee(credit)} received is <b>{rupee(check.shortBy)} less</b> than {rupee(due)} due.
        {check.tdsRatePct !== null && <> That is {check.tdsRatePct}% TDS on the taxable value.</>}
      </p>
      <div className={`grid grid-cols-1 gap-1.5 ${choices.length > 2 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`} role="group" aria-label="Why less was received">
        {choices.map(({ value: k, label }) => (
          <button
            key={k}
            type="button"
            aria-pressed={choice === k}
            onClick={() => onChoice(k)}
            className={`rounded-md border px-2 py-1.5 text-xs font-medium text-left ${choice === k ? "border-amber bg-amber/10 text-amber-ink" : "border-hairline text-ink-2"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {choice === "tds" && (
        <div className="space-y-1">
          <label className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
            <span>TDS section</span>
            <select value={section} onChange={(e) => onSection(e.target.value)} aria-label="TDS section"
              className="rounded-md border border-hairline bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber/40">
              {TDS_SECTION_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          {sectionReason && <p className="text-xs text-ink-3">{sectionReason}</p>}
          <p className="text-xs text-ink-3">Booked as TDS receivable (section {section}) — collect the customer&apos;s Form 16A.</p>
        </div>
      )}
    </div>
  );
}

type CatalogRow = NonNullable<ReturnType<typeof useItems>["data"]>[number];

/* R-2026: per product line, Commitment FIRST (the price tier — the quote builder's Annual (1-yr)
   / Monthly flex / One-time, priced from the catalogue for that commitment, cost from wholesale for
   the same commitment), then seats and the unit price — R-2050: ₹/user/YEAR on Annual, ₹/user/month
   on Monthly flex (the line's own rate, never below the Workspace list floor). Under the lines, Payment — how
   often an annual commitment is billed (BILLING_CYCLE_OPTIONS); Monthly flex is monthly only. */
function SaleEditor({ customerDomain, lines, catalog, gstRate, preview, payment, payCycle, onPayCycle, dueNow, laterText, onAdd, onChange, onRemove }: {
  /** R-2095: shown as each subscription line's default end-domain. */
  customerDomain: string | null;
  lines: SaleLine[];
  catalog: CatalogRow[];
  gstRate: number;
  preview: { taxable: number; gst: number; total: number };
  payment: PaymentChoice;
  payCycle: BillingCycle;
  onPayCycle: (c: BillingCycle) => void;
  dueNow: number;
  laterText: string | null;
  onAdd: (itemId: string) => void;
  onChange: (idx: number, patch: Partial<SaleLine>) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="space-y-2">
      {lines.map((l, idx) => {
        const it = l.itemId ? catalog.find((c) => c.id === l.itemId) : undefined;
        const oneTimeOnly = it ? defaultCycle(it) === "one_time" : false;
        const commits = commitmentOptions(oneTimeOnly);
        const unit = shownPriceUnit(l);
        const termWord = l.cycle === "annual_yearly" ? " a year" : l.cycle === "monthly" ? " a month" : "";
        return (
          <div key={idx} className="rounded-md border border-hairline bg-paper p-2.5 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium text-ink break-words min-w-0">{l.name}</p>
              <button type="button" onClick={() => onRemove(idx)} aria-label={`Remove ${l.name}`} className="text-ink-3 hover:text-rose shrink-0">
                <Icon name="x" size={14} />
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <label className="text-xs text-ink-3 space-y-0.5 col-span-2 sm:col-span-1">
                <span className="block">Commitment</span>
                <select
                  value={l.cycle}
                  disabled={oneTimeOnly}
                  onChange={(e) => onChange(idx, repriceLine(l, it, e.target.value as SaleCycle))}
                  aria-label="Commitment"
                  className={selectCls}
                >
                  {commits.map((c) => <option key={c.cycle} value={c.cycle}>{c.label}</option>)}
                </select>
              </label>
              <label className="text-xs text-ink-3 space-y-0.5">
                <span className="block">{l.perSeat ? "Seats (licences)" : "Quantity"}</span>
                <Input type="number" min={1} value={String(l.qty)} onChange={(e) => onChange(idx, { qty: Math.max(0, Math.round(Number(e.target.value) || 0)) })} aria-label={l.perSeat ? "Seats" : "Quantity"} />
              </label>
              <label className="text-xs text-ink-3 space-y-0.5">
                <span className="block">Unit price {unit}</span>
                <Input type="number" min={0} step="any" value={String(shownUnitPrice(l))}
                  onChange={(e) => onChange(idx, { rate: rateFromShownPrice(l, Number(e.target.value)), priceTyped: true, typedFor: l.cycle, convertedFrom: undefined })}
                  aria-label={`Unit price ${unit}`} />
              </label>
            </div>
            <TypedPriceNote line={l} onChange={(patch) => onChange(idx, patch)} />
            {/* R-2095 (Sept): Zoho bills per end-domain — a subscription line names its own; empty = the customer's. */}
            {l.cycle !== "one_time" && (
              <label className="block text-xs text-ink-3 space-y-0.5">
                <span className="block">End domain</span>
                <Input value={l.domain ?? ""} onChange={(e) => onChange(idx, { domain: e.target.value })}
                  placeholder={customerDomain ? `${customerDomain} (customer's domain)` : "example.com"} aria-label="End domain" />
                {saleLineDomainProblem(l.domain) && <span className="block text-rose-ink">{saleLineDomainProblem(l.domain)}</span>}
              </label>
            )}
            <p className="text-xs text-ink-3 tabular-nums">{l.qty} × {rupee(shownUnitPrice(l), { decimals: Number.isInteger(shownUnitPrice(l)) ? 0 : 2 })}{unit.replace(/^₹/, "")} = {rupee(l.qty * l.rate)}{termWord}</p>
          </div>
        );
      })}
      <select value="" onChange={(e) => onAdd(e.target.value)} aria-label="Add a product" className={selectCls}>
        <option value="" disabled>{lines.length ? "＋ Add another product…" : "What was sold? Select a product…"}</option>
        {catalog.map((i) => <option key={i.id} value={i.id}>{i.name}{i.vendor ? ` · ${i.vendor}` : ""}</option>)}
      </select>
      {saleTermsMixed(lines) && <p className="text-xs text-rose-ink">Flexible (monthly) cannot be on one sale with yearly or one-time products — record them as separate sales (or make them all one commitment).</p>}
      {payment.options.length > 0 && (
        <label className="block text-xs text-ink-3 space-y-0.5">
          <span className="block">Payment frequency</span>
          <select
            value={payCycle}
            disabled={payment.options.length === 1}
            onChange={(e) => onPayCycle(e.target.value as BillingCycle)}
            aria-label="Payment frequency"
            className={selectCls}
          >
            {payment.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          {payment.why && <span className="block text-ink-3">{payment.why}</span>}
        </label>
      )}
      {lines.length > 0 && (
        <p className="text-xs text-ink-2 tabular-nums">
          Taxable {rupee(preview.taxable)} · {gstRate > 0 ? `GST ${gstRate}% ${rupee(preview.gst)}` : "No GST"} · <b>Total {rupee(preview.total)}</b>
          {dueNow !== preview.total && <> · <b>Due now {rupee(dueNow)}</b> (first bill)</>}
        </p>
      )}
      {laterText && <p className="text-xs text-ink-3 tabular-nums">{laterText}</p>}
    </div>
  );
}

/* R-2025 (2): "This money came from X, not from <customer>." — one click answers it. */
type PayerAnswer = { relation: PayerRelation; note: string };
const BEHALF_RELATIONS = PAYER_RELATIONS.filter(([k]) => k !== "own_account");

function PayerWarning({ payerName, customerName, answer, onAnswer, onWrongCustomer }: {
  payerName: string;
  customerName: string;
  answer: PayerAnswer | null;
  onAnswer: (a: PayerAnswer | null) => void;
  onWrongCustomer: () => void;
}) {
  const own = answer?.relation === "own_account";
  const behalf = Boolean(answer && !own);
  const chip = (on: boolean) =>
    `rounded-md border px-2 py-1.5 text-xs font-medium text-left ${on ? "border-amber bg-amber/10 text-amber-ink" : "border-hairline bg-paper text-ink-2"}`;
  return (
    <div role="group" aria-label="Who paid" className="rounded-md border border-amber bg-amber-soft/40 p-2.5 space-y-2">
      <p className="text-xs font-medium text-amber-ink flex items-start gap-1.5">
        <Icon name="alert" size={14} className="mt-px shrink-0" />
        <span>This money came from {payerName}, not from {customerName}.</span>
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
        <button type="button" aria-pressed={own} className={chip(own)} onClick={() => onAnswer({ relation: "own_account", note: "" })}>
          Customer’s own other account
        </button>
        <button type="button" aria-pressed={behalf} className={chip(behalf)}
          onClick={() => onAnswer(behalf ? answer : { relation: "third_party", note: answer?.note ?? "" })}>
          Paid on the customer’s behalf
        </button>
        <button type="button" aria-pressed={false} className={chip(false)} onClick={onWrongCustomer}>
          Wrong customer — change
        </button>
      </div>
      {behalf && answer && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="How the payer is related">
            {BEHALF_RELATIONS.map(([k, label]) => (
              <button key={k} type="button" aria-pressed={answer.relation === k} className={chip(answer.relation === k)}
                onClick={() => onAnswer({ ...answer, relation: k })}>
                {label}
              </button>
            ))}
          </div>
          <Input value={answer.note} maxLength={500} placeholder="Note (optional) — e.g. MD's other company" aria-label="Note (optional)"
            onChange={(e) => onAnswer({ ...answer, note: e.target.value })} />
        </div>
      )}
      <p className="text-xs text-ink-3">The receipt and GST invoice stay in {customerName}&apos;s name; the payer is remembered for next time.</p>
    </div>
  );
}

/** A new sale that cannot be saved: no line, a line without product / seats / price, ₹0, mixed terms,
 *  or (R-2178) a typed price whose unit changed with the Commitment and is not yet converted or kept. */
function saleInvalidOf(lines: readonly SaleLine[], taxable: number): boolean {
  return lines.length === 0 || lines.some((l) => !l.name.trim() || !(l.qty > 0) || !(l.rate >= 0) || saleLineDomainProblem(l.domain) !== null
    || typedPriceCheck(l)?.blocksSave === true)
    || taxable <= 0 || saleTermsMixed(lines);
}

/* R-2178: a typed price is never changed by a Commitment switch. When its unit changed (₹/year ↔
   ₹/month, or to/from once) the line says so and the operator picks: convert (÷12 / ×12, undoable)
   or keep the number. Save waits for the answer. */
function TypedPriceNote({ line, onChange }: { line: SaleLine; onChange: (patch: Partial<SaleLine>) => void }) {
  const check = typedPriceCheck(line);
  if (!check) return null;
  const btn = "rounded-md border border-hairline bg-paper px-2 py-1 text-xs font-medium text-ink-2 hover:border-amber focus:outline-none focus:ring-2 focus:ring-amber/40";
  if (check.kind === "converted") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
        <span>{check.text}</span>
        <button type="button" className={btn} onClick={() => onChange(undoTypedConversion(line))}>{check.undoLabel}</button>
      </p>
    );
  }
  return (
    <div role="group" aria-label="Typed price check" className="rounded-md border border-amber bg-amber-soft/40 px-2.5 py-2 space-y-1.5">
      <p className="text-xs text-amber-ink">{check.text}</p>
      <div className="flex flex-wrap gap-2">
        {check.convertLabel && (
          <button type="button" className={btn} onClick={() => onChange(convertTypedPrice(line))}>{check.convertLabel}</button>
        )}
        <button type="button" className={btn} onClick={() => onChange(keepTypedPrice(line))}>{check.keepLabel}</button>
      </div>
    </div>
  );
}
