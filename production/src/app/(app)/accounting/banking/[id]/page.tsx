/**
 * Bank account detail — transactions list + reconcile actions.
 *
 * Per-account view showing every imported/manual transaction with its
 * reconciliation state. Operator can:
 *   • Filter by status (all / matched / unmatched / overdue)
 *   • Import a new statement (CSV/Excel) — opens the import drawer
 *   • Reconcile each unmatched row against a payment / expense / vendor bill
 *
 * The match-suggestion popover (server-computed via the
 * suggest_bank_transaction_matches RPC) shows the top 3-5 nearest
 * candidates by amount + date proximity so the operator just clicks
 * "Match" — they don't have to search.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useResizableColumns, ResizableHandles } from "@/components/ui/resizable-columns";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import {
  useBankAccount,
  useBankTransactions,
  useReconcileTransaction,
  useAutoReconcile,
  type BankTransactionRow,
} from "@/lib/queries/bank";
import { rupee, formatDate } from "@/lib/utils";
import { ImportStatementDialog } from "@/components/features/banking/import-statement-dialog";
import { ReconcileTransactionDialog } from "@/components/features/banking/reconcile-transaction-dialog";
import { ConnectAaDialog } from "@/components/features/banking/connect-aa-dialog";
import { useBankAaConnection, useFetchAaNow } from "@/lib/queries/bank-aa";

type FilterTab = "all" | "unmatched" | "matched";

// Column order (left→right) + default widths (px) for the resizable table.
// Status is folded into the last column: an unmatched row just shows the
// "Reconcile" button (so "Unmatched" is implied — no separate column needed);
// a reconciled row shows WHAT it matched (green pill) + "Un-reconcile". That
// frees a whole column for the description + amounts.
const BANK_COL_ORDER = ["date", "description", "nikasi", "jama", "reconcile"];
// Widths tuned to fit a laptop content area WITHOUT a horizontal scrollbar
// (≈830px total). Description flexes widest; users can still drag any column.
const BANK_COL_DEFAULTS: Record<string, number> = {
  date: 118, description: 340, nikasi: 116, jama: 116, reconcile: 140,
};

export default function BankAccountDetailPage() {
  const params = useParams<{ id: string }>();
  const accountId = params?.id ?? null;

  const { data: account,      isLoading: accLoading } = useBankAccount(accountId);
  const { data: transactions, isLoading: txnLoading } = useBankTransactions(accountId);
  const autoReconcile = useAutoReconcile();

  const [tab,           setTab]           = React.useState<FilterTab>("all");
  const [search,        setSearch]        = React.useState("");
  const [importOpen,    setImportOpen]    = React.useState(false);
  const [aaConnectOpen, setAaConnectOpen] = React.useState(false);
  const [reconcileTxn,  setReconcileTxn]  = React.useState<BankTransactionRow | null>(null);

  // Resizable columns — drag the full-height divider between any two columns.
  const { colW, startResize, totalWidth: bankTableW } = useResizableColumns("ros_bank_colw_v3", BANK_COL_DEFAULTS);

  // AA connection state (returns null if not connected yet)
  const { data: aaConn } = useBankAaConnection(accountId);
  const fetchAa = useFetchAaNow();

  // Tab counts
  const counts = React.useMemo(() => {
    const all       = transactions?.length ?? 0;
    const matched   = transactions?.filter((t) => t.matched_to_type !== null).length ?? 0;
    const unmatched = all - matched;
    return { all, unmatched, matched };
  }, [transactions]);

  const tabs: TabBarItem[] = [
    { id: "all",       label: "All",        count: counts.all       },
    { id: "unmatched", label: "Unmatched",  count: counts.unmatched },
    { id: "matched",   label: "Reconciled", count: counts.matched   },
  ];

  const visibleTxns = React.useMemo(() => {
    if (!transactions) return [];
    let list = transactions;
    if (tab === "unmatched") list = list.filter((t) => t.matched_to_type === null);
    else if (tab === "matched") list = list.filter((t) => t.matched_to_type !== null);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((t) =>
      [t.description, t.reference, String(t.debit ?? ""), String(t.credit ?? "")]
        .some((f) => (f ?? "").toString().toLowerCase().includes(q)));
    return list;
  }, [transactions, tab, search]);

  // Deep-link from elsewhere (e.g. Payroll "Reconcile in Banking →"):
  //   ?focus=<txnId>   → open that transaction's reconcile
  //   ?match=<amount>  → open the matching unmatched debit's reconcile
  // Runs once, after transactions load; cleans the URL so a refresh won't repeat.
  const focusedRef = React.useRef(false);
  React.useEffect(() => {
    if (focusedRef.current || !transactions || transactions.length === 0) return;
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const focus = sp.get("focus");
    const match = sp.get("match");
    if (!focus && !match) return;
    focusedRef.current = true;
    let target: BankTransactionRow | undefined;
    if (focus) target = transactions.find((t) => t.id === focus);
    else if (match) {
      const amt = Math.round(Number(match));
      target = transactions.find((t) => t.matched_to_type === null && (t.debit ?? 0) === amt)
            ?? transactions.find((t) => t.matched_to_type === null && (t.credit ?? 0) === amt);
    }
    setTab("unmatched");
    if (target) setReconcileTxn(target);
    else toast("Us amount ki koi unmatched bank line nahi mili — neeche se manually reconcile karo.");
    window.history.replaceState(null, "", window.location.pathname);
  }, [transactions]);

  if (accLoading) {
    return <div className="p-8"><Skeleton className="h-32" /></div>;
  }
  if (!account) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <Card>
          <EmptyState
            icon="alert"
            title="Bank account not found."
            body="It may have been removed, or the link is broken."
            action={<Link href={"/accounting/banking" as never}><Button variant="primary">Back to Banking</Button></Link>}
          />
        </Card>
      </div>
    );
  }

  // Two balances for reconciliation:
  //  • Bank    = opening + every imported statement line (what the bank shows)
  //  • App     = opening + only the RECONCILED lines (what your books account for)
  //  • The gap = the still-unreconciled lines. When all are matched, they're equal.
  const openingBal = account.opening_balance ?? 0;
  const allTxns    = transactions ?? [];
  const sumDelta   = (list: typeof allTxns) => list.reduce((s, t) => s + (t.credit ?? 0) - (t.debit ?? 0), 0);
  const bankBalance = openingBal + sumDelta(allTxns);
  const appBalance  = openingBal + sumDelta(allTxns.filter((t) => t.matched_to_type !== null));
  const toReconcile = bankBalance - appBalance;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <Link
            href={"/accounting/banking" as never}
            className="text-xs text-ink-3 hover:text-ink-2 inline-flex items-center gap-1 mb-1"
          >
            <Icon name="arrow_left" size={11} /> All accounts
          </Link>
          <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
            {account.bank_name}
          </p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">{account.name}</h1>
          <p className="text-xs text-ink-3 font-mono mt-1">
            {account.account_type === "cash"
              ? "Cash in hand · petty cash"
              : [account.account_number_last4 && `••• ${account.account_number_last4}`, account.ifsc, account.account_type]
                  .filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {aaConn?.status === "active" ? (
            <Button
              variant="default"
              icon="refresh"
              loading={fetchAa.isPending}
              onClick={() => fetchAa.mutate({ connection_id: aaConn.id })}
            >
              Sync via AA
            </Button>
          ) : (
            <Button variant="default" icon="link" onClick={() => setAaConnectOpen(true)}>
              {aaConn?.status === "pending_approval" ? "Approval pending…" : "Connect bank (AA)"}
            </Button>
          )}
          <Button variant="primary" icon="upload" onClick={() => setImportOpen(true)}>
            Import statement
          </Button>
        </div>
      </div>

      {/* AA status strip (only when a connection exists) */}
      {aaConn && (
        <div className="mb-4 rounded-md border border-hairline bg-paper-2/40 px-4 py-2.5 flex items-center gap-3 flex-wrap text-[12px]">
          <Badge
            kind={aaConn.status === "active" ? "success" : aaConn.status === "pending_approval" ? "warning" : "muted"}
            size="sm"
            dot
          >
            {aaConn.status === "active" ? "Auto-sync via AA" :
             aaConn.status === "pending_approval" ? "Pending approval" :
             aaConn.status}
          </Badge>
          <span className="text-ink-3 font-mono">{aaConn.vua}</span>
          {aaConn.last_fetch_at && (
            <span className="text-ink-3">
              Last sync: {formatDate(aaConn.last_fetch_at)} · {aaConn.last_fetch_count} new
            </span>
          )}
        </div>
      )}

      {/* Balance summary */}
      <Card className="mb-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Balance in bank</p>
            <p className={`font-serif text-2xl mt-1 ${bankBalance >= 0 ? "text-ink" : "text-rose"}`}>
              {rupee(bankBalance)}
            </p>
            <p className="text-[10px] text-ink-3 mt-0.5">Per imported statement</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Balance in app</p>
            <p className={`font-serif text-2xl mt-1 ${appBalance >= 0 ? "text-ink" : "text-rose"}`}>
              {rupee(appBalance)}
            </p>
            <p className="text-[10px] text-ink-3 mt-0.5">Reconciled in your books</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Opening balance</p>
            <p className="font-serif text-2xl text-ink-2 mt-1">{rupee(account.opening_balance)}</p>
            <p className="text-[10px] text-ink-3 mt-0.5">as of {formatDate(account.opening_balance_date)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">To reconcile</p>
            <p className={`font-serif text-2xl mt-1 ${counts.unmatched > 0 ? "text-rose" : "text-emerald"}`}>
              {counts.unmatched === 0 ? "✓" : rupee(toReconcile)}
            </p>
            <p className="text-[10px] text-ink-3 mt-0.5">
              {counts.unmatched === 0 ? "Bank = app, all reconciled" : `${counts.unmatched} txns not yet in books`}
            </p>
          </div>
        </div>
      </Card>

      {/* Filter tabs + one-tap auto-reconcile */}
      <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
        <TabBar items={tabs} value={tab} onChange={(v) => setTab(v as FilterTab)} />
        {counts.unmatched > 0 && (
          <Button
            icon="sparkles"
            variant="default"
            loading={autoReconcile.isPending}
            onClick={() => autoReconcile.mutate(account.id)}
            title="Auto-match every unmatched line to its expense / salary / payment where the match is unambiguous"
          >
            {autoReconcile.isPending ? "Matching…" : `Auto-reconcile (${counts.unmatched})`}
          </Button>
        )}
      </div>

      {/* Search transactions */}
      <div className="mb-3 relative">
        <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search transactions — description, reference or amount…"
          aria-label="Search transactions"
          className="w-full pl-8 pr-8 py-2 text-sm rounded-md border border-hairline bg-paper focus:outline-none focus:border-hairline-strong"
        />
        {search && (
          <button type="button" onClick={() => setSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink" aria-label="Clear search">
            <Icon name="x" size={14} />
          </button>
        )}
      </div>

      {/* Transactions list */}
      {txnLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}
        </div>
      ) : visibleTxns.length === 0 ? (
        <Card>
          <EmptyState
            icon={tab === "unmatched" ? "check_circle" : "upload"}
            title={
              tab === "unmatched"  ? "All transactions reconciled ✓" :
              tab === "matched"    ? "No reconciled transactions yet." :
                                     "No transactions yet."
            }
            body={
              counts.all === 0
                ? "Import a bank statement CSV to populate this account. Most Indian banks let you download a 30-day or 90-day statement from net banking."
                : tab === "unmatched"
                  ? "Every transaction has been matched to a payment, expense, or marked as reconciled."
                  : "Matched transactions will appear here after you reconcile."
            }
            action={
              counts.all === 0
                ? <Button variant="primary" icon="upload" onClick={() => setImportOpen(true)}>Import statement</Button>
                : undefined
            }
          />
        </Card>
      ) : (
        <>
          {/* Desktop / tablet table — every column is drag-resizable. Grab the
              full-height divider between any two columns and drag; widen
              Description to read a full transaction line. Container scrolls if the
              table grows past it; widths are remembered per device. */}
          <Card flush className="hidden lg:block">
            {/* Viewport-capped scroller so BOTH scrollbars sit inside the visible
                frame — the horizontal bar is reachable without scrolling the whole
                page to the bottom. Sticky header stays put while rows scroll. */}
            <div className="overflow-auto max-h-[calc(100vh-24rem)]">
            <div className="relative" style={{ width: bankTableW }}>
              <table className="text-sm table-fixed w-full">
                <colgroup>
                  {BANK_COL_ORDER.map((id) => <col key={id} style={{ width: colW[id] }} />)}
                </colgroup>
                <thead className="[&>tr>th]:sticky [&>tr>th]:top-0 [&>tr>th]:z-10 [&>tr>th]:bg-paper-2">
                  <tr className="border-b border-hairline text-left text-[11px] uppercase tracking-wider text-ink-3">
                    <th className="px-4 py-2 font-semibold whitespace-nowrap">Date</th>
                    <th className="px-4 py-2 font-semibold whitespace-nowrap">Description</th>
                    <th className="px-4 py-2 font-semibold text-right whitespace-nowrap">Nikasi (Dr.)</th>
                    <th className="px-4 py-2 font-semibold text-right whitespace-nowrap">Jama (Cr.)</th>
                    <th className="px-4 py-2 font-semibold text-right whitespace-nowrap">Reconcile</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTxns.map((txn) => (
                    <TransactionRow
                      key={txn.id}
                      txn={txn}
                      onReconcile={() => setReconcileTxn(txn)}
                    />
                  ))}
                </tbody>
              </table>
              <ResizableHandles colW={colW} order={BANK_COL_ORDER} startResize={startResize} />
            </div>
            </div>
          </Card>

          {/* Card list on phone + narrow/tablet widths (table needs ≥1024px to
              show every column + the Reconcile button without clipping). */}
          <ul className="lg:hidden space-y-2.5">
            {visibleTxns.map((txn) => (
              <TransactionCard key={txn.id} txn={txn} onReconcile={() => setReconcileTxn(txn)} />
            ))}
          </ul>
        </>
      )}

      <ImportStatementDialog open={importOpen} onOpenChange={setImportOpen} accountId={account.id} />
      <ConnectAaDialog
        open={aaConnectOpen}
        onOpenChange={setAaConnectOpen}
        bankAccountId={account.id}
        bankName={account.bank_name}
      />
      <ReconcileTransactionDialog
        open={Boolean(reconcileTxn)}
        onOpenChange={(o) => !o && setReconcileTxn(null)}
        transaction={reconcileTxn}
      />
    </div>
  );
}

