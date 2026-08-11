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
import { rupee, formatDate, foreignAmount } from "@/lib/utils";
import {
  useExpenses,
  useExpensesTotals,
  useDeleteExpense,
  useOutstandingPayable,
  expensePayStatus,
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

type DateRange = { from: string; to: string };

/** Reconcile tag shown next to a Salaries expense's category. Salary expenses
 *  reflect their salary's paid-status (which supports PARTIAL payments); every
 *  other expense uses its own reconciled_txn_id. */
type SalMini = { paid_status: "unpaid" | "partial" | "paid"; paid_amount: number; net: number };
function reconcileTag(e: Expense, sal?: SalMini):
  { tone: "emerald" | "amber"; label: string; title?: string } | null {
  if (e.category === "Salaries" && sal) {
    if (sal.paid_status === "paid") return { tone: "emerald", label: "✓ Paid" };
    if (sal.paid_status === "partial") {
      return {
        tone: "amber",
        label: `◐ Partial · ${rupee(sal.paid_amount)}/${rupee(sal.net)}`,
        title: `Partly paid — ${rupee(sal.net - sal.paid_amount)} still owed. Reconcile another bank line in Banking to clear it.`,
      };
    }
    return { tone: "amber", label: "To pay", title: "Salary not paid yet — pay it and reconcile in Banking." };
  }
  // Statutory / other payroll posting: reconciled bank line = Paid, else payable.
  if (e.reconciled_txn_id) return { tone: "emerald", label: "✓ Paid" };
  return { tone: "amber", label: "To pay", title: "Not settled yet — reconcile its bank line to confirm." };
}
function ReconcileTag({ tone, label, title }: { tone: "emerald" | "amber"; label: string; title?: string }) {
  const cls = tone === "emerald" ? "bg-emerald/10 text-emerald" : "bg-amber-soft text-amber-ink";
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full ${cls} px-2 py-0.5 text-[10px] font-medium align-middle`}>
      <Icon name={tone === "emerald" ? "check_circle" : "clock"} size={11} />
      {label}
    </span>
  );
}

/**
 * Status chip for a non-payroll expense. Two independent facts:
 *   • Paid vs To-pay — did the money leave (the operator's record)?
 *   • Reconciled — has it been matched to a bank/cash line (bank-verified)?
 * So a paid expense reads "Paid" straight away; once it reconciles it gains a
 * "✓ Paid" tick (bank-verified). An open bill reads "To pay" / "Overdue".
 */
function PayBadge({ e, today }: { e: Expense; today: string }) {
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium align-middle";
  if (!e.paid) {
    const overdue = expensePayStatus(e, today) === "overdue";
    return (
      <span
        title={overdue ? "Payable overdue — settle it and Mark paid." : "Payable — not paid yet."}
        className={`${base} ${overdue ? "bg-rose/10 text-rose" : "bg-amber-soft text-amber-ink"}`}
      >
        <Icon name={overdue ? "alert" : "clock"} size={11} />
        {overdue ? "Overdue" : "To pay"}
      </span>
    );
  }
  if (e.reconciled_txn_id) {
    return (
      <span title="Paid & bank-verified — matched to a bank/cash line." className={`${base} bg-emerald/10 text-emerald`}>
        <Icon name="check_circle" size={11} /> Paid
      </span>
    );
  }
  return (
    <span title="Payment recorded. Reconcile it against the bank line to bank-verify." className={`${base} border border-emerald/30 text-emerald`}>
      <Icon name="check" size={11} /> Paid
    </span>
  );
}

/** Bill-presence chip — makes "Missing bill" / kaccha clearly visible. */
function BillChip({ tone, label, title }: { tone: "rose" | "amber"; label: string; title?: string }) {
  const cls = tone === "rose" ? "bg-rose/10 text-rose" : "bg-amber-soft/70 text-amber-ink";
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full ${cls} px-1.5 py-0.5 text-[9px] uppercase tracking-wide font-semibold align-middle`}>
      <Icon name="alert" size={10} /> {label}
    </span>
  );
}

