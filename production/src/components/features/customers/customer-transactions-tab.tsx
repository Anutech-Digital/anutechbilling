/**
 * Customer → Transactions tab (moved out of customer-profile.tsx for R-2544).
 *
 * R-2544 (Pardeep, 6 Nov 2026): "payment jis invoice ke related hai uski under show honi chahiye".
 *  · All / Invoices — each invoice row carries its payments as indented child rows (receipt · method ·
 *    amount, TDS line), linked by invoice-payment-links.ts — the same links that fill
 *    invoices.paid_amount, so the children add up to what the invoice shows paid. The invoice's
 *    status says Paid / Part-paid (₹X due) / Overdue — the due is said there and nowhere else.
 *  · Money not against an invoice (advance, on-account, a quote not invoiced yet, an overpayment kept
 *    as credit) sits in one group at the end of All: "Advance / not yet against an invoice".
 *  · Payments — the flat list, plus "For" (the invoice numbers, or Advance). Quotes — unchanged.
 * Project → its invoices → their receipts (R-006) is unchanged inside All.
 */
"use client";

import * as React from "react";
import { projectQuotationView } from "@/lib/projects/quotation-view";
import { isCustomerAdvanceQuote } from "@/lib/quotes/customer-advance";
import { paymentMethodLabel } from "@/lib/payments/method-label";
import { istToday } from "@/lib/dates/ist";
import { noteTotalsByInvoice } from "@/lib/invoices/note-totals";
import { useCustomerInstalmentBillings } from "@/lib/queries/customer-instalment-links";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadErrorInline } from "@/components/shared/load-error";
import { SkeletonText } from "@/components/ui/skeleton";
import { formatDate, rupee, cn } from "@/lib/utils";
import { txnHref } from "./customer-links";
import { RecordTable, RowLink } from "./customer-record-table";
import { advanceTxnView, type AdvanceTxnCredit } from "./advance-txn";
import { PaymentTdsLine, type PaymentTds } from "./payment-tds-line";
import {
  linkPaymentsToInvoices, invoiceStatusView, forInvoicesText,
  type LinkInvoice, type LinkPayment, type PaymentShare, type InvoiceStatusView,
} from "./invoice-payment-links";

type TxnType = "Invoice" | "Payment" | "Refund" | "Quote" | "Advance" | "Project";
export type TxnFilter = "all" | "invoices" | "quotes" | "payments" | "projects";

/** A row of the flat lists (Payments / Quotes / Projects) — built by the profile. */
export interface FlatTxn {
  date: string; type: TxnType; ref: string; amount: number; status: string; href: string | null;
  payId?: string;
  /** Project receipt: the milestone invoice it paid (null = project advance). */
  projInvoiceId?: string | null;
}

type CustPayment = LinkPayment & { receipt_voucher_no?: string | null; method?: string | null };
type Quote = { id: string; invoice_id?: string | null; created_date: string; amount: number; status: string; payment_amount?: number | null };
interface ProjPayment { id: string; project_id: string; invoice_id?: string | null; received_at: string; amount: number; reference?: string | null; bank_txn_id?: string | null }
interface Project { id: string; title: string; created_at: string; total_amount: number; paid?: number | null; status: string; accepted_at?: string | null }
interface NoteRow { invoice_id: string | null; amount: number | null; status?: string | null }

export interface CustomerTransactionsTabProps {
  customerId: string;
  linkOpts: { canQuotes: boolean };
  canDeletePay: boolean;
  onDeletePayment: (id: string) => void;
  invoices: readonly LinkInvoice[];
  payments: readonly CustPayment[];
  quotes: readonly Quote[];
  projects: readonly Project[];
  projPayments: readonly ProjPayment[];
  invoiceProject: Record<string, { projectId: string }>;
  invoicePaidByProject: Record<string, number>;
  subs: readonly { id: string; quote_id: string | null }[];
  /** The customer's credit / debit notes (R-1682 useCustomerNotes) — they change what an invoice can take. */
  notes: { creditNotes: readonly NoteRow[]; debitNotes: readonly NoteRow[] };
  /** The subscriptions or the notes are still being read — the links would move once they arrive, so wait. */
  linksPending?: boolean;
  /** The notes read failed — say so (an invoice's Paid / Credited depends on them). */
  notesError?: { error: unknown; retry: () => void } | null;
  /** For the advance holder's "Available ₹X" (R-2033). */
  allPayments: readonly { id: string; quote_id?: string | null; status?: string | null; amount?: number | null }[];
  creditRows: readonly AdvanceTxnCredit[];
  tdsInfo: Record<string, PaymentTds>;
  txnFilter: TxnFilter;
  setTxnFilter: (f: TxnFilter) => void;
  segments: readonly { id: TxnFilter; label: string; n: number }[];
  filteredTxns: readonly FlatTxn[];
  hasTxns: boolean;
}

