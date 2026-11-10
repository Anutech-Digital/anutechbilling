/**
 * Bank account detail — transactions list + reconcile actions.
 *
 * Per-account view showing every imported/manual transaction with its
 * reconciliation state. Operator can:
 *   • Filter (R-1869): status, money in / out, date, amount, matched to, needs attention,
 *     statement file; sort, search, totals and Export CSV — state in the URL query
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
import { LoadError } from "@/components/shared/load-error";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import {
  useBankAccount,
  useBankTransactions,
  useAutoReconcile,
  useOpenInvoicesForCreditMatch,
  type BankTransactionRow,
} from "@/lib/queries/bank";
import { certainOf, invoiceMatchesOfCredits, type InvoiceMatch } from "@/lib/banking/invoice-credit-match";
import { noCustomerYet } from "@/lib/banking/no-customer-yet";
import { createLineMemo } from "@/lib/banking/line-memo";
import type { OldOneOffBooking } from "@/lib/banking/credit-pay-for";
import { useOldOneOffBookings } from "@/lib/queries/bank-credit-pay-for";
import { useDrawnBadges, useMountWhenIdle } from "./use-drawn-lines";
import type { SplitLinePayment } from "@/lib/banking/bank-row-label";
import { BookingParty, LineNotes, MatchedBadge, TxnStatusBadge } from "@/components/features/banking/bank-line-status";
import { useCustomers } from "@/lib/queries/customers";
import { usePayerMemory } from "@/lib/queries/customer-payers";
import { RelinkOneOffDialog } from "@/components/features/banking/old-one-off-bookings";
import { InvoiceMatchChip } from "@/components/features/banking/invoice-match-chip";
import { RemittanceText } from "@/components/features/banking/remittance-text";
import { rupee, formatDate } from "@/lib/utils";
import { ImportStatementDialog } from "@/components/features/banking/import-statement-dialog";
import { SalaryLinesDialog, salaryLinesOf } from "@/components/features/banking/salary-lines-dialog";
import { BulkExpenseButton } from "@/components/features/banking/bulk-expense-sheet";
import { StatementCheckCard } from "@/components/features/banking/statement-check-card";
import { AutoReconcileResult } from "@/components/features/banking/auto-reconcile-result";
import { BankImportsSection } from "@/components/features/banking/bank-imports-section";
import { checkStatement } from "@/lib/banking/statement-check";
import { ReconcileTransactionDialog } from "@/components/features/banking/reconcile-transaction-dialog";
import { UnreconcileDialog } from "@/components/features/banking/unreconcile-dialog";
import { ConnectAaDialog } from "@/components/features/banking/connect-aa-dialog";
import { ViewOnlyNote } from "@/components/shared/view-only-note";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canWriteMoney } from "@/lib/nav";
import { useBankAaConnection, useFetchAaNow } from "@/lib/queries/bank-aa";
import { useBankImportHistory } from "@/lib/queries/bank";
import { importKey, linesOfImport } from "@/lib/banking/import-history";
import {
  DEFAULT_FILTERS,
  PAGE_SIZE,
  applyBankFilters,
  bankLinesCsv,
  clearFilters,
  facetCounts,
  filterTotals,
  filtersFromQuery,
  filtersToQuery,
  hasAnyFilter,
  readsLineBooking,
  type BankFilters,
  type FilterContext,
  type NeedKey,
  type StatusFilter,
} from "@/lib/banking/bank-filters";
import { reconcileCoverage } from "@/lib/banking/reconcile-coverage";
import { balanceText, bankBalanceOf, countsAfterOpening, runningBalances, type RunningBalance } from "@/lib/banking/running-balance";
import { RunningBalanceText } from "./running-balance-text";
import { OpeningBalanceTile } from "./opening-history-note";
import { revealTxn } from "@/lib/banking/txn-deep-link";
import { guessVendor, type VendorLite } from "@/lib/banking/debit-pay-for";
import { useVendors } from "@/lib/queries/vendors";
import { useTxnCategoryRules } from "@/lib/queries/txn-category-rules";
import { useVendorNarrationAliases } from "@/lib/queries/bank-debit-pay-for";
import { BankFilterBar, type ImportOption } from "@/components/features/banking/bank-filter-bar";
import { useZohoMatchSet } from "@/components/features/banking/use-zoho-match-count";
import { ReconcileCoverageTile } from "@/components/features/banking/reconcile-coverage-tile";
import { lineNoteLines, useOwnerBookingNotes, type LineNoteLines } from "@/lib/banking/manual-reconcile";
import { useLineBookings, type LineBooking } from "@/lib/banking/line-booking";
import { downloadCSV } from "@/lib/csv";
import { ZohoBulkReconcileButton } from "@/components/features/banking/zoho-bulk-reconcile";
import { istToday } from "@/lib/dates/ist";

/* R-1869: one filter system — status tabs, Money in / out, a Filters panel (date, amount, matched
   to, needs attention incl. R-1863's "no customer yet" + "Old one-off bookings", statement file),
   sort, search, totals and Export CSV. State lives in the URL query (lib/banking/bank-filters). */