// ============================================================
// Shared bits (used by both the desktop row and the mobile card)
// ============================================================
function TxnAmount({ txn }: { txn: BankTransactionRow }) {
  if (txn.debit > 0)  return <span className="text-rose">-{rupee(txn.debit)}</span>;
  if (txn.credit > 0) return <span className="text-emerald">+{rupee(txn.credit)}</span>;
  return <span className="text-ink-3">—</span>;
}

function txnStatusLabel(t: BankTransactionRow["matched_to_type"]): string {
  return t === "payment"     ? "Payment" :
         t === "expense"     ? "Expense" :
         t === "vendor_bill" ? "Bill"    :
         t === "transfer"    ? "Inter-account" :
         t === "split"       ? "Salaries" :
         t                   ? "Reconciled" : "Unmatched";
}

function TxnStatusBadge({ txn }: { txn: BankTransactionRow }) {
  return txn.matched_to_type
    ? <Badge kind="success" size="sm" dot>{txnStatusLabel(txn.matched_to_type)}</Badge>
    : <Badge kind="warning" size="sm" dot>Unmatched</Badge>;
}

// ============================================================
// Row (desktop)
// ============================================================
function TransactionRow({
  txn,
  onReconcile,
}: {
  txn: BankTransactionRow;
  onReconcile: () => void;
}) {
  const reconcile = useReconcileTransaction();

  return (
    <tr className="border-b border-hairline last:border-b-0 hover:bg-paper-2/30">
      <td className="px-4 py-3 text-ink-2 whitespace-nowrap truncate">
        {formatDate(txn.txn_date)}
      </td>
      <td className="px-4 py-3 align-top">
        {/* Wrap (not truncate) so the full narration is readable at the default
            width — no need to widen the column and push other columns off. */}
        <div className="font-medium text-ink break-words leading-snug">{txn.description}</div>
        {txn.reference && (
          <div className="text-[10px] text-ink-3 font-mono mt-0.5 break-all">{txn.reference}</div>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium text-rose">
        {txn.debit > 0 ? rupee(txn.debit) : <span className="text-ink-4">—</span>}
      </td>
      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium text-emerald">
        {txn.credit > 0 ? rupee(txn.credit) : <span className="text-ink-4">—</span>}
      </td>
      <td className="px-4 py-3 text-right">
        {txn.matched_to_type === "transfer" ? (
          // Inter-account transfers are auto-reconciled self-balancing pairs —
          // un-reconciling one leg would orphan it, so no action here.
          <div className="flex flex-col items-end gap-0.5">
            <Badge kind="success" size="sm" dot>Inter-account</Badge>
            <span className="text-[10px] text-ink-3">Auto</span>
          </div>
        ) : txn.matched_to_type ? (
          // Reconciled: show WHAT it matched (this replaces the Status column)
          // plus a quiet way to undo it.
          <div className="flex flex-col items-end gap-0.5">
            <Badge kind="success" size="sm" dot>{txnStatusLabel(txn.matched_to_type)}</Badge>
            <button
              type="button"
              onClick={() => reconcile.mutate({ transactionId: txn.id, matchedToType: null, matchedToId: null })}
              className="text-[10px] text-ink-3 hover:text-rose"
              disabled={reconcile.isPending}
            >
              Un-reconcile
            </button>
          </div>
        ) : (
          // Unmatched: the button alone conveys the status.
          <Button size="sm" variant="default" onClick={onReconcile} disabled={reconcile.isPending}>
            Reconcile
          </Button>
        )}
      </td>
    </tr>
  );
}

// ============================================================
// Card (mobile)
// ============================================================
function TransactionCard({ txn, onReconcile }: { txn: BankTransactionRow; onReconcile: () => void }) {
  const reconcile = useReconcileTransaction();
  return (
    <li>
      <Card className="p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium leading-snug text-ink break-words">{txn.description}</div>
            <div className="mt-0.5 text-[11px] text-ink-3">
              {formatDate(txn.txn_date)}
              {txn.reference ? <span className="font-mono"> · {txn.reference}</span> : ""}
            </div>
          </div>
          <div className="shrink-0 text-right font-serif text-base tabular-nums">
            <TxnAmount txn={txn} />
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <TxnStatusBadge txn={txn} />
          {txn.matched_to_type === "transfer" ? (
            <span className="text-[11px] text-ink-3">Auto</span>
          ) : txn.matched_to_type ? (
            <button
              type="button"
              onClick={() => reconcile.mutate({ transactionId: txn.id, matchedToType: null, matchedToId: null })}
              disabled={reconcile.isPending}
              className="text-xs text-ink-3 hover:text-rose"
            >
              Un-reconcile
            </button>
          ) : (
            <Button size="sm" variant="default" onClick={onReconcile} disabled={reconcile.isPending}>
              Reconcile
            </Button>
          )}
        </div>
      </Card>
    </li>
  );
}