interface HRow {
  key: string; parentKey: string | null; indent: number;
  date: string; type: TxnType; ref: string; amount: number; status: string;
  href: string | null;
  payId?: string;
  /** Invoice rows: Paid / Part-paid / Overdue — coloured, not capitalised. */
  invoiceStatus?: InvoiceStatusView;
  /** Small text after the reference: method, "part of ₹X", the quote. */
  note?: string;
  /** Show the TDS line (on the payment's first row when it is split). */
  tds?: boolean;
  /** The amount the TDS line splits — the whole payment, also on a split payment's first row. */
  tdsGross?: number;
  /** A delete button deletes the WHOLE receipt — so only on a row that shows the whole receipt. */
  wholeReceipt?: boolean;
  /** The advance group's heading row. */
  group?: boolean;
}

const TXN_BADGE: Record<TxnType, "info" | "success" | "danger" | "muted" | "warning"> = {
  Invoice: "info", Payment: "success", Refund: "danger", Quote: "muted", Advance: "success", Project: "warning",
};
const STATUS_TONE: Record<InvoiceStatusView["tone"], string> = {
  paid: "text-emerald", part: "text-amber-ink", overdue: "text-rose", muted: "text-ink-3", open: "text-ink-2",
};
/** Child rows are inset 18px per level (Tailwind, no inline style). */
const INDENT = ["pl-0", "pl-[18px]", "pl-[36px]", "pl-[54px]"] as const;
export const ADVANCE_GROUP_TITLE = "Advance / not yet against an invoice";

/**
 * R-2559: a receipt's Reference — its receipt number, else the UTR / reference the user typed,
 * else `fallback`. One rule for All and Payments (Payments showed the payment's id instead of the UTR).
 */
export function paymentReference(
  p: { id: string; receipt_voucher_no?: string | null; reference?: string | null },
  fallback: string,
): string {
  return p.receipt_voucher_no?.trim() || p.reference?.trim() || fallback;
}

