/**
 * Expenses — operating expenses (non-COGS).
 *
 * Hosting, salaries, software, office, marketing, etc. These hit the
 * P&L below the gross-margin line. Any GST paid on these bills is
 * input tax credit and rolls up into the GST input report.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Card } from "@/components/ui/card";
import { Button, IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { FAB } from "@/components/ui/fab";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { rupee, formatDate, foreignAmount } from "@/lib/utils";
import {
  useExpenses,
  useExpensesTotals,
  useDeleteExpense,
  useOutstandingPayable,
  type Expense,
} from "@/lib/queries/expenses";
import { AddExpenseDialog } from "@/components/features/accounting/add-expense-dialog";
import { ExpenseDetailDialog } from "@/components/features/accounting/expense-detail-dialog";
import { MarkPaidDialog } from "@/components/features/accounting/mark-paid-dialog";
import { BulkMarkPaidDialog } from "@/components/features/accounting/bulk-mark-paid-dialog";
import { ReconcileExpenseDialog } from "@/components/features/accounting/reconcile-expense-dialog";
import { useSalaryPayments } from "@/lib/queries/payroll";
import { useBankAccounts } from "@/lib/queries/bank";
import { useConfirm } from "@/components/providers/confirm-provider";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { groupExpenses, type GroupBy } from "@/lib/accounting/expense-groups";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { panFromGstin } from "@/lib/accounting/tds-deductor";
import { istToday } from "@/lib/dates/ist";
import { reconcileTag, ReconcileTag, PayBadge, BillChip, isPayrollExpense } from "./expense-badges";
import { filterExpenses, EXPENSE_SORT, expenseViewState, readExpenseView } from "./expense-table";

type DateRange = { from: string; to: string };
const GROUP_BY_CHOICES: readonly GroupBy[] = ["none", "vendor", "category"];

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12

function istNow() {
  const n = new Date();
  const ist = new Date(n.getTime() + 5.5 * 60 * 60 * 1000);
  return { y: ist.getUTCFullYear(), m: ist.getUTCMonth() + 1, d: ist.getUTCDate() };
}


// Quick presets (Indian FY = Apr 1 → Mar 31).
const RANGE_PRESETS: { id: string; label: string; range: () => DateRange }[] = [
  { id: "month",    label: "This month",   range: () => { const { y, m } = istNow(); return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) }; } },
  { id: "quarter",  label: "This quarter", range: () => { const { y, m } = istNow(); const qs = Math.floor((m - 1) / 3) * 3 + 1; return { from: iso(y, qs, 1), to: iso(y, qs + 2, lastDay(y, qs + 2)) }; } },
  { id: "half",     label: "Half-year",    range: () => {
      // FY half-years (Indian FY Apr–Mar): H1 = Apr–Sep, H2 = Oct–Mar.
      const { y, m } = istNow();
      if (m >= 4 && m <= 9) return { from: iso(y, 4, 1),  to: iso(y, 9, 30) };       // H1
      if (m >= 10)          return { from: iso(y, 10, 1), to: iso(y + 1, 3, 31) };   // H2 (Oct–Dec side)
      return { from: iso(y - 1, 10, 1), to: iso(y, 3, 31) };                          // H2 (Jan–Mar side)
    } },
  { id: "fy",       label: "This FY",      range: () => { const { y, m } = istNow(); const fs = m >= 4 ? y : y - 1; return { from: iso(fs, 4, 1), to: iso(fs + 1, 3, 31) }; } },
  { id: "prevfy",   label: "Previous FY",  range: () => { const { y, m } = istNow(); const fs = m >= 4 ? y : y - 1; return { from: iso(fs - 1, 4, 1), to: iso(fs, 3, 31) }; } },
];

export default function ExpensesPage() {
  // Default to the "This month" preset itself (not 1st→today) so the chip shows
  // as selected out of the box.
  /* R-287: every filter lives in the URL (useUrlState), so opening a payroll posting and
     pressing Back returns to the same filtered list. ?q also serves the Purchase Report
     deep-link ("Open" on a vendor line), which used to need its own effect. */
  const monthRange = React.useMemo(() => RANGE_PRESETS[0].range(), []);
  const [from, setFrom] = useUrlState("from", monthRange.from);
  const [to, setTo]     = useUrlState("to", monthRange.to);
  const range = React.useMemo<DateRange>(() => ({ from, to }), [from, to]);
  const setRange = React.useCallback((r: DateRange) => { setFrom(r.from); setTo(r.to); }, [setFrom, setTo]);
  const [catFilter, setCatFilter] = useUrlState("category");
  const [payeeFilter, setPayeeFilter] = useUrlState("payee");
  const [unpaidParam, setUnpaidParam] = useUrlState("unpaid");
  const unpaidOnly = unpaidParam === "1";
  const setUnpaidOnly = React.useCallback((on: boolean) => setUnpaidParam(on ? "1" : ""), [setUnpaidParam]);
  const [search, setSearch] = useUrlState("q");
  /* Group the list by vendor or category, each with a subtotal. Collapsed groups are
     remembered per key while the view is open. */
  const [groupBy, setGroupBy] = useUrlChoice<GroupBy>("group", GROUP_BY_CHOICES, "none");
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Expense | null>(null);
  /* ?edit=<expense id> — Payments Made opens a paid expense straight into its edit form
     (2 Oct 2026). Fetched by id: the list here is date-range limited, the expense may be older. */
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const id = new URLSearchParams(window.location.search).get("edit");
    if (!id) return;
    let live = true;
    void createClient().from("expenses").select("*").eq("id", id).maybeSingle().then(({ data }) => {
      if (live && data) setEditing(data as Expense);
    });
    return () => { live = false; };
  }, []);
  const [detail, setDetail]   = React.useState<Expense | null>(null);
  const [payingExpense, setPayingExpense] = React.useState<Expense | null>(null);
  const [reconcilingExpense, setReconcilingExpense] = React.useState<Expense | null>(null);
  // Bulk "Mark paid" — selected expense ids + the batch dialog.
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [bulkPayOpen, setBulkPayOpen] = React.useState(false);
  const today = istToday();
  const router = useRouter();

  // Row click: payroll/statutory postings open in Payroll (their source); every
  // other expense opens the bill-style detail (items + reconciliation).
  const openRow = (e: Expense) => {
    if (isPayrollExpense(e)) { router.push("/accounting/payroll" as never); return; }
    setDetail(e);
  };

  const q       = useExpenses({ from: range.from, to: range.to, category: catFilter || undefined });
  const totalsQ = useExpensesTotals(range);
  const payableQ = useOutstandingPayable();
  const accountsQ = useBankAccounts();
  const del     = useDeleteExpense();
  const salariesQ = useSalaryPayments();
  const confirm = useConfirm();

  // expense_id → its salary payment (for the partial/paid reconcile tag).
  const salByExpense = React.useMemo(
    () => new Map((salariesQ.data ?? []).filter((s) => s.expense_id).map((s) => [s.expense_id as string, s])),
    [salariesQ.data],
  );

  const allRows   = React.useMemo(() => q.data ?? [], [q.data]);
  const isLoading = q.isLoading;
  const totals    = totalsQ.data;

  // Build category list from totals.byCategory keys for the filter dropdown.
  const categoryOptions = totals ? Object.keys(totals.byCategory).sort() : [];

  // Distinct vendors/payees in the current range → drives the payee filter, so
  // you can see everything paid to one supplier (e.g. Anthropic) with its total
  // + input GST in one place.
  const payeeOptions = React.useMemo(
    () => Array.from(new Set(allRows.map((e) => (e.vendor_name ?? "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [allRows],
  );

  // Does this row still owe money? Mirrors the per-row status chip exactly:
  //  • payroll salary  → its salary payment isn't fully paid
  //  • statutory/ESI    → not yet reconciled to a bank line
  //  • everything else  → the expense is marked unpaid
  const rowOwes = React.useCallback((e: Expense): boolean => {
    if (isPayrollExpense(e)) {
      if (e.category === "Salaries") { const s = salByExpense.get(e.id); return s ? s.paid_status !== "paid" : false; }
      return !e.reconciled_txn_id;
    }
    return !e.paid;
  }, [salByExpense]);

  // Can this row still be reconciled? (a paid-but-unverified operating expense,
  // or a payroll posting not yet fully settled). Drives the "Reconcile" button.
  const canReconcile = React.useCallback((e: Expense): boolean => {
    if (isPayrollExpense(e)) {
      if (e.category === "Salaries") { const s = salByExpense.get(e.id); return s ? s.paid_status !== "paid" : false; }
      return !e.reconciled_txn_id; // statutory / ESI
    }
    // advance-funded expenses have no bank line of their own (the advance payment was the debit)
    return e.paid && !e.reconciled_txn_id && e.payment_method !== "advance"; // operating: paid, awaiting bank match
  }, [salByExpense]);

  // Start reconcile. Operating expenses use the expense-first picker; payroll
  // (salary/statutory) go to Banking, where the salary-aware flow lives (a
  // salary match flips its paid_status + supports partials — an expense match
  // wouldn't). Route to the single bank account if there's one, else Banking.
  const startReconcile = (e: Expense) => {
    if (isPayrollExpense(e)) {
      const s = e.category === "Salaries" ? salByExpense.get(e.id) : undefined;
      const amt = s ? Math.max(0, s.net - s.paid_amount) : e.amount;
      const banks = (accountsQ.data ?? []).filter((a) => a.is_active && a.account_type !== "cash");
      router.push((banks.length === 1 ? `/accounting/banking/${banks[0].id}?match=${amt}` : "/accounting/banking") as never);
      return;
    }
    setReconcilingExpense(e);
  };

  // Rows after the client-side filters (category is applied in the query;
  // payee + "to pay" are applied here).
  const rows = React.useMemo(
    () => filterExpenses(allRows, { payee: payeeFilter, unpaidOnly, search }, rowOwes),
    [allRows, payeeFilter, unpaidOnly, search, rowOwes],
  );

  /* R-213: saved views remember the date range + every filter (DataTable "Views"). */
  const filterState = { from: range.from, to: range.to, category: catFilter, payee: payeeFilter, unpaidOnly, search };
  const viewState = expenseViewState(filterState);
  const applyView = (v: Record<string, unknown>) => {
    const s = readExpenseView(v, filterState);
    setRange({ from: s.from, to: s.to });
    setCatFilter(s.category);
    setPayeeFilter(s.payee);
    setUnpaidOnly(s.unpaidOnly);
    setSearch(s.search);
    setSelectedIds(new Set());
  };

  const groups = React.useMemo(
    () => (groupBy === "none" ? [] : groupExpenses(rows, groupBy)),
    [rows, groupBy],
  );

  // Totals for whatever is currently filtered — count, amount, and input GST.
  const filtered = React.useMemo(() => rows.reduce(
    (acc, e) => { acc.amount += e.amount ?? 0; acc.gst += e.gst_paid ?? 0; return acc; },
    { amount: 0, gst: 0 },
  ), [rows]);
  const isFiltered = Boolean(payeeFilter || catFilter || unpaidOnly || search.trim());

  // ── Bulk mark-paid selection ──────────────────────────────────────────────
  // Only unpaid, non-payroll operating expenses can be batch-settled (payroll
  // flows through Payroll; cash/petty-cash needs per-row accounts).
  const bulkEligible = React.useCallback(
    (e: Expense) => !e.paid && !isPayrollExpense(e),
    [],
  );
  const eligibleRows = React.useMemo(() => rows.filter(bulkEligible), [rows, bulkEligible]);
  const selectedRows = React.useMemo(
    () => eligibleRows.filter((e) => selectedIds.has(e.id)),
    [eligibleRows, selectedIds],
  );
  const selectedTotal = selectedRows.reduce((s, e) => s + (e.amount ?? 0), 0);
  const allEligibleSelected = eligibleRows.length > 0 && selectedRows.length === eligibleRows.length;

  // Drop any selected id that's no longer an eligible row (filter/range change,
  // or it just got paid) so the bulk bar count never lies.
  React.useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(eligibleRows.map((e) => e.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => { if (live.has(id)) next.add(id); else changed = true; });
      return changed ? next : prev;
    });
  }, [eligibleRows]);

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelectedIds((prev) =>
      prev.size >= eligibleRows.length && eligibleRows.length > 0
        ? new Set()
        : new Set(eligibleRows.map((e) => e.id)),
    );
  const clearSelection = () => setSelectedIds(new Set());

  // 26Q working — non-salary TDS you DEDUCTED (rent/professional/contractor…),
  // deductee-wise, for the current date range. For the CA / TDS software (RPU →
  // FVU); the app can't produce the FVU itself. PAN derived from vendor GSTIN.
  async function export26Q() {
    const supabase = createClient();
    const { data: exps } = await supabase
      .from("expenses")
      .select("id, expense_date, vendor_name, vendor_id, amount, gst_paid, tds_section, tds_amount")
      .gte("expense_date", range.from).lte("expense_date", range.to)
      .gt("tds_amount", 0);
    if (!exps || exps.length === 0) {
      toast.error("Is range me koi TDS-deducted expense nahi. Pehle Add Expense me kisi vendor payment pe TDS record karo.");
      return;
    }
    const vids = Array.from(new Set(exps.map((e) => e.vendor_id).filter(Boolean))) as string[];
    /* PAN: the vendor's own (migration 20260927130000), else lifted from a well-formed GSTIN. */
    const panByVid = new Map<string, string>();
    if (vids.length) {
      const { data: vends } = await supabase.from("vendors").select("id, gstin, pan").in("id", vids);
      for (const v of vends ?? []) panByVid.set(v.id, v.pan ?? panFromGstin(v.gstin) ?? "");
    }
    const panFrom = (vid: string | null | undefined) => (vid ? panByVid.get(vid) ?? "" : "");
    const rows = exps.slice()
      .sort((a, b) => (a.vendor_name ?? "").localeCompare(b.vendor_name ?? "") || a.expense_date.localeCompare(b.expense_date))
      .map((e) => [
        e.vendor_name ?? "—",
        panFrom(e.vendor_id),
        e.tds_section ?? "",
        e.expense_date,
        (e.amount ?? 0) - (e.gst_paid ?? 0),   // amount on which TDS applies (ex-GST base)
        e.tds_amount ?? 0,
      ]);
    const esc = (v: string | number) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [["Deductee (vendor)", "PAN", "Section", "Date", "Amount paid (ex-GST)", "TDS deducted"], ...rows]
      .map((r) => r.map(esc).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `26Q-working-${range.from}-to-${range.to}.csv`; a.click();
    URL.revokeObjectURL(url);
    const totalTds = exps.reduce((s, e) => s + (e.tds_amount ?? 0), 0);
    const missingPan = rows.filter((r) => !r[1]).length;
    let msg = `26Q working — ${rows.length} rows, TDS ${rupee(totalTds)}. Import into your TDS software / RPU (app can't make the FVU).`;
    if (missingPan) msg += ` ⚠ ${missingPan} row(s) missing PAN — add it on the Vendors page (bina PAN ke 20% u/s 206AA).`;
    toast.success(msg);
  }

  /* One desktop row — rendered flat or under a vendor / category group header. */
  const renderDesktopRow = (e: Expense) => {
    const noBill = e.bill_type === "none" && !isPayrollExpense(e);
    return (
          <tr key={e.id}
            className={`border-b border-hairline last:border-0 hover:bg-paper-2/40 cursor-pointer align-top ${selectedIds.has(e.id) ? "bg-amber-soft/40" : ""}`}
            onClick={() => openRow(e)}>
            {/* Bulk-select checkbox — only for settle-able payables */}
            <td className="px-2 py-2.5" onClick={(ev) => ev.stopPropagation()}>
              {bulkEligible(e) && (
                <input
                  type="checkbox"
                  aria-label={`Select ${e.category}`}
                  className="align-middle accent-amber cursor-pointer"
                  checked={selectedIds.has(e.id)}
                  onChange={() => toggleOne(e.id)}
                />
              )}
            </td>
            {/* Date — its own column so it can be sorted (R-213) */}
            <td className="px-3 py-2.5 text-ink-2 whitespace-nowrap">{formatDate(e.expense_date)}</td>
            {/* Expense: category + status + bill chip, then a muted meta line */}
            <td className="px-3 py-2.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-medium text-ink truncate">{e.category}</span>
                {isPayrollExpense(e)
                  ? (() => { const t = reconcileTag(e, salByExpense.get(e.id)); return t ? <ReconcileTag {...t} /> : null; })()
                  : <PayBadge e={e} today={today} />}
                {e.bill_type === "kaccha" && <BillChip tone="amber" label="Kaccha" title="Non-GST (kaccha) bill" />}
                {e.bill_type === "none" && !isPayrollExpense(e) && <BillChip tone="rose" label="No bill" title="No bill/receipt attached yet" />}
              </div>
              {(e.payment_method || e.description) && (
                <div className="text-xs text-ink-3 truncate mt-0.5" title={e.description ?? undefined}>
                  {[e.payment_method, e.description].filter(Boolean).join(" · ")}
                </div>
              )}
            </td>
            {/* Vendor */}
            <td className="px-3 py-2.5 text-ink-2 truncate" title={e.vendor_name ?? undefined}>{e.vendor_name ?? "—"}</td>
            {/* Amount (+ GST + FX as sub-lines) */}
            <td className="px-3 py-2.5 text-right">
              <div className="font-semibold text-ink font-mono">{rupee(e.amount)}</div>
              {e.gst_paid > 0 && <div className="text-xs text-emerald">+{rupee(e.gst_paid)} GST</div>}
              {(() => { const fx = foreignAmount(e.currency, e.amount, e.fx_rate); return fx ? <div className="text-xs text-ink-3">{fx}</div> : null; })()}
            </td>
            {/* Actions — icon-first, wrap instead of overflowing */}
            <td className="px-3 py-2.5" onClick={(ev) => ev.stopPropagation()}>
              <div className="flex items-center justify-end gap-0.5 flex-wrap">
                {noBill && (
                  <IconButton icon="upload" size="sm" variant="ghost" aria-label="Upload receipt"
                    title="Upload receipt / bill" onClick={() => setEditing(e)} />
                )}
                {!e.paid && !isPayrollExpense(e) && (
                  <Button variant="default" className="h-7 px-2 py-0 text-xs"
                    onClick={() => setPayingExpense(e)}>Mark paid</Button>
                )}
                {canReconcile(e) && (
                  <Button variant="default" className="h-7 px-2 py-0 text-xs"
                    onClick={() => startReconcile(e)}>Reconcile</Button>
                )}
                <IconButton icon="edit" size="sm" variant="ghost" aria-label="Edit expense" onClick={() => setEditing(e)} />
                <IconButton icon="trash" size="sm" variant="ghost" aria-label="Delete expense"
                  onClick={async () => { if (await confirm({ title: `Delete this expense?`, danger: true, confirmLabel: "Delete" })) del.mutate(e.id); }} />
              </div>
            </td>
          </tr>
    );
  };

  /* One mobile card — flat or under a group header. */
  const renderMobileCard = (e: Expense) => (
        <Card className={`p-4 cursor-pointer ${selectedIds.has(e.id) ? "ring-1 ring-amber/50 bg-amber-soft/30" : ""}`} onClick={() => openRow(e)}>
          <div className="flex items-start justify-between gap-2 mb-1">
            {bulkEligible(e) && (
              <input
                type="checkbox"
                aria-label={`Select ${e.category}`}
                className="mt-1 accent-amber cursor-pointer shrink-0"
                checked={selectedIds.has(e.id)}
                onClick={(ev) => ev.stopPropagation()}
                onChange={() => toggleOne(e.id)}
              />
            )}
            <div className="font-medium text-ink leading-tight flex-1">
              {e.category}
              {e.bill_type === "kaccha" && <span className="ml-1.5 text-3xs uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-soft/60 text-amber-ink align-middle">Kaccha bill</span>}
              {e.bill_type === "none" && <span className="ml-1.5 text-3xs uppercase tracking-wide px-1.5 py-0.5 rounded bg-paper-2 text-ink-3 align-middle">No bill</span>}
              {isPayrollExpense(e)
                ? (() => { const t = reconcileTag(e, salByExpense.get(e.id)); return t ? <ReconcileTag {...t} /> : null; })()
                : <PayBadge e={e} today={today} />}
            </div>
            <div className="font-serif text-xl text-ink leading-none">{rupee(e.amount)}</div>
            {(() => { const fx = foreignAmount(e.currency, e.amount, e.fx_rate); return fx ? <div className="text-xs text-ink-3">{fx} @ ₹{e.fx_rate}/{e.currency}</div> : null; })()}
          </div>
          <div className="text-xs text-ink-3 mb-1.5">
            {formatDate(e.expense_date)} · {e.payment_method ?? "—"}
          </div>
          {e.vendor_name && <div className="text-xs text-ink-2 mb-1">{e.vendor_name}</div>}
          {e.description && <div className="text-xs text-ink-3 mb-2">{e.description}</div>}
          <div className="flex items-center justify-between">
            {e.gst_paid > 0 && (
              <span className="text-xs text-emerald">+{foreignAmount(e.currency, e.gst_paid, e.fx_rate) ?? rupee(e.gst_paid)} input GST</span>
            )}
            <div className="ml-auto flex items-center gap-1">
              {!e.paid && !isPayrollExpense(e) && (
                <Button variant="default" className="h-7 px-2 py-0 text-xs mr-1"
                  onClick={(ev) => { ev.stopPropagation(); setPayingExpense(e); }}>
                  Mark paid
                </Button>
              )}
              {canReconcile(e) && (
                <Button variant="default" className="h-7 px-2 py-0 text-xs mr-1"
                  onClick={(ev) => { ev.stopPropagation(); startReconcile(e); }}>
                  Reconcile
                </Button>
              )}
              <IconButton icon="edit" aria-label="Edit expense" onClick={(ev) => { ev.stopPropagation(); setEditing(e); }} />
              <IconButton
                icon="trash"
                aria-label="Delete expense"
                onClick={async (ev) => {
                  ev.stopPropagation();
                  if (await confirm({ title: `Delete this expense?`, danger: true, confirmLabel: "Delete" })) del.mutate(e.id);
                }}
              />
            </div>
          </div>
        </Card>
  );
  const renderMobileRow = (e: Expense) => <li key={e.id}>{renderMobileCard(e)}</li>;

  /* R-213: the flat list is on the shared DataTable — click Date / Expense / Vendor /
     Amount to sort, "Views" to save the filters. The first column keeps this page's own
     select (only unpaid operating expenses can be bulk-paid), so the DataTable's
     every-row checkbox is not used. Grouped view (vendor / category subtotals) keeps its
     own table below — DataTable has no group rows. */
  const columns: DataTableColumn<Expense>[] = [
    {
      id: "select",
      width: "4%",
      header: (
        <input
          type="checkbox"
          aria-label="Select all payable expenses"
          className="align-middle accent-amber cursor-pointer disabled:opacity-30"
          checked={allEligibleSelected}
          disabled={eligibleRows.length === 0}
          onChange={toggleAll}
        />
      ),
    },
    { id: "date", header: "Date", width: "11%", sortValue: EXPENSE_SORT.date },
    { id: "expense", header: "Expense", width: "31%", sortValue: EXPENSE_SORT.expense },
    { id: "vendor", header: "Vendor / payee", width: "18%", sortValue: EXPENSE_SORT.vendor },
    { id: "amount", header: "Amount", width: "16%", align: "right", sortValue: EXPENSE_SORT.amount },
    { id: "actions", header: "Actions", width: "20%", align: "right" },
  ];

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header — eyebrow + title left, primary action pinned top-right.
          The descriptive text lives in the collapsible below, not here. */}
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Purchases</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Expenses</h1>
        </div>
        <div className="hidden md:flex items-center gap-2 shrink-0">
          <Button variant="outline" icon="download" onClick={export26Q}
            title="26Q working — non-salary TDS you deducted (rent/professional/contractor) for the selected date range">
            26Q (TDS)
          </Button>
          <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
            Add Expense
          </Button>
        </div>
      </div>

      {/* About + how it works — one collapsed inline panel (above the KPIs) so
          the numbers + list sit right at the top. Expand for the guidance. */}
      <details className="group mb-3 rounded-lg border border-hairline bg-paper-2/30">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[12px] font-medium text-ink-2 select-none">
          <Icon name="info" size={13} className="text-amber-ink shrink-0" />
          About expenses — what goes here &amp; how payments work
          <Icon name="chevron_down" size={14} className="ml-auto text-ink-3 transition-transform group-open:rotate-180" />
        </summary>
        <div className="px-3 pb-3 space-y-1.5 text-[12px] text-ink-2 leading-relaxed">
          <p>
            Operating spend — rent, salaries, stationery, your own software, marketing. These sit below the gross-margin line in your P&amp;L. Bills for products you <b>resell</b> (Google/Microsoft/Zoho) go in <b>COGS Bills</b> instead.
          </p>
          <p>
            <b>How it works:</b> record the cost <b>once</b> here — it hits your P&amp;L. When you actually pay the vendor, that money-out is <b>reconciled in Banking</b> against this expense — don&apos;t enter it again as a second expense. Paying by <b>cash</b>? pick a petty-cash account and it&apos;s deducted from cash-in-hand automatically.
          </p>
        </div>
      </details>

      {/* KPI strip — tight inline stats, minimal height. Columns fit the space (R-177: at 800px a fixed
          3-up grid cut "TOTAL SPEND" / "TOP CATEGORY" to "TOTAL SPE…"); each tile is at least 9.5rem wide. */}
      <div className="grid grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2 mb-3">
        <KPI label="Entries" value={totals ? String(totals.count) : "—"} />
        <KPI label="Total spend"  value={totals ? rupee(totals.amount) : "—"} tone="rose" />
        <KPI label="Input GST"    value={totals ? rupee(totals.gstPaid) : "—"} tone="emerald" />
        {/* Outstanding = ALL unpaid payables (any date). Click to filter. */}
        <button type="button" onClick={() => setUnpaidOnly(!unpaidOnly)} className="text-left"
          title="Show only what's still to pay" aria-pressed={unpaidOnly}>
          <KPI label="To pay" value={payableQ.data ? rupee(payableQ.data.amount) : "—"}
               tone={payableQ.data && payableQ.data.amount > 0 ? "amber" : undefined}
               sub={payableQ.data && payableQ.data.count > 0 ? `${payableQ.data.count} unpaid` : "all clear"} />
        </button>
        {/* R-118: opens that category's entries. */}
        {(() => {
          const top = totals && categoryOptions.length > 0
            ? Object.entries(totals.byCategory).sort((a, b) => b[1] - a[1])[0][0]
            : null;
          return top ? (
            <button type="button" onClick={() => setCatFilter(top)} className="text-left"
              title={`Show ${top} expenses`} aria-pressed={catFilter === top}>
              <KPI label="Top category" value={top} />
            </button>
          ) : <KPI label="Top category" value="—" />;
        })()}
      </div>

      {/* Filter bar — compact: presets + count on one line, inputs on the next. */}
      <Card className="mb-4 p-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {RANGE_PRESETS.map((p) => {
            const r = p.range();
            const active = range.from === r.from && range.to === r.to;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setRange(r)}
                className={`rounded-full px-2.5 py-0.5 text-2xs font-medium border transition-colors ${
                  active
                    ? "bg-amber text-white border-amber"
                    : "bg-paper border-hairline text-ink-2 hover:border-hairline-strong"
                }`}
              >
                {p.label}
              </button>
            );
          })}
          <span className="mx-1 h-4 w-px bg-hairline" aria-hidden />
          <button
            type="button"
            onClick={() => setUnpaidOnly(!unpaidOnly)}
            aria-pressed={unpaidOnly}
            className={`rounded-full px-2.5 py-0.5 text-2xs font-medium border transition-colors ${
              unpaidOnly
                ? "bg-amber text-white border-amber"
                : "bg-paper border-hairline text-ink-2 hover:border-hairline-strong"
            }`}
          >
            To pay{payableQ.data && payableQ.data.count > 0 ? ` · ${payableQ.data.count}` : ""}
          </button>
          {/* Flat list: the table's own "Showing x of y" says this (R-213). */}
          {groupBy !== "none" && (
            <span className="ml-auto text-xs text-ink-3">
              {rows.length} {rows.length === 1 ? "entry" : "entries"}
            </span>
          )}
        </div>
        <div className="mt-2">
          <div className="relative">
            <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search expenses — category, vendor, note or amount…"
              aria-label="Search expenses"
              className="w-full pl-8 pr-8 py-1.5 text-[13px] rounded-md border border-hairline bg-paper focus:outline-none focus:border-hairline-strong"
            />
            {search && (
              <button type="button" onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink" aria-label="Clear search">
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <input type="date" value={range.from} aria-label="From date"
            onChange={(e) => setFrom(e.target.value)}
            className="px-2 py-1 text-[13px] rounded-md border border-hairline bg-paper" />
          <span className="text-ink-3 text-xs">–</span>
          <input type="date" value={range.to} aria-label="To date"
            onChange={(e) => setTo(e.target.value)}
            className="px-2 py-1 text-[13px] rounded-md border border-hairline bg-paper" />
          <select aria-label="Category filter" value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="px-2 py-1 text-[13px] rounded-md border border-hairline bg-paper">
            <option value="">All categories</option>
            {categoryOptions.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select aria-label="Vendor / payee filter" value={payeeFilter}
            onChange={(e) => setPayeeFilter(e.target.value)}
            className="px-2 py-1 text-[13px] rounded-md border border-hairline bg-paper max-w-[180px]">
            <option value="">All vendors / payees</option>
            {payeeOptions.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          {isFiltered && (
            <button type="button" onClick={() => { setCatFilter(""); setPayeeFilter(""); setUnpaidOnly(false); setSearch(""); }}
              className="text-xs text-amber-ink hover:underline">Clear</button>
          )}
          {/* Group the list — subtotal per vendor / category. */}
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="Group expenses by">
            <span className="text-xs text-ink-3 mr-0.5">Group by</span>
            {([["none", "None"], ["vendor", "Vendor"], ["category", "Category"]] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={groupBy === k}
                onClick={() => { setGroupBy(k); setCollapsed(new Set()); }}
                className={`text-xs px-2 py-1 rounded-md border transition-colors ${
                  groupBy === k ? "border-amber bg-amber-soft text-amber-ink font-semibold" : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {/* Filtered summary — total paid + input GST for the current filter. */}
        {isFiltered && rows.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-paper-2/50 px-2.5 py-1.5 text-[13px]">
            <span className="text-ink-3">
              {payeeFilter || catFilter}{payeeFilter && catFilter ? ` · ${catFilter}` : ""}
            </span>
            <span className="text-ink-2"><b className="text-ink font-mono tabular-nums">{rupee(filtered.amount)}</b> paid</span>
            <span className="text-emerald"><b className="font-mono tabular-nums">{rupee(filtered.gst)}</b> input GST</span>
          </div>
        )}
      </Card>

      {/* Bulk action bar — appears once you tick payables. One date+method
          settles the whole batch (non-cash). */}
      {selectedRows.length > 0 && (
        <div className="sticky top-2 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber/40 bg-amber-soft/60 px-3 py-2 shadow-sm">
          <span className="text-[13px] font-medium text-amber-ink">
            {selectedRows.length} selected · <span className="font-mono tabular-nums">{rupee(selectedTotal)}</span>
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" className="h-7 px-2 text-[12px]" onClick={clearSelection}>Clear</Button>
            <Button variant="primary" icon="check" className="h-7 px-3 text-[12px]" onClick={() => setBulkPayOpen(true)}>
              Mark {selectedRows.length} paid
            </Button>
          </div>
        </div>
      )}

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : q.isError ? (
        <Card className="py-2">
          <EmptyState
            icon="alert"
            title="Expenses load nahi ho paye"
            body="Ye data load karne me dikkat aayi — aapke expenses safe hain, bas dikh nahi rahe. Dobara try karo."
            action={<Button variant="primary" icon="refresh" onClick={() => q.refetch()}>Try again</Button>}
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="rupee"
            title="No expenses in this range"
            body="Track your operating expenses so the P&L shows real net profit, not just gross margin."
            action={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>Add your first expense</Button>}
          />
        </Card>
      ) : groupBy === "none" ? (
        <DataTable
          urlKey="sort"
          rows={rows}
          columns={columns}
          getRowId={(e) => e.id}
          totalCount={allRows.length}
          noun="expense"
          views={{ storageKey: "expenses", current: viewState, apply: applyView }}
          cardsBelow="md"
          mobileCard={(e) => renderMobileCard(e)}
          renderRow={(e) => renderDesktopRow(e)}
        />
      ) : (
        <>
          {/* Grouped view (vendor / category subtotals) — own table, same columns as the
              DataTable above. FLUID (table-fixed + % widths): no horizontal scroll. */}
          <Card flush className="hidden md:block">
            <div className="overflow-y-auto max-h-[calc(100vh-15rem)]">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col style={{ width: "4%" }} />
                <col style={{ width: "11%" }} />
                <col style={{ width: "31%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "20%" }} />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-paper-2 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="px-2 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Select all payable expenses"
                      className="align-middle accent-amber cursor-pointer disabled:opacity-30"
                      checked={allEligibleSelected}
                      disabled={eligibleRows.length === 0}
                      onChange={toggleAll}
                    />
                  </th>
                  <th className="text-left  px-3 py-2.5">Date</th>
                  <th className="text-left  px-3 py-2.5">Expense</th>
                  <th className="text-left  px-3 py-2.5">Vendor / payee</th>
                  <th className="text-right px-3 py-2.5">Amount</th>
                  <th className="text-right px-3 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <React.Fragment key={g.key}>
                    <tr className="bg-paper-2/70 border-b border-hairline">
                      <td colSpan={4} className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => toggleGroup(g.key)}
                          aria-expanded={!collapsed.has(g.key)}
                          className="flex items-center gap-1.5 text-left font-semibold text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded"
                        >
                          <Icon name={collapsed.has(g.key) ? "chevron_right" : "chevron_down"} size={14} className="text-ink-3" />
                          {g.label}
                          <span className="text-xs font-normal text-ink-3">· {g.count} {g.count === 1 ? "entry" : "entries"}</span>
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="font-semibold text-ink font-mono">{rupee(g.total)}</div>
                        {g.gst > 0 && <div className="text-xs text-emerald">+{rupee(g.gst)} GST</div>}
                      </td>
                      <td />
                    </tr>
                    {!collapsed.has(g.key) && g.rows.map(renderDesktopRow)}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            </div>
          </Card>

          {/* Mobile cards */}
          <ul className="md:hidden space-y-2.5">
            {groups.map((g) => (
              <React.Fragment key={g.key}>
                <li>
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.key)}
                    aria-expanded={!collapsed.has(g.key)}
                    className="w-full flex items-center justify-between gap-2 rounded-md bg-paper-2/70 px-3 py-2 text-left"
                  >
                    <span className="flex items-center gap-1.5 font-semibold text-ink">
                      <Icon name={collapsed.has(g.key) ? "chevron_right" : "chevron_down"} size={14} className="text-ink-3" />
                      {g.label} <span className="text-xs font-normal text-ink-3">· {g.count}</span>
                    </span>
                    <span className="font-mono font-semibold text-ink">{rupee(g.total)}</span>
                  </button>
                </li>
                {!collapsed.has(g.key) && g.rows.map(renderMobileRow)}
              </React.Fragment>
            ))}
          </ul>
        </>
      )}

      <FAB icon="plus" label="Expense" onClick={() => setAddOpen(true)} ariaLabel="Add Expense" />
      {addOpen && <AddExpenseDialog onClose={() => setAddOpen(false)} />}
      {editing && <AddExpenseDialog expense={editing} onClose={() => setEditing(null)} />}
      {detail && (
        <ExpenseDetailDialog
          expense={detail}
          onEdit={() => { const e = detail; setDetail(null); setEditing(e); }}
          onClose={() => setDetail(null)}
        />
      )}
      {payingExpense && (
        <MarkPaidDialog expense={payingExpense} onClose={() => setPayingExpense(null)} />
      )}
      {bulkPayOpen && selectedRows.length > 0 && (
        <BulkMarkPaidDialog
          expenses={selectedRows}
          onClose={() => setBulkPayOpen(false)}
          onDone={clearSelection}
        />
      )}
      {reconcilingExpense && (
        <ReconcileExpenseDialog expense={reconcilingExpense} onClose={() => setReconcilingExpense(null)} />
      )}
    </div>
  );
}

function KPI({
  label, value, tone, sub,
}: {
  label: string;
  value: string;
  tone?: "emerald" | "rose" | "amber";
  sub?: string;
}) {
  const colorClass = tone === "emerald" ? "text-emerald"
                   : tone === "rose"    ? "text-rose"
                   : tone === "amber"   ? "text-amber-ink"
                   : "text-ink";
  return (
    <Card className="p-2.5">
      {/* Label wraps instead of cutting; a long value (category name) keeps its full text on hover. */}
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-0.5 leading-tight break-words">{label}</div>
      <div className={`font-serif text-lg md:text-xl ${colorClass} leading-tight truncate`} title={value}>{value}</div>
      {sub && <div className="text-xs text-ink-3 truncate">{sub}</div>}
    </Card>
  );
}