const ALL_NEEDS: readonly NeedKey[] = ["no_customer", "no_vendor", "old_one_off", "duplicates", "large"];
const READ_ONLY_NEEDS: readonly NeedKey[] = ["duplicates", "large"];
/* R-2360: + "Money in · Zoho has a match" when the Zoho batch answered (owner / accountant, connected). */
const ALL_NEEDS_ZOHO: readonly NeedKey[] = [...ALL_NEEDS, "zoho_match"];

// Column order (left→right) + default widths (px) for the resizable table.
// Status is folded into the last column: an unmatched row just shows the
// "Reconcile" button (so "Unmatched" is implied — no separate column needed);
// a reconciled row shows WHAT it matched (green pill) + "Un-reconcile". That
// frees a whole column for the description + amounts.
const BANK_COL_ORDER = ["date", "description", "nikasi", "jama", "balance", "reconcile"];
// Widths tuned to fit a laptop content area WITHOUT a horizontal scrollbar
// (≈930px total, R-2400 Balance included). Description flexes widest; users can still drag any column.
const BANK_COL_DEFAULTS: Record<string, number> = {
  date: 118, description: 320, nikasi: 116, jama: 116, balance: 124, reconcile: 140,
};

export default function BankAccountDetailPage() {
  const params = useParams<{ id: string }>();
  const accountId = params?.id ?? null;

  const accountQ = useBankAccount(accountId);
  const txnQ     = useBankTransactions(accountId);
  const { data: account,      isLoading: accLoading } = accountQ;
  const { data: transactions, isLoading: txnLoading } = txnQ;
  const autoReconcile = useAutoReconcile();
  /* R-254: billing reads the statement; only owner / manager / accountant may import or reconcile. */
  const role = useCurrentUser().data?.role;
  const canWrite = canWriteMoney(role);

  const [filters,       setFiltersState]  = React.useState<BankFilters>(DEFAULT_FILTERS);
  /* Lines drawn so far — 1,449 rows at once made the page slow; "Load more" adds PAGE_SIZE. */
  const [shownCount,    setShownCount]    = React.useState(PAGE_SIZE);
  const setFilters = React.useCallback((next: BankFilters) => { setFiltersState(next); setShownCount(PAGE_SIZE); }, []);
  const setStatus = (status: StatusFilter) => setFilters({ ...filters, status });
  const [importOpen,    setImportOpen]    = React.useState(false);
  const [salaryOpen,    setSalaryOpen]    = React.useState(false);
  const [aaConnectOpen, setAaConnectOpen] = React.useState(false);
  const [reconcileTxn,  setReconcileTxn]  = React.useState<BankTransactionRow | null>(null);
  /* R-2524: the Reconcile sheet mounts once the list has drawn and the browser is idle (use-drawn-lines). */
  const drawerMounted = useMountWhenIdle(Boolean(txnQ.data));
  /* Un-reconcile goes through a confirm that says what the line leaves behind (and can
     undo a sale raised from it) — components/features/banking/unreconcile-dialog.tsx. */
  const [unreconcileTxn, setUnreconcileTxn] = React.useState<BankTransactionRow | null>(null);
  /* The booking is kept as it was when Relink was pressed: after the save the line leaves the
     old-bookings list, and the dialog must stay open to show what happened. */
  const [relink,        setRelink]        = React.useState<{ txn: BankTransactionRow; booking: OldOneOffBooking } | null>(null);
  /* R-1895: ?txn=<line> (e.g. from the Salary Register) — that line is scrolled to and lit up. */
  const [highlightId,   setHighlightId]   = React.useState<string | null>(null);
  /* Relink removes the old receipt — owner / accountant, as delete_payment (the server checks too). */
  const canRelink = role === "owner" || role === "accountant";

  // Resizable columns — drag the full-height divider between any two columns.
  const { colW, startResize, totalWidth: bankTableW } = useResizableColumns("ros_bank_colw_v3", BANK_COL_DEFAULTS);

  // AA connection state (returns null if not connected yet)
  const { data: aaConn } = useBankAaConnection(accountId);
  const fetchAa = useFetchAaNow();

  // Account-wide counts (Auto-reconcile, empty states) — the tabs count under the other filters.
  const counts = React.useMemo(() => {
    const all       = transactions?.length ?? 0;
    const matched   = transactions?.filter((t) => t.matched_to_type !== null).length ?? 0;
    const unmatched = all - matched;
    return { all, unmatched, matched };
  }, [transactions]);
  /* R-2400: the balance after each line — over ALL the account's lines (a filtered or paged
     view looks its rows up here), same formula as "Balance in bank" (lib/banking/running-balance). */
  const openingForRunning = account?.opening_balance ?? 0;
  const openingDateForRunning = account?.opening_balance_date ?? null;   // R-2497: lines on/after it count
  const running = React.useMemo(() => runningBalances(transactions ?? [], openingForRunning, openingDateForRunning), [transactions, openingForRunning, openingDateForRunning]);
  const ledgerSeq = React.useMemo(() => new Map([...running].map(([id, r]) => [id, r.seq])), [running]);
  const salaryLines = React.useMemo(() => salaryLinesOf(transactions ?? []), [transactions]);
  const salaryLineCount = salaryLines.length;

  /* R-399: "Matches INV-…" chip on unmatched credit rows whose best open-invoice candidate
     is certain (R-109 matcher). Only for someone who can reconcile — the chip opens the
     drawer — and only fetched when there is an unmatched credit to look at. */
  const hasUnmatchedCredit = React.useMemo(
    () => (transactions ?? []).some((t) => t.matched_to_type === null && t.credit > 0),
    [transactions],
  );
  const { data: openInvoices } = useOpenInvoicesForCreditMatch(canWrite && hasUnmatchedCredit);
  /* R-2360: which unmatched money-in lines have a Zoho Books payment — one cached batch read per
     account (never one Zoho call per line); only the lines STILL unmatched count. */
  const zohoQ = useZohoMatchSet(accountId, canWrite && hasUnmatchedCredit);
  const zohoIds = React.useMemo<ReadonlySet<string> | null>(() => {
    const z = zohoQ.data;
    if (!z?.available) return null;
    return new Set((transactions ?? []).filter((t) => t.matched_to_type === null && t.credit > 0 && z.ids.has(t.id)).map((t) => t.id));
  }, [zohoQ.data, transactions]);
  /* R-2524: per-line answers kept across saves — only a line that changed (or a changed customer /
     invoice / vendor / rule list) is worked out again (lib/banking/line-memo). */
  const [matchMemo] = React.useState(() => createLineMemo<InvoiceMatch[]>());
  const [noCustomerMemo] = React.useState(() => createLineMemo<boolean>());
  const [noVendorMemo] = React.useState(() => createLineMemo<boolean>());
  /* R-2524: each unmatched credit is matched against the open invoices ONCE — the chip and
     "no customer yet" below both read this map (it was done twice, ~800 lines × 400 invoices). */
  const creditMatches = React.useMemo(
    () => invoiceMatchesOfCredits(transactions ?? [], openInvoices ?? [], matchMemo),
    [transactions, openInvoices, matchMemo],
  );
  const invoiceChips = React.useMemo(() => certainOf(creditMatches), [creditMatches]);

  /* R-1863: "Money in · no customer yet" — unmatched credits the Reconcile sheet cannot guess a
     customer for (no name in the narration, no certain invoice match). R-2371: same payer memory
     as the sheet, so our own name in a narration is never a customer. */
  const { data: customers } = useCustomers({ enabled: canWrite && hasUnmatchedCredit });
  const payerMemory = usePayerMemory();
  const noCustomerIds = React.useMemo(() => {
    noCustomerMemo.reset([customers, openInvoices, payerMemory]);
    const list = customers ?? [];
    return new Set((transactions ?? [])
      .filter((t) => t.matched_to_type === null && t.credit > 0
        && noCustomerMemo.get(t, () => noCustomerYet([t], list, () => creditMatches.get(t.id) ?? [], payerMemory).length > 0))
      .map((t) => t.id));
  }, [transactions, customers, openInvoices, creditMatches, payerMemory, noCustomerMemo]);
  /* R-1863: lines booked before R-1838 as a one-off "bank sale" — each can be relinked. */
  const { data: oldBookings } = useOldOneOffBookings(accountId, canWrite);
  const oldById = React.useMemo(() => new Map((oldBookings ?? []).map((b) => [b.txn_id, b])), [oldBookings]);
  /* R-2361: a reconciled line shows its manual reason / owner booking note and, for a reversal
     pair, the line it reverses — under the Reconciled badge. */
  const { data: ownerNotes } = useOwnerBookingNotes(accountId);
  const txnById = React.useMemo(() => new Map((transactions ?? []).map((t) => [t.id, t])), [transactions]);
  const notesFor = (t: BankTransactionRow) => lineNoteLines(t, txnById, ownerNotes);
  /* R-2378: a 'manual' line booked as a loan / advance / staff loan … reads as that booking + its party
     (bank_line_bookings), never as "reconciled manually, no entry". R-2570: also the types those flows now store. */
  const hasManual = React.useMemo(() => (transactions ?? []).some((t) => readsLineBooking(t.matched_to_type)), [transactions]);
  const { data: lineBookings } = useLineBookings(accountId, hasManual);
  const bookingFor = (t: BankTransactionRow): LineBooking | undefined =>
    readsLineBooking(t.matched_to_type) ? lineBookings?.get(t.id) : undefined;

  /* R-1869 "Money out · no vendor yet": unmatched money out where R-1866's guessVendor (the
     same guess the Reconcile sheet pre-fills) finds nobody — and not a salary line (Salary lines
     has its own button). Same vendor list query as the sheet, so it is read once. */
  const { data: vendorRows } = useVendors();
  /* R-1919: the one guess order — Category Rules and learned aliases count too. */
  const { data: guessRules } = useTxnCategoryRules();
  const { data: guessAliases } = useVendorNarrationAliases();
  const noVendorIds = React.useMemo(() => {
    const salaryIds = new Set(salaryLines.map((l) => l.txn.id));
    const vendors = (vendorRows ?? []) as unknown as VendorLite[];
    const extras = { rules: guessRules ?? [], aliases: guessAliases ?? [] };
    noVendorMemo.reset([vendorRows, guessRules, guessAliases]);
    return new Set((transactions ?? [])
      .filter((t) => t.matched_to_type === null && t.debit > 0 && !salaryIds.has(t.id)
        && noVendorMemo.get(t, () => guessVendor(t, vendors, extras) === null))
      .map((t) => t.id));
  }, [transactions, salaryLines, vendorRows, guessRules, guessAliases, noVendorMemo]);

  /* The Imports list (R-1623) — "Statement file" filter: which lines each import brought in. */
  const { data: importRows } = useBankImportHistory(accountId);
  const { importOptions, importLines } = React.useMemo(() => {
    const opts: ImportOption[] = [];
    const map = new Map<string, Set<string>>();
    for (const r of importRows ?? []) {
      if (r.removed_at) continue;
      const ids = linesOfImport(r, transactions ?? []).map((t) => t.id);
      if (ids.length === 0) continue;
      const k = importKey(r);
      map.set(k, new Set(ids));
      opts.push({ key: k, label: `${r.file_name || "Older import"} · ${formatDate(r.imported_at)}`, count: ids.length });
    }
    return { importOptions: opts, importLines: map };
  }, [importRows, transactions]);

  const filterCtx = React.useMemo<FilterContext>(() => ({
    sets: { no_customer: noCustomerIds, no_vendor: noVendorIds, old_one_off: new Set(oldById.keys()), ...(zohoIds ? { zoho_match: zohoIds } : {}) },
    importLines,
    order: ledgerSeq,
    bookings: lineBookings,
  }), [noCustomerIds, noVendorIds, oldById, importLines, zohoIds, ledgerSeq, lineBookings]);

  const facets = React.useMemo(() => facetCounts(transactions ?? [], filters, filterCtx), [transactions, filters, filterCtx]);
  const visibleTxns = React.useMemo(
    () => applyBankFilters(transactions ?? [], filters, filterCtx),
    [transactions, filters, filterCtx],
  );
  const totals = React.useMemo(() => filterTotals(visibleTxns), [visibleTxns]);
  const drawnTxns = React.useMemo(() => visibleTxns.slice(0, shownCount), [visibleTxns, shownCount]);

  /* R-2524: Advance / "N payments" badges — read only for the lines drawn (use-drawn-lines). */
  const { isAdvanceTxn, splitPays } = useDrawnBadges(drawnTxns);

  const tabs: TabBarItem[] = [
    { id: "all",       label: "All",        count: facets.status.all       },
    { id: "unmatched", label: "Unmatched",  count: facets.status.unmatched },
    { id: "matched",   label: "Reconciled", count: facets.status.matched   },
  ];

  /* Filters ⇄ URL: read once on open (a shared link / Back restores the view), then every change
     is written back with replaceState, so typing in search does not pile up history entries. */
  const urlReadRef = React.useRef(false);
  const skipWriteRef = React.useRef(false);
  React.useEffect(() => {
    setFiltersState(filtersFromQuery(new URLSearchParams(window.location.search)));
    urlReadRef.current = true;
    skipWriteRef.current = true; // the write effect below runs in this same commit, with the defaults
  }, []);
  React.useEffect(() => {
    if (!urlReadRef.current) return;
    if (skipWriteRef.current) { skipWriteRef.current = false; return; }
    const keep = new URLSearchParams(window.location.search);
    const qs = filtersToQuery(filters);
    // Deep-link params (focus / match) are not filters — the effect below removes them itself.
    for (const k of ["focus", "match"]) { const v = keep.get(k); if (v) qs.set(k, v); }
    const next = qs.toString() ? `${window.location.pathname}?${qs}` : window.location.pathname;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", next);
  }, [filters]);

  const exportCsv = () => {
    const { headers, rows } = bankLinesCsv(visibleTxns, lineBookings);
    const name = (account?.name ?? "bank").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    downloadCSV(`${name}-bank-lines-${istToday()}.csv`, headers, rows);
  };

  /* R-1863: in "no customer yet", saving a line opens the next one — the list is worked through
     one receipt after another. The sheet is closed after its save; once the refreshed list shows
     that line reconciled, the next unassigned line opens. */
  const nextAfterRef = React.useRef<string | null>(null);
  const openNextUnassigned = React.useCallback((list: readonly BankTransactionRow[] | undefined) => {
    const id = nextAfterRef.current;
    if (!id || !list) return;
    const done = list.find((t) => t.id === id);
    if (!done || done.matched_to_type === null) return;
    nextAfterRef.current = null;
    const next = list.find((t) => t.id !== id && noCustomerIds.has(t.id));
    if (next) setReconcileTxn(next);
  }, [noCustomerIds]);
  React.useEffect(() => { openNextUnassigned(transactions); }, [transactions, openNextUnassigned]);
  const openReconcile = (t: BankTransactionRow) => { nextAfterRef.current = null; setReconcileTxn(t); };
  const openRelink = (t: BankTransactionRow) => {
    const booking = oldById.get(t.id);
    if (booking) setRelink({ txn: t, booking });
  };

  // Deep-link from elsewhere (e.g. Payroll "Reconcile in Banking →"):
  //   ?txn=<txnId>     → show that line (R-1895): filters / "Load more" set so it is drawn,
  //                      scrolled to and highlighted for a few seconds — nothing opens
  //   ?focus=<txnId>   → open that transaction's reconcile
  //   ?match=<amount>  → open the matching unmatched debit's reconcile
  // Runs once, after transactions load; cleans the URL so a refresh won't repeat.
  const focusedRef = React.useRef(false);
  React.useEffect(() => {
    if (focusedRef.current || !transactions || transactions.length === 0) return;
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const txnParam = sp.get("txn");
    if (txnParam) {
      focusedRef.current = true;
      const shown = revealTxn(transactions, filtersFromQuery(sp), filterCtx, txnParam);
      sp.delete("txn");
      if (shown) {
        setFiltersState(shown.filters);
        setShownCount(shown.shownCount);
        setHighlightId(txnParam);
        const qs = filtersToQuery(shown.filters).toString();
        window.history.replaceState(window.history.state, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
      } else {
        toast("That bank line is not in this account's statement any more.");
        window.history.replaceState(window.history.state, "", sp.toString() ? `${window.location.pathname}?${sp}` : window.location.pathname);
      }
      return;
    }
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
    if (target) setReconcileTxn(target);
    else toast("No unmatched bank line for that amount — reconcile it manually below.");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?status=unmatched`);
    setFilters({ ...DEFAULT_FILTERS, status: "unmatched" });
  }, [transactions, setFilters, filterCtx]);

  /* R-1895: once the highlighted line is drawn, bring it into view; the glow fades after 3 s. */
  React.useEffect(() => {
    if (!highlightId) return;
    const el = Array.from(document.querySelectorAll<HTMLElement>(`[data-txn-id="${CSS.escape(highlightId)}"]`))
      .find((e) => e.offsetParent !== null);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = window.setTimeout(() => setHighlightId(null), 3000);
    return () => window.clearTimeout(t);
  }, [highlightId, shownCount]);

  if (accLoading) {
    return <div className="p-8"><Skeleton className="h-32" /></div>;
  }
  // A failed fetch is not "not found", and without the statement lines both balances
  // below would print the opening balance as if nothing had moved.
  if (accountQ.isError || txnQ.isError) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <LoadError what="This bank account" onRetry={() => { void accountQ.refetch(); void txnQ.refetch(); }} />
      </div>
    );
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

  //  • Bank balance = opening + every imported statement line (what the bank shows — real cash)
  //  • Reconciled so far (R-1869) = how much of the money that moved has a record in the books.
  //    It replaced "Balance in app" (opening + reconciled lines only), which is not a balance of
  //    anything and showed ₹-19,17,804 on a healthy account. Coverage, never cash: always ≥ 0.
  const openingBal = account.opening_balance ?? 0;
  const allTxns    = transactions ?? [];
  /* R-2400: one formula — the newest row's running Balance is this same figure. */
  const bankBalance = bankBalanceOf(allTxns, openingBal, account.opening_balance_date);
  /* R-2497: lines dated before the opening date are inside the opening — listed, not counted. */
  const countedTxns = allTxns.filter((t) => countsAfterOpening(t, account.opening_balance_date));
  const dateSorted  = filters.sort === "newest" || filters.sort === "oldest";
  const coverage    = reconcileCoverage(allTxns);
  const filtersOn   = hasAnyFilter(filters);
  /* Plain call, not a hook — this runs after the early returns above. Cheap: one pass. */
  const statementCheck = checkStatement(countedTxns, openingBal);

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
          <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">
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
        {canWrite && <div className="flex items-center gap-2 flex-wrap">
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
        </div>}
      </div>

      {!canWrite && <ViewOnlyNote what="import statements or reconcile" />}

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
            <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Balance in bank</p>
            <p className={`font-serif text-2xl mt-1 ${bankBalance >= 0 ? "text-ink" : "text-rose"}`}>
              {balanceText(bankBalance)}
            </p>
            <p className="text-xs text-ink-3 mt-0.5">
              {/* R-1829: red only for a real gap — a few rupees of paise rounding is not one. */}
              {statementCheck?.verdict === "off"
                ? <span className="text-rose">Statement says {rupee(statementCheck.statementBalance)}</span>
                : "Per imported statement"}
            </p>
          </div>
          <OpeningBalanceTile account={account} beforeOpeningCount={allTxns.length - countedTxns.length} />
          {/* R-1869: coverage of the books, not a second "balance" (see coverage above). */}
          <div className="col-span-2">
            <ReconcileCoverageTile
              c={coverage}
              onShowUnmatched={() => setFilters({ ...clearFilters(filters), status: "unmatched" })}
            />
          </div>
        </div>
      </Card>

      {/* Balance in bank vs the statement's own running balance. */}
      {statementCheck && (
        <StatementCheckCard
          check={statementCheck}
          openingBalance={openingBal}
          openingDate={account.opening_balance_date}
          onImport={() => setImportOpen(true)}
        />
      )}

      {/* R-1623: every import of this account — and "Ye import hatao" for a wrong one. */}
      <BankImportsSection
        accountId={account.id}
        transactions={allTxns}
        openingBalance={openingBal}
        role={role}
        onUnreconcileLine={(t) => setUnreconcileTxn(t)}
      />

      {/* Filter tabs + one-tap auto-reconcile */}
      <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
        <TabBar items={tabs} value={filters.status} onChange={(v) => setStatus(v as StatusFilter)} />
        {canWrite && counts.unmatched > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            {/* Salary lines Payroll never recorded — auto-reconcile has nothing to match
                them to, so offer to create the records (every line previewed first). */}
            {salaryLineCount > 0 && (
              <Button
                icon="users"
                variant="default"
                onClick={() => setSalaryOpen(true)}
                title="Create salary records from this account's salary lines and reconcile them — you review every line first"
              >
                {`Salary lines (${salaryLineCount})`}
              </Button>
            )}
            {/* R-2611: the "Money out · no vendor yet" lines in one table — tick and book them at once. */}
            <BulkExpenseButton accountName={account.name} transactions={transactions} ids={noVendorIds} />
            {/* R-2402: bulk "Reconcile from Zoho" — owner / accountant, when Zoho has payments for these lines. */}
            {zohoIds && zohoIds.size > 0 && (role === "owner" || role === "accountant") && <ZohoBulkReconcileButton accountId={account.id} accountName={account.name} count={zohoIds.size} />}
            <Button
              icon="sparkles"
              variant="default"
              loading={autoReconcile.isPending}
              onClick={() => autoReconcile.mutate(account.id)}
              title="Auto-match every unmatched line to its vendor bill / expense / salary / payment / EMI where the match is unambiguous"
            >
              {/* R-1657: runs on the server in chunks of 500 — show how far a big account has got. */}
              {autoReconcile.isPending
                ? (autoReconcile.progress?.checked
                    ? `Matching… ${autoReconcile.progress.checked} of ${counts.unmatched} checked`
                    : "Matching…")
                : `Auto-reconcile (${counts.unmatched})`}
            </Button>
          </div>
        )}
      </div>

      {/* R-1831: every run ends with a result that stays — matched N, and why the rest were left. */}
      {autoReconcile.isSuccess && autoReconcile.data && (
        <AutoReconcileResult
          summary={autoReconcile.data}
          unmatchedShown={filters.status === "unmatched"}
          onShowUnmatched={() => setStatus("unmatched")}
          onClose={() => autoReconcile.reset()}
        />
      )}

      {/* R-1869: one filter row — Money in / out, Filters (date, amount, matched to, needs
          attention, statement file), sort, search, Export CSV; chips; totals of what is shown. */}
      <BankFilterBar
        filters={filters}
        onChange={setFilters}
        counts={facets}
        totals={totals}
        needs={canWrite ? (zohoIds ? ALL_NEEDS_ZOHO : ALL_NEEDS) : READ_ONLY_NEEDS}
        imports={importOptions}
        todayIso={istToday()}
        onExport={exportCsv}
      />
      {filters.need === "old_one_off" && oldById.size > 0 && (
        <p className="mb-3 text-xs text-ink-3 max-w-3xl">
          These were booked as one-off sales before the bank page asked what the money was for. They stay as they are.
          If one was really a renewal, extra seats or a quote, press <b>Relink</b>: you see what will happen, then pick what it paid.
        </p>
      )}

      {/* Transactions list */}
      {txnLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}
        </div>
      ) : visibleTxns.length === 0 ? (
        <Card>
          {counts.all === 0 ? (
            <EmptyState
              icon="upload"
              title="No transactions yet."
              body="Import a bank statement CSV to populate this account. Most Indian banks let you download a 30-day or 90-day statement from net banking."
              action={canWrite ? <Button variant="primary" icon="upload" onClick={() => setImportOpen(true)}>Import statement</Button> : undefined}
            />
          ) : (
            <EmptyState
              icon="check_circle"
              title={
                filters.need === "no_customer" ? "Every money-in line has a customer ✓" :
                filters.need === "old_one_off" ? "No old one-off bookings left ✓" :
                filters.status === "unmatched" && !filtersOn ? "All transactions reconciled ✓" :
                filters.status === "matched" && !filtersOn ? "No reconciled transactions yet." :
                                                  "No lines match these filters."
              }
              body={`${counts.all.toLocaleString("en-IN")} lines in this account — ${counts.unmatched.toLocaleString("en-IN")} not yet reconciled.`}
              action={filtersOn
                ? <Button variant="default" onClick={() => setFilters(clearFilters(filters))}>Clear all filters</Button>
                : undefined}
            />
          )}
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
                  <tr className="border-b border-hairline text-left text-2xs uppercase tracking-wider text-ink-3">
                    <th className="px-4 py-2 font-semibold whitespace-nowrap">Date</th>
                    <th className="px-4 py-2 font-semibold whitespace-nowrap">Description</th>
                    <th className="px-4 py-2 font-semibold text-right whitespace-nowrap">Nikasi (Dr.)</th>
                    <th className="px-4 py-2 font-semibold text-right whitespace-nowrap">Jama (Cr.)</th>
                    <th
                      className="px-4 py-2 font-semibold text-right whitespace-nowrap"
                      title={dateSorted
                        ? "Balance after this line: opening balance + every line up to it, in date order"
                        : "Balance after this line, in date order (the list is sorted by amount)"}
                    >
                      Balance
                    </th>
                    <th className="px-4 py-2 font-semibold text-right whitespace-nowrap">Reconcile</th>
                  </tr>
                </thead>
                <tbody>
                  {drawnTxns.map((txn) => (
                    <TransactionRow
                      key={txn.id}
                      txn={txn}
                      running={running.get(txn.id)}
                      highlighted={txn.id === highlightId}
                      invoiceMatch={canWrite ? invoiceChips.get(txn.id) : undefined}
                      onReconcile={canWrite ? () => openReconcile(txn) : undefined}
                      onUnreconcile={canWrite ? () => setUnreconcileTxn(txn) : undefined}
                      onRelink={canWrite && oldById.has(txn.id) ? () => openRelink(txn) : undefined}
                      isAdvance={isAdvanceTxn(txn)}
                      splitPays={splitPays?.get(txn.id)}
                      notes={notesFor(txn)}
                      booking={bookingFor(txn)}
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
            {drawnTxns.map((txn) => (
              <TransactionCard
                key={txn.id}
                txn={txn}
                running={running.get(txn.id)}
                highlighted={txn.id === highlightId}
                invoiceMatch={canWrite ? invoiceChips.get(txn.id) : undefined}
                onReconcile={canWrite ? () => openReconcile(txn) : undefined}
                onUnreconcile={canWrite ? () => setUnreconcileTxn(txn) : undefined}
                onRelink={canWrite && oldById.has(txn.id) ? () => openRelink(txn) : undefined}
                isAdvance={isAdvanceTxn(txn)}
                splitPays={splitPays?.get(txn.id)}
                notes={notesFor(txn)}
                booking={bookingFor(txn)}
              />
            ))}
          </ul>

          {/* R-1869: lines are drawn in pages — totals and Export CSV still cover every match. */}
          {visibleTxns.length > drawnTxns.length && (
            <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-xs text-ink-3">
              <span>{`Showing ${drawnTxns.length.toLocaleString("en-IN")} of ${visibleTxns.length.toLocaleString("en-IN")} lines`}</span>
              <Button variant="default" size="sm" onClick={() => setShownCount((n) => n + PAGE_SIZE)}>
                {`Load ${Math.min(PAGE_SIZE, visibleTxns.length - drawnTxns.length)} more`}
              </Button>
            </div>
          )}
        </>
      )}

      <ImportStatementDialog open={importOpen} onOpenChange={setImportOpen} accountId={account.id} />
      <SalaryLinesDialog open={salaryOpen} onOpenChange={setSalaryOpen} accountId={account.id} transactions={allTxns} />
      <ConnectAaDialog
        open={aaConnectOpen}
        onOpenChange={setAaConnectOpen}
        bankAccountId={account.id}
        bankName={account.bank_name}
      />
      {/* R-2524: mounted on first Reconcile, not with the page — its ~15 reads (expenses, salaries,
          customers, employees, rules, …) cost nothing until the sheet is used, then stay for the next line. */}
      {(drawerMounted || reconcileTxn) && <ReconcileTransactionDialog
        open={Boolean(reconcileTxn)}
        onOpenChange={(o) => {
          if (o) return;
          if (filters.need === "no_customer" && reconcileTxn) {
            nextAfterRef.current = reconcileTxn.id;
            openNextUnassigned(transactions);
          }
          setReconcileTxn((cur) => (cur?.id === reconcileTxn?.id ? null : cur));
        }}
        transaction={reconcileTxn}
      />}
      <UnreconcileDialog txn={unreconcileTxn} onClose={() => setUnreconcileTxn(null)} />
      <RelinkOneOffDialog
        txn={relink?.txn ?? null}
        booking={relink?.booking ?? null}
        canRelink={canRelink}
        onClose={() => setRelink(null)}
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

// ============================================================
// Row (desktop)
// ============================================================
/** R-1895: the line a deep link (?txn=) pointed at — lit up for a few seconds. */
const HIGHLIGHT = "bg-amber-soft ring-2 ring-inset ring-amber-400 transition-colors duration-700";

function TransactionRow({
  txn,
  highlighted = false,
  invoiceMatch,
  onReconcile,
  onUnreconcile,
  onRelink,
  isAdvance = false,
  splitPays,
  notes = null,
  running,
  booking,
}: {
  txn: BankTransactionRow;
  /** R-2400: the balance after this line, from ALL the account's lines. */
  running?: RunningBalance;
  highlighted?: boolean;
  /** R-2361: manual reason / owner note + reversal pair, shown under the badge. */
  notes?: LineNoteLines | null;
  /** R-2378: the real booking of a 'manual' line — the badge + the party link. */
  booking?: LineBooking;
  /** R-2025 (0): booked as the customer's advance — the badge reads "Advance". */
  isAdvance?: boolean;
  /** R-2098: the receipts of a line that paid several items. */
  splitPays?: readonly SplitLinePayment[];
  /** R-399: a certain open-invoice match for this unmatched credit — the chip opens the drawer. */
  invoiceMatch?: InvoiceMatch;
  /** Both left out for a read-only viewer (R-254) — the status shows, the buttons do not. */
  onReconcile?: () => void;
  onUnreconcile?: () => void;
  /** R-1863: an old one-off bank sale — move it onto what it really paid. */
  onRelink?: () => void;
}) {
  /* R-2524: no mutation hook per row — each row's own useReconcileTransaction never ran, so its isPending was always false. */

  return (
    <tr data-txn-id={txn.id} aria-current={highlighted ? "true" : undefined}
      className={`border-b border-hairline last:border-b-0 transition-colors duration-700 ${highlighted ? HIGHLIGHT : "hover:bg-paper-2/30"}`}>
      <td className="px-4 py-3 text-ink-2 whitespace-nowrap truncate">
        {formatDate(txn.txn_date)}
      </td>
      <td className="px-4 py-3 align-top">
        {/* Wrap (not truncate) so the full narration is readable at the default
            width — no need to widen the column and push other columns off. */}
        <div className="font-medium text-ink break-words leading-snug">{txn.description}<RemittanceText description={txn.description} /></div>
        {txn.reference && (
          <div className="text-xs text-ink-3 font-mono mt-0.5 break-all">{txn.reference}</div>
        )}
        {invoiceMatch && onReconcile && (
          <div className="mt-1"><InvoiceMatchChip match={invoiceMatch} onOpen={onReconcile} /></div>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium text-rose">
        {txn.debit > 0 ? rupee(txn.debit) : <span className="text-ink-3">—</span>}
      </td>
      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium text-emerald">
        {txn.credit > 0 ? rupee(txn.credit) : <span className="text-ink-3">—</span>}
      </td>
      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium">
        <RunningBalanceText running={running} />
      </td>
      <td className="px-4 py-3 text-right">
        {txn.matched_to_type === "transfer" ? (
          // Inter-account transfers are auto-reconciled self-balancing pairs —
          // un-reconciling one leg would orphan it, so no action here.
          <div className="flex flex-col items-end gap-0.5">
            <Badge kind="success" size="sm" dot>Inter-account</Badge>
            <span className="text-xs text-ink-3">Auto</span>
          </div>
        ) : txn.matched_to_type ? (
          // Reconciled: show WHAT it matched (this replaces the Status column)
          // plus a quiet way to undo it.
          <div className="flex flex-col items-end gap-0.5">
            <MatchedBadge txn={txn} isAdvance={isAdvance} splitPays={splitPays} booking={booking} />
            <BookingParty booking={booking} align="right" />
            <LineNotes notes={notes} align="right" />
            {onRelink && (
              <Button size="sm" variant="default" onClick={onRelink} title="Move this one-off sale onto the renewal, extra seats or quote it paid">
                Relink
              </Button>
            )}
            {onUnreconcile && (
              <button
                type="button"
                onClick={onUnreconcile}
                className="text-xs text-ink-3 hover:text-rose"
              >
                Un-reconcile
              </button>
            )}
          </div>
        ) : onReconcile ? (
          // Unmatched: the button alone conveys the status.
          <Button size="sm" variant="default" onClick={onReconcile}>
            Reconcile
          </Button>
        ) : (
          <TxnStatusBadge txn={txn} isAdvance={isAdvance} splitPays={splitPays} booking={booking} />
        )}
      </td>
    </tr>
  );
}

// ============================================================
// Card (mobile)
// ============================================================
function TransactionCard({ txn, running, highlighted = false, invoiceMatch, onReconcile, onUnreconcile, onRelink, isAdvance = false, splitPays, notes = null, booking }: {
  txn: BankTransactionRow; running?: RunningBalance; highlighted?: boolean; invoiceMatch?: InvoiceMatch; onReconcile?: () => void; onUnreconcile?: () => void; onRelink?: () => void; isAdvance?: boolean;
  splitPays?: readonly SplitLinePayment[];
  notes?: LineNoteLines | null;
  booking?: LineBooking;
}) {
  return (
    <li data-txn-id={txn.id} aria-current={highlighted ? "true" : undefined}>
      <Card className={`p-3 transition-colors duration-700 ${highlighted ? HIGHLIGHT : ""}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium leading-snug text-ink break-words">{txn.description}<RemittanceText description={txn.description} /></div>
            <div className="mt-0.5 text-xs text-ink-3">
              {formatDate(txn.txn_date)}
              {txn.reference ? <span className="font-mono"> · {txn.reference}</span> : ""}
            </div>
            {invoiceMatch && onReconcile && (
              <div className="mt-1"><InvoiceMatchChip match={invoiceMatch} onOpen={onReconcile} /></div>
            )}
            <BookingParty booking={booking} />
            <LineNotes notes={notes} align="left" />
          </div>
          <div className="shrink-0 text-right font-serif text-base tabular-nums">
            <TxnAmount txn={txn} />
            {running && (
              <div className="mt-0.5 font-sans text-xs text-ink-3">
                Balance <RunningBalanceText running={running} />
              </div>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <TxnStatusBadge txn={txn} isAdvance={isAdvance} splitPays={splitPays} booking={booking} />
          {txn.matched_to_type === "transfer" ? (
            <span className="text-xs text-ink-3">Auto</span>
          ) : txn.matched_to_type ? (
            <div className="flex items-center gap-3">
              {onRelink && <Button size="sm" variant="default" onClick={onRelink}>Relink</Button>}
              {onUnreconcile ? (
                <button
                  type="button"
                  onClick={onUnreconcile}
                  className="text-xs text-ink-3 hover:text-rose"
                >
                  Un-reconcile
                </button>
              ) : null}
            </div>
          ) : onReconcile ? (
            <Button size="sm" variant="default" onClick={onReconcile}>
              Reconcile
            </Button>
          ) : null}
        </div>
      </Card>
    </li>
  );
}