export function CustomerTransactionsTab(props: CustomerTransactionsTabProps) {
  const { customerId, linkOpts, canDeletePay, onDeletePayment, payments, quotes, projects, projPayments,
    invoiceProject, invoicePaidByProject, subs, tdsInfo, txnFilter, setTxnFilter, segments, filteredTxns, hasTxns } = props;
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const toggleCollapse = (key: string) => setCollapsed((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const billingsQ = useCustomerInstalmentBillings(subs.map((s) => s.id));
  const { creditNotes, debitNotes } = props.notes;
  // Credit / debit notes change what an invoice can take (R-1709 invoiceMoneyIn) — the Invoices
  // list's own per-invoice totals (lib/invoices/note-totals.ts: paise sums, void notes left out).
  const invoices = React.useMemo(() => {
    const notes = noteTotalsByInvoice(creditNotes, debitNotes);
    return props.invoices.map((i) => ({
      ...i, credit_noted: notes.get(i.id)?.credit ?? 0, debit_noted: notes.get(i.id)?.debit ?? 0,
      // A project invoice's money comes from project_payments (R-006); never less than they show.
      paid_amount: Math.max(i.paid_amount ?? 0, invoicePaidByProject[i.id] ?? 0),
    }));
  }, [props.invoices, creditNotes, debitNotes, invoicePaidByProject]);
  const links = React.useMemo(() => {
    const quoteOfSub = new Map(subs.map((s) => [s.id, s.quote_id] as const));
    const instalments = (billingsQ.data ?? []).map((b) => ({ invoice_id: b.invoice_id, quote_id: quoteOfSub.get(b.subscription_id) ?? null }));
    return linkPaymentsToInvoices({ invoices, payments, quotes, instalments });
  }, [invoices, payments, quotes, subs, billingsQ.data]);

  const today = istToday();
  const payById = new Map(payments.map((p) => [p.id, p]));
  const quoteById = new Map(quotes.map((q) => [q.id, q]));
  const isHolder = (quoteId: string | null) => !!quoteId && isCustomerAdvanceQuote(quoteById.get(quoteId));

  const shareRow = (s: PaymentShare, parentKey: string, indent: number): HRow => {
    const p = payById.get(s.paymentId)!;
    const refunded = p.status === "refunded";
    const notes = [p.method ? paymentMethodLabel(p.method) : null, s.whole ? null : `part of ${rupee(s.paymentAmount)}`,
      !s.invoiceId && s.quoteId && !isHolder(s.quoteId) ? `Quote ${s.quoteId}` : null].filter(Boolean);
    return {
      key: `cpay:${p.id}:${s.invoiceId ?? "adv"}`, parentKey, indent,
      date: refunded ? (p.refunded_at ?? p.received_at) : p.received_at, type: refunded ? "Refund" : "Payment",
      ref: paymentReference(p, "Receipt"), amount: s.amount, status: p.status,
      payId: p.id, note: notes.join(" · ") || undefined, tds: s.first, tdsGross: s.paymentAmount, wholeReceipt: s.whole,
      href: txnHref({ kind: "payment", quoteId: p.quote_id, customerId }, linkOpts),
    };
  };
  /** A project milestone receipt (project_payments) — under its invoice, or under the project as an advance. */
  const projectReceiptRow = (p: ProjPayment, parentKey: string, indent: number): HRow => ({
    key: `pay:${p.id}`, parentKey, indent, date: p.received_at, type: "Payment",
    ref: p.reference?.trim() || (p.invoice_id ? "Payment" : "Advance"), amount: p.amount,
    status: p.bank_txn_id ? "reconciled" : "received",
    href: txnHref({ kind: "projectPayment", invoiceId: p.invoice_id ?? null, projectId: p.project_id }, linkOpts),
  });
  const byDate = (a: { date: string }, b: { date: string }) => (a.date ?? "").localeCompare(b.date ?? "");

  /** An invoice row and its payments (customer receipts + project receipts), oldest payment first. */
  const invoiceBlock = (i: LinkInvoice, parentKey: string | null, indent: number): HRow[] => {
    const key = `inv:${i.id}`;
    const view = invoiceStatusView(i, today);
    const kids: HRow[] = (links.byInvoice[i.id] ?? []).map((s) => shareRow(s, key, indent + 1));
    for (const p of projPayments.filter((pp) => pp.invoice_id === i.id)) kids.push(projectReceiptRow(p, key, indent + 1));
    return [
      { key, parentKey, indent, date: i.invoice_date, type: "Invoice", ref: i.id, amount: i.amount, status: view.label, invoiceStatus: view, href: txnHref({ kind: "invoice", invoiceId: i.id }, linkOpts) },
      ...kids.sort(byDate),
    ];
  };
  const newestFirst = (a: HRow[], b: HRow[]) => (b[0].date ?? "").localeCompare(a[0].date ?? "");

  let rows: HRow[];
  if (txnFilter === "all" || txnFilter === "invoices") {
    const blocks: HRow[][] = [];
    if (txnFilter === "invoices") {
      for (const i of invoices) blocks.push(invoiceBlock(i, null, 0));
    } else {
      const shownProjects = new Set(projects.map((pr) => pr.id));
      for (const pr of projects) {
        const projKey = `proj:${pr.id}`;
        const projDue = Math.max(0, (pr.total_amount ?? 0) - (pr.paid ?? 0));
        const block: HRow[] = [{ key: projKey, parentKey: null, indent: 0, date: pr.created_at, type: "Project", ref: pr.title, amount: pr.total_amount, status: projectQuotationView(pr.status, pr.accepted_at ?? null).label + (projDue > 0 ? ` (${rupee(projDue)} due)` : ""), href: txnHref({ kind: "project", projectId: pr.id }, linkOpts) }];
        for (const i of invoices.filter((iv) => invoiceProject[iv.id]?.projectId === pr.id)) block.push(...invoiceBlock(i, projKey, 1));
        // Advance receipts recorded before their milestone was invoiced.
        for (const p of projPayments.filter((pp) => pp.project_id === pr.id && !pp.invoice_id)) block.push(projectReceiptRow(p, projKey, 1));
        blocks.push(block);
      }
      // Any invoice no project block shows (not a project invoice, or its project is not loaded) stands alone.
      for (const i of invoices.filter((iv) => !shownProjects.has(invoiceProject[iv.id]?.projectId ?? ""))) blocks.push(invoiceBlock(i, null, 0));
      for (const q of quotes.filter((qq) => !isCustomerAdvanceQuote(qq))) {
        blocks.push([{ key: `q:${q.id}`, parentKey: null, indent: 0, date: q.created_date, type: "Quote", ref: q.id, amount: q.amount, status: q.status, href: txnHref({ kind: "quote", quoteId: q.id }, linkOpts) }]);
      }
    }
    rows = blocks.sort(newestFirst).flat();
    if (txnFilter === "all") rows.push(...advanceGroup());
  } else {
    rows = filteredTxns.map((t, n) => ({ key: `flat:${n}`, parentKey: null, indent: 0, wholeReceipt: true, ...t }));
  }

  /** The advance group: money not against any invoice. An advance holder (R-1863) is one row with its receipts under it. */
  function advanceGroup(): HRow[] {
    const gKey = "group:advance";
    const kids: HRow[] = links.unlinked.filter((s) => !isHolder(s.quoteId)).map((s) => shareRow(s, gKey, 1));
    for (const q of quotes.filter((qq) => isCustomerAdvanceQuote(qq))) {
      const v = advanceTxnView(q, props.allPayments, props.creditRows);
      if (!v) continue;
      const qKey = `q:${q.id}`;
      kids.push({ key: qKey, parentKey: gKey, indent: 1, date: q.created_date, type: "Advance", ref: q.id, amount: v.amount, status: v.status, href: txnHref({ kind: "quote", quoteId: q.id }, linkOpts) });
      // Its receipts, right under it (TDS line, delete) — the holder row says what is still available.
      kids.push(...links.unlinked.filter((s) => s.quoteId === q.id).map((s) => shareRow(s, qKey, 2)).sort(byDate));
    }
    if (kids.length === 0) return [];
    // No total on the heading: an advance may be partly used already — each row says what is left.
    return [{ key: gKey, parentKey: null, indent: 0, date: "", type: "Advance", ref: ADVANCE_GROUP_TITLE, amount: 0, status: "", href: null, group: true }, ...kids];
  }

  const parentOf: Record<string, string | null> = {};
  const hasKids = new Set<string>();
  for (const r of rows) { parentOf[r.key] = r.parentKey; if (r.parentKey) hasKids.add(r.parentKey); }
  const nested = txnFilter === "all" || txnFilter === "invoices";
  const visible = nested
    ? rows.filter((r) => { let pk = r.parentKey; while (pk) { if (collapsed.has(pk)) return false; pk = parentOf[pk] ?? null; } return true; })
    : rows;
  const showFor = txnFilter === "payments";
  const forText = (t: HRow & Partial<FlatTxn>) =>
    t.type === "Advance" ? "Advance"
    : t.payId ? forInvoicesText(links.forOf[t.payId])
    : t.projInvoiceId !== undefined ? (t.projInvoiceId ?? "Advance") : "—";

  const loadingTxns = <div role="status" aria-label="Loading transactions" className="py-2"><SkeletonText lines={4} /></div>;
  /* R-2559: the reads are still on their way — wait rather than say "No transactions yet" first. */
  if (!hasTxns && props.linksPending) return loadingTxns;
  if (!hasTxns) return <EmptyState icon="receipt" title="No transactions yet" body="Quotes, invoices and payments for this customer will appear here." compact />;
  return (
    <>
      {/* Segment filter — invoices / quotes / payments each on their own. */}
      <div className="flex flex-wrap gap-2 mb-4">
        {segments.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={txnFilter === s.id}
            onClick={() => setTxnFilter(s.id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
              txnFilter === s.id ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2",
            )}
          >
            {s.label}
            <span className={cn("tabular-nums", txnFilter === s.id ? "text-amber-ink" : "text-ink-3")}>{s.n}</span>
          </button>
        ))}
      </div>
      {billingsQ.isError && (
        <LoadErrorInline what="Subscription instalments" error={billingsQ.error} onRetry={() => void billingsQ.refetch()} />
      )}
      {props.notesError && (
        <LoadErrorInline what="Credit / debit notes" error={props.notesError.error} onRetry={props.notesError.retry} />
      )}
      {(props.linksPending || billingsQ.isLoading) && txnFilter !== "quotes" ? (
        // Until the subscriptions, their instalment links and the notes are read, a receipt would sit under
        // "Advance" (or say "Advance" in For) for a moment and then jump — so the lists wait.
        loadingTxns
      ) : visible.length > 0 ? (
        <RecordTable
          head={showFor ? ["Date", "Type", "Reference", "For", "Amount", "Status", ""] : ["Date", "Type", "Reference", "Amount", "Status", ""]}
          rows={visible.map((t) => {
            const canExpand = nested && hasKids.has(t.key);
            const isCollapsed = collapsed.has(t.key);
            const payId = t.payId;
            const cells: React.ReactNode[] = [
              t.date ? formatDate(t.date) : "",
              <Badge key="ty" kind={TXN_BADGE[t.type]} dot>{t.type}</Badge>,
              // Children are inset under their parent; parents get a chevron to fold them.
              <span key="r" className={cn("text-xs inline-flex items-center gap-1 max-w-[340px]", INDENT[Math.min(t.indent, INDENT.length - 1)])}>
                {canExpand ? (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleCollapse(t.key); }}
                    className="-ml-1 p-0.5 rounded hover:bg-paper-2 text-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                    aria-label={isCollapsed ? "Expand" : "Collapse"}
                    aria-expanded={!isCollapsed}
                  >
                    <Icon name={isCollapsed ? "chevron_right" : "chevron_down"} size={13} />
                  </button>
                ) : t.indent > 0 ? <span aria-hidden className="text-ink-3">↳</span> : null}
                {t.group
                  ? <span className="font-semibold text-ink">{t.ref}</span>
                  : <span className="font-mono"><RowLink href={t.href}>{t.ref}</RowLink></span>}
                {t.note ? <span className="text-3xs text-ink-3 truncate">· {t.note}</span> : null}
              </span>,
            ];
            if (showFor) cells.push(<span key="for" className="font-mono text-xs text-ink-2">{forText(t)}</span>);
            cells.push(
              // The advance group's heading carries no amount: an advance may be partly used already —
              // each row under it says what is left.
              t.group ? <span key="a" /> : (
                <span key="a" className="inline-flex flex-col">
                  <span className={cn("tabular-nums", t.indent === 0 ? "font-semibold" : "font-medium text-ink-2")}>{rupee(t.amount)}</span>
                  {t.type === "Payment" && payId && (t.tds ?? true) ? <PaymentTdsLine amount={t.tdsGross ?? t.amount} tds={tdsInfo[payId]} /> : null}
                </span>
              ),
              t.invoiceStatus
                ? <span key="s" className={cn("font-medium", STATUS_TONE[t.invoiceStatus.tone])}>{t.status}</span>
                : <span key="s" className="text-ink-2 capitalize">{t.status}</span>,
              // Delete — only on payments from the `payments` table, and only on a row showing the whole
              // receipt (a "part of ₹X" row would delete all of it; the Payments tab lists it whole).
              payId && canDeletePay && t.wholeReceipt ? (
                <IconButton key="del" icon="trash" size="sm" variant="ghost" aria-label="Delete payment" title="Delete this payment"
                  onClick={(e) => { e.stopPropagation(); onDeletePayment(payId); }} />
              ) : <span key="del" />,
            );
            return { href: t.href, label: `Open ${t.type.toLowerCase()} ${t.ref}`, cells };
          })}
        />
      ) : (
        <EmptyState icon="receipt" title="Nothing here" body="No records of this type for this customer." compact />
      )}
    </>
  );
}