/** Payroll / statutory postings (salaries, employer ESI/PF, TDS) are generated
 *  by the Payroll module — they carry no bill or line items, so they get no
 *  items editor and clicking one jumps to Payroll (their real home) instead of
 *  the bill-style detail. */
function isPayrollExpense(e: { category?: string | null; payment_method?: string | null }): boolean {
  const cat = e.category ?? "";
  return (
    cat === "Salaries" ||
    e.payment_method === "statutory" ||
    /\b(ESI|EPF|PF|Provident|Gratuity|Bonus|TDS)\b/i.test(cat)
  );
}

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
  const [range, setRange]     = React.useState(RANGE_PRESETS[0].range());
  const [catFilter, setCatFilter] = React.useState("");
  const [payeeFilter, setPayeeFilter] = React.useState("");
  const [unpaidOnly, setUnpaidOnly] = React.useState(false);
  const [search, setSearch] = React.useState("");
  // Deep-link from Purchase Report ("Open" on a vendor line) → pre-fill search.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) setSearch(q);
  }, []);
  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Expense | null>(null);
  const [detail, setDetail]   = React.useState<Expense | null>(null);
  const [payingExpense, setPayingExpense] = React.useState<Expense | null>(null);
  const [reconcilingExpense, setReconcilingExpense] = React.useState<Expense | null>(null);
  // Bulk "Mark paid" — selected expense ids + the batch dialog.
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [bulkPayOpen, setBulkPayOpen] = React.useState(false);
  const today = new Date().toISOString().slice(0, 10);
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

  const allRows   = q.data ?? [];
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
  const q_ = search.trim().toLowerCase();
  const rows = allRows.filter((e) =>
    (!payeeFilter || (e.vendor_name ?? "") === payeeFilter) &&
    (!unpaidOnly || rowOwes(e)) &&
    (!q_ || [e.category, e.vendor_name, e.description, e.payment_method, String(e.amount)]
      .some((f) => (f ?? "").toString().toLowerCase().includes(q_))),
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
    const gstinByVid = new Map<string, string | null>();
    if (vids.length) {
      const { data: vends } = await supabase.from("vendors").select("id, gstin").in("id", vids);
      for (const v of vends ?? []) gstinByVid.set(v.id, v.gstin ?? null);
    }
    const panFrom = (g: string | null | undefined) => (g && g.length >= 12 ? g.slice(2, 12) : "");
    const rows = exps.slice()
      .sort((a, b) => (a.vendor_name ?? "").localeCompare(b.vendor_name ?? "") || a.expense_date.localeCompare(b.expense_date))
      .map((e) => [
        e.vendor_name ?? "—",
        panFrom(gstinByVid.get(e.vendor_id ?? "")),
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
    if (missingPan) msg += ` ⚠ ${missingPan} row(s) missing PAN — add the vendor's GSTIN.`;
    toast.success(msg);
  }

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

      {/* KPI strip — tight inline stats, minimal height. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-3">
        <KPI label="Entries" value={totals ? String(totals.count) : "—"} />
        <KPI label="Total spend"  value={totals ? rupee(totals.amount) : "—"} tone="rose" />
        <KPI label="Input GST"    value={totals ? rupee(totals.gstPaid) : "—"} tone="emerald" />
        {/* Outstanding = ALL unpaid payables (any date). Click to filter. */}
        <button type="button" onClick={() => setUnpaidOnly((v) => !v)} className="text-left"
          title="Show only what's still to pay" aria-pressed={unpaidOnly}>
          <KPI label="To pay" value={payableQ.data ? rupee(payableQ.data.amount) : "—"}
               tone={payableQ.data && payableQ.data.amount > 0 ? "amber" : undefined}
               sub={payableQ.data && payableQ.data.count > 0 ? `${payableQ.data.count} unpaid` : "all clear"} />
        </button>
        <KPI label="Top category"
             value={totals && categoryOptions.length > 0
               ? Object.entries(totals.byCategory).sort((a, b) => b[1] - a[1])[0][0]
               : "—"} />
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
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium border transition-colors ${
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
            onClick={() => setUnpaidOnly((v) => !v)}
            aria-pressed={unpaidOnly}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium border transition-colors ${
              unpaidOnly
                ? "bg-amber text-white border-amber"
                : "bg-paper border-hairline text-ink-2 hover:border-hairline-strong"
            }`}
          >
            To pay{payableQ.data && payableQ.data.count > 0 ? ` · ${payableQ.data.count}` : ""}
          </button>
          <span className="ml-auto text-[11px] text-ink-3">
            {rows.length} {rows.length === 1 ? "entry" : "entries"}
          </span>
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
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            className="px-2 py-1 text-[13px] rounded-md border border-hairline bg-paper" />
          <span className="text-ink-3 text-xs">–</span>
          <input type="date" value={range.to} aria-label="To date"
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            className="px-2 py-1 text-[13px] rounded-md border border-hairline bg-paper" />
          <select value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="px-2 py-1 text-[13px] rounded-md border border-hairline bg-paper">
            <option value="">All categories</option>
            {categoryOptions.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select value={payeeFilter}
            onChange={(e) => setPayeeFilter(e.target.value)}
            className="px-2 py-1 text-[13px] rounded-md border border-hairline bg-paper max-w-[180px]">
            <option value="">All vendors / payees</option>
            {payeeOptions.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          {isFiltered && (
            <button type="button" onClick={() => { setCatFilter(""); setPayeeFilter(""); setUnpaidOnly(false); setSearch(""); }}
              className="text-[11px] text-amber-ink hover:underline">Clear</button>
          )}
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
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="rupee"
            title="No expenses in this range"
            body="Track your operating expenses so the P&L shows real net profit, not just gross margin."
            action={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>Add your first expense</Button>}
          />
        </Card>
      ) : (
        <>
          {/* Desktop table — FLUID (table-fixed + % widths) so it always fits the
              container with NO horizontal scroll. Date / method / GST are folded
              into rich cells; status badge + bill chip sit with the category. */}
          <Card flush className="hidden md:block">
            <div className="overflow-y-auto max-h-[calc(100vh-15rem)]">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col style={{ width: "4%" }} />
                <col style={{ width: "40%" }} />
                <col style={{ width: "20%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "20%" }} />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-paper-2 text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
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
                  <th className="text-left  px-3 py-2.5">Expense</th>
                  <th className="text-left  px-3 py-2.5">Vendor / payee</th>
                  <th className="text-right px-3 py-2.5">Amount</th>
                  <th className="text-right px-3 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((e) => {
                  const noBill = e.bill_type === "none" && !isPayrollExpense(e);
                  return (
                  <tr key={e.id}
                    className={`hover:bg-paper-2/40 cursor-pointer align-top ${selectedIds.has(e.id) ? "bg-amber-soft/40" : ""}`}
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
                      <div className="text-[11px] text-ink-3 truncate mt-0.5" title={e.description ?? undefined}>
                        {formatDate(e.expense_date)}
                        {e.payment_method ? ` · ${e.payment_method}` : ""}
                        {e.description ? ` · ${e.description}` : ""}
                      </div>
                    </td>
                    {/* Vendor */}
                    <td className="px-3 py-2.5 text-ink-2 truncate" title={e.vendor_name ?? undefined}>{e.vendor_name ?? "—"}</td>
                    {/* Amount (+ GST + FX as sub-lines) */}
                    <td className="px-3 py-2.5 text-right">
                      <div className="font-semibold text-ink font-mono">{rupee(e.amount)}</div>
                      {e.gst_paid > 0 && <div className="text-[10px] text-emerald">+{rupee(e.gst_paid)} GST</div>}
                      {(() => { const fx = foreignAmount(e.currency, e.amount, e.fx_rate); return fx ? <div className="text-[10px] text-ink-3">{fx}</div> : null; })()}
                    </td>
                    {/* Actions — icon-first, wrap instead of overflowing */}
                    <td className="px-3 py-2.5" onClick={(ev) => ev.stopPropagation()}>
                      <div className="flex items-center justify-end gap-0.5 flex-wrap">
                        {noBill && (
                          <IconButton icon="upload" size="sm" variant="ghost" aria-label="Upload receipt"
                            title="Upload receipt / bill" onClick={() => setEditing(e)} />
                        )}
                        {!e.paid && !isPayrollExpense(e) && (
                          <Button variant="default" className="h-7 px-2 py-0 text-[11px]"
                            onClick={() => setPayingExpense(e)}>Mark paid</Button>
                        )}
                        {canReconcile(e) && (
                          <Button variant="default" className="h-7 px-2 py-0 text-[11px]"
                            onClick={() => startReconcile(e)}>Reconcile</Button>
                        )}
                        <IconButton icon="edit" size="sm" variant="ghost" aria-label="Edit expense" onClick={() => setEditing(e)} />
                        <IconButton icon="trash" size="sm" variant="ghost" aria-label="Delete expense"
                          onClick={async () => { if (await confirm({ title: `Delete this expense?`, danger: true, confirmLabel: "Delete" })) del.mutate(e.id); }} />
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </Card>

          {/* Mobile cards */}
          <ul className="md:hidden space-y-2.5">
            {rows.map((e) => (
              <li key={e.id}>
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
                      {e.bill_type === "kaccha" && <span className="ml-1.5 text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-soft/60 text-amber-ink align-middle">Kaccha bill</span>}
                      {e.bill_type === "none" && <span className="ml-1.5 text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-paper-2 text-ink-3 align-middle">No bill</span>}
                      {isPayrollExpense(e)
                        ? (() => { const t = reconcileTag(e, salByExpense.get(e.id)); return t ? <ReconcileTag {...t} /> : null; })()
                        : <PayBadge e={e} today={today} />}
                    </div>
                    <div className="font-serif text-xl text-ink leading-none">{rupee(e.amount)}</div>
                    {(() => { const fx = foreignAmount(e.currency, e.amount, e.fx_rate); return fx ? <div className="text-[11px] text-ink-3">{fx} @ ₹{e.fx_rate}/{e.currency}</div> : null; })()}
                  </div>
                  <div className="text-[11px] text-ink-3 mb-1.5">
                    {formatDate(e.expense_date)} · {e.payment_method ?? "—"}
                  </div>
                  {e.vendor_name && <div className="text-xs text-ink-2 mb-1">{e.vendor_name}</div>}
                  {e.description && <div className="text-xs text-ink-3 mb-2">{e.description}</div>}
                  <div className="flex items-center justify-between">
                    {e.gst_paid > 0 && (
                      <span className="text-[11px] text-emerald">+{foreignAmount(e.currency, e.gst_paid, e.fx_rate) ?? rupee(e.gst_paid)} input GST</span>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                      {!e.paid && !isPayrollExpense(e) && (
                        <Button variant="default" className="h-7 px-2 py-0 text-[11px] mr-1"
                          onClick={(ev) => { ev.stopPropagation(); setPayingExpense(e); }}>
                          Mark paid
                        </Button>
                      )}
                      {canReconcile(e) && (
                        <Button variant="default" className="h-7 px-2 py-0 text-[11px] mr-1"
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
              </li>
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
      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-0.5 truncate">{label}</div>
      <div className={`font-serif text-lg md:text-xl ${colorClass} leading-tight truncate`}>{value}</div>
      {sub && <div className="text-[10px] text-ink-3 truncate">{sub}</div>}
    </Card>
  );
}
