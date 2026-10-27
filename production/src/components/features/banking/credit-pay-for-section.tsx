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
 *            advance credit (reconcile_bank_credit_as_advance), offered on their next payment.
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
  useRelinkOneOffSale, type RelinkTarget,
} from "@/lib/queries/bank-credit-pay-for";
import {
  amountCheck, defaultCycle, defaultRenewal, guessCustomer, itemDetail, itemKey, kindLabel,
  linesAreMonthly, preselectItem, rateSuffix, repriceLine, resultLines, saleLineFromItem,
  saleMakesSubscription, salePreview, saleTermsMixed, tdsRateToRecord, tdsToRecord,
  type AmountCheck, type OldOneOffBooking, type OpenItem, type PayForResult, type SaleCycle, type SaleLine, type ShortChoice,
} from "@/lib/banking/credit-pay-for";

const NEW_CUSTOMER = "__new_customer__";

export interface PayForCustomer { id: string; name: string; country?: string | null }

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
}

type Mode = "item" | "sale" | "advance";
const MODES: ReadonlyArray<readonly [Mode, string]> = [
  ["item", "An open quote / invoice"],
  ["sale", "A new sale (no quote yet)"],
  ["advance", "Advance — nothing to invoice yet"],
];

const selectCls =
  "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";

export function CreditPayForSection({ transaction, customers, onNewCustomer, pickedCustomerId, onProjectPayment, onSaved, onDone, relink }: Props) {
  const credit = transaction.credit;

  /* ── 1. Customer ─────────────────────────────────────────────────────────────── */
  const { data: openInvoices } = useOpenInvoicesForCreditMatch(credit > 0);
  const guess = React.useMemo(() => {
    const ms = matchCreditToInvoices(
      { amount: credit, txnDate: transaction.txn_date, description: transaction.description, reference: transaction.reference },
      openInvoices ?? [],
    );
    return guessCustomer(transaction, customers, ms);
  }, [transaction, customers, openInvoices, credit]);
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

  /* ── 2. What for ─────────────────────────────────────────────────────────────── */
  const { data: items, isLoading: itemsLoading } = useBankCreditOpenItems(customerId || null);
  const [mode, setMode] = React.useState<Mode>("item");
  const [pickKey, setPickKey] = React.useState("");
  React.useEffect(() => {
    if (!items) return;
    const pre = preselectItem(items, credit);
    setPickKey(pre ? itemKey(pre) : "");
    setMode(items.length > 0 ? "item" : "sale");
  }, [items, credit]);
  const picked = (items ?? []).find((i) => itemKey(i) === pickKey) ?? null;

  /* New sale lines. */
  const { data: catalog } = useItems();
  const activeCatalog = React.useMemo(() => (catalog ?? []).filter((i) => i.is_active), [catalog]);
  const [lines, setLines] = React.useState<SaleLine[]>([]);
  React.useEffect(() => { setLines([]); }, [transaction.id]);
  const gst = useGstRegistration();
  const gstRate = billOfSupplyStatus(gst.data?.saved ?? null) || isExportSupply(customer?.country ?? null) ? 0 : 18;
  const preview = salePreview(lines, gstRate);

  /* Subscription choice (new subscription sale only). */
  const makesSub = mode === "item" ? Boolean(picked?.makes_subscription) : mode === "sale" && saleMakesSubscription(lines);
  const monthly = mode === "item" ? linesAreMonthly(picked?.lines ?? null) : lines.some((l) => l.cycle === "monthly");
  const [createSub, setCreateSub] = React.useState(true);
  const [subStart, setSubStart] = React.useState(transaction.txn_date);
  const [subRenewal, setSubRenewal] = React.useState<string | null>(null);   // null = follows the term
  React.useEffect(() => { setCreateSub(true); setSubStart(transaction.txn_date); setSubRenewal(null); }, [transaction.id, transaction.txn_date, pickKey, mode]);
  const renewalShown = subRenewal ?? defaultRenewal(subStart || transaction.txn_date, monthly);
  const datesBad = makesSub && createSub && (!subStart || renewalShown <= subStart);

  /* ── 3. Amount check ─────────────────────────────────────────────────────────── */
  /* An advance has nothing due — the whole credit is kept as the customer's credit. */
  const due = mode === "item" ? (picked?.amount_due ?? null) : mode === "sale" && preview.total > 0 ? preview.total : null;
  const taxable = mode === "item" ? (picked?.taxable_value ?? 0) : preview.taxable;
  const check: AmountCheck | null = due === null ? null : amountCheck(credit, due, taxable);
  const [shortChoice, setShortChoice] = React.useState<ShortChoice>("part");
  /* TDS pre-chosen when the gap IS a common TDS rate; else part payment. Re-decided per item. */
  const tdsLikely = check?.kind === "short" && check.tdsRatePct !== null;
  React.useEffect(() => { setShortChoice(tdsLikely ? "tds" : "part"); }, [tdsLikely, pickKey, mode]);

  /* ── 4. Save ─────────────────────────────────────────────────────────────────── */
  const payItem = usePayItemFromBankCredit();
  const newSale = useNewSaleFromBankCredit();
  const advance = useAdvanceFromBankCredit();
  const relinkSale = useRelinkOneOffSale();
  const [result, setResult] = React.useState<PayForResult | null>(null);
  React.useEffect(() => { setResult(null); }, [transaction.id]);
  const busy = payItem.isPending || newSale.isPending || advance.isPending || relinkSale.isPending;

  const tdsAmount = check ? tdsToRecord(check, shortChoice) : 0;
  const tdsRate = check ? tdsRateToRecord(check, taxable) : null;
  const saleInvalid = lines.length === 0 || lines.some((l) => !l.name.trim() || !(l.qty > 0) || !(l.rate >= 0)) || preview.taxable <= 0 || saleTermsMixed(lines);
  const canSave = Boolean(customerId) && !busy && !datesBad
    && (mode === "item" ? Boolean(picked) : mode === "sale" ? !saleInvalid : true);

  const save = async () => {
    if (!canSave) return;
    const subArgs = {
      createSubscription: makesSub ? createSub : null,
      subStart: makesSub && createSub ? subStart : null,
      subRenewal: makesSub && createSub ? subRenewal : null,
    };
    const target: RelinkTarget = mode === "item" && picked
      ? {
          path: "item", transactionId: transaction.id, quoteId: picked.quote_id, invoiceId: picked.invoice_id,
          tdsAmount, tdsRatePct: tdsRate, ...subArgs,
        }
      : mode === "sale"
        ? {
            path: "new_sale", transactionId: transaction.id, customerId, lines,
            createSubscription: subArgs.createSubscription ?? false, subStart: subArgs.subStart, subRenewal: subArgs.subRenewal,
            tdsAmount, tdsRatePct: tdsRate,
          }
        : { path: "advance", transactionId: transaction.id, customerId };
    try {
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
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {guess && customerId === guess.customerId && !touchedCustomer && (
          <p className="text-xs text-ink-3">Guessed from {guess.reason} — change it if wrong.</p>
        )}
      </div>

      {customerId && (
        <>
          {/* 2. What for */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5" role="group" aria-label="What this money is for">
            {MODES.map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={mode === k}
                onClick={() => setMode(k)}
                className={`rounded-md border px-2 py-1.5 text-xs font-medium text-left ${mode === k ? "border-amber bg-amber/10 text-amber-ink" : "border-hairline text-ink-2"}`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === "advance" ? (
            <p className="text-xs text-ink-2 bg-paper rounded-md border border-hairline px-2.5 py-2">
              The whole {rupee(credit)} is kept as {customer?.name ?? "the customer"}&apos;s advance credit, with a receipt voucher.
              Nothing is invoiced now — it is offered when you record their next payment.
            </p>
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
          ) : (
            <SaleEditor
              lines={lines}
              catalog={activeCatalog}
              gstRate={gstRate}
              preview={preview}
              onAdd={addProduct}
              onChange={setLine}
              onRemove={(idx) => setLines((ls) => ls.filter((_, i) => i !== idx))}
            />
          )}

          {/* Subscription choice — a new subscription sale only */}
          {makesSub && (mode === "sale" || picked) && (
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
                  {datesBad && <p className="text-xs text-rose-ink sm:col-span-2">The renewal date must be after the start date.</p>}
                </div>
              ) : (
                <p className="text-xs text-amber-ink">No subscription will be created. The quote will show “paid but has no subscription” with a button to create it later.</p>
              )}
            </div>
          )}

          {/* 3. Amount check */}
          {check && <AmountCheckBox check={check} credit={credit} due={due ?? 0} choice={shortChoice} onChoice={setShortChoice} />}

          <div className="flex flex-wrap gap-2">
            {/* Wraps on a phone: the quote number makes the label longer than 375px allows. */}
            <Button size="sm" variant="primary" icon="check" disabled={!canSave} loading={busy} onClick={save}
              className="whitespace-normal h-auto min-h-8 py-1.5 text-left max-w-full">

              {relink ? "Relink: " : ""}
              {mode === "item"
                ? picked ? `Record ${rupee(credit)} on ${picked.invoice_id ?? picked.quote_id} & reconcile` : "Pick what it pays"
                : mode === "sale"
                  ? `Record sale & reconcile ${rupee(credit)}`
                  : `Keep ${rupee(credit)} as advance & reconcile`}
            </Button>
            {onProjectPayment && <Button size="sm" variant="default" icon="briefcase" onClick={() => onProjectPayment(customerId)}>Project payment</Button>}
          </div>
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
          </span>
          <span className="block text-sm text-ink break-words mt-0.5">{itemDetail(item)}</span>
          <span className="block text-xs text-ink-3">Due {rupee(item.amount_due)} · {formatDate(item.doc_date)}</span>
        </span>
      </button>
    </li>
  );
}

function AmountCheckBox({ check, credit, due, choice, onChoice }: {
  check: AmountCheck; credit: number; due: number; choice: ShortChoice; onChoice: (c: ShortChoice) => void;
}) {
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
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5" role="group" aria-label="Why less was received">
        {([["tds", `TDS deducted (${rupee(check.shortBy)})`], ["part", `Part payment — ${rupee(check.shortBy)} stays due`]] as const).map(([k, label]) => (
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
      {choice === "tds" && <p className="text-xs text-ink-3">Booked as TDS receivable (section 194J) — collect the customer&apos;s Form 16A.</p>}
    </div>
  );
}

type CatalogRow = NonNullable<ReturnType<typeof useItems>["data"]>[number];

function SaleEditor({ lines, catalog, gstRate, preview, onAdd, onChange, onRemove }: {
  lines: SaleLine[];
  catalog: CatalogRow[];
  gstRate: number;
  preview: { taxable: number; gst: number; total: number };
  onAdd: (itemId: string) => void;
  onChange: (idx: number, patch: Partial<SaleLine>) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="space-y-2">
      {lines.map((l, idx) => {
        const it = l.itemId ? catalog.find((c) => c.id === l.itemId) : undefined;
        const oneTimeOnly = it ? defaultCycle(it) === "one_time" : false;
        return (
          <div key={idx} className="rounded-md border border-hairline bg-paper p-2.5 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium text-ink break-words min-w-0">{l.name}</p>
              <button type="button" onClick={() => onRemove(idx)} aria-label={`Remove ${l.name}`} className="text-ink-3 hover:text-rose shrink-0">
                <Icon name="x" size={14} />
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <label className="text-xs text-ink-3 space-y-0.5">
                <span className="block">{l.perSeat ? "Seats (licences)" : "Quantity"}</span>
                <Input type="number" min={1} value={String(l.qty)} onChange={(e) => onChange(idx, { qty: Math.max(0, Math.round(Number(e.target.value) || 0)) })} aria-label={l.perSeat ? "Seats" : "Quantity"} />
              </label>
              <label className="text-xs text-ink-3 space-y-0.5">
                <span className="block">Unit price ₹{rateSuffix(l)}</span>
                <Input type="number" min={0} value={String(l.rate)} onChange={(e) => onChange(idx, { rate: Math.max(0, Math.round(Number(e.target.value) || 0)) })} aria-label="Unit price" />
              </label>
              <label className="text-xs text-ink-3 space-y-0.5 col-span-2 sm:col-span-1">
                <span className="block">Billing</span>
                <select
                  value={l.cycle}
                  disabled={oneTimeOnly}
                  onChange={(e) => onChange(idx, repriceLine(l, it, e.target.value as SaleCycle))}
                  aria-label="Billing term"
                  className={selectCls}
                >
                  {oneTimeOnly ? <option value="one_time">One-time</option> : (
                    <>
                      <option value="annual_yearly">Yearly (1-year term)</option>
                      <option value="monthly">Monthly</option>
                      <option value="one_time">One-time</option>
                    </>
                  )}
                </select>
              </label>
            </div>
            <p className="text-xs text-ink-3 tabular-nums">{l.qty} × {rupee(l.rate)} = {rupee(l.qty * l.rate)}</p>
          </div>
        );
      })}
      <select value="" onChange={(e) => onAdd(e.target.value)} aria-label="Add a product" className={selectCls}>
        <option value="" disabled>{lines.length ? "＋ Add another product…" : "What was sold? Select a product…"}</option>
        {catalog.map((i) => <option key={i.id} value={i.id}>{i.name}{i.vendor ? ` · ${i.vendor}` : ""}</option>)}
      </select>
      {saleTermsMixed(lines) && <p className="text-xs text-rose-ink">Monthly and yearly products cannot be on one sale — record them separately.</p>}
      {lines.length > 0 && (
        <p className="text-xs text-ink-2 tabular-nums">
          Taxable {rupee(preview.taxable)} · {gstRate > 0 ? `GST ${gstRate}% ${rupee(preview.gst)}` : "No GST"} · <b>Total {rupee(preview.total)}</b>
        </p>
      )}
    </div>
  );
}
