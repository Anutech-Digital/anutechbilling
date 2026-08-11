/**
 * P&L Report — Profit & Loss for the selected period.
 *
 *   Revenue          (from paid + outstanding invoices, accrual basis)
 * − COGS             (from vendor_bills with category='COGS-*')
 * = Gross Margin
 * − Operating Expenses (from expenses table)
 * = Net Profit
 *
 * Also shows the GST snapshot for the same period:
 *   Output GST collected  (CGST + SGST + IGST on invoices)
 * − Input GST paid        (on vendor bills + expenses with GST)
 * = Net GST liability
 *
 * Default range = current fiscal year (April 1 → today). Common quick-picks
 * (this month / quarter / FY) plus custom range.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Term } from "@/components/shared/term";
import { Button } from "@/components/ui/button";
import { rupee } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { createClient } from "@/lib/supabase/client";
import { PnLDrilldownDialog, type PnLDrillKind } from "@/components/features/accounting/pnl-drilldown-dialog";

// ────────────────────────────────────────────────────────────────
// Range helpers — all IST-safe (Indian FY runs Apr 1 → Mar 31)
// ────────────────────────────────────────────────────────────────

function istToday(): Date {
  const now = new Date();
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
}

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Indian fiscal year start (Apr 1) of the FY containing `d`. */
function fiscalYearStart(d: Date): Date {
  const yr = d.getUTCFullYear();
  const m  = d.getUTCMonth();
  // Months before April → previous calendar year's FY
  const fyYear = m < 3 ? yr - 1 : yr;
  return new Date(Date.UTC(fyYear, 3, 1)); // April 1
}

interface DateRange { from: string; to: string }

// Presets span the FULL calendar period (1st → last day) to match the GST and
// Expenses reports exactly — so the same month/quarter/FY reconciles across pages.
// (Future days carry no transactions, so month-to-date totals are unchanged.)
function thisMonth(): DateRange {
  const t = istToday();
  const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
  const last  = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0));
  return { from: yyyymmdd(first), to: yyyymmdd(last) };
}

function thisQuarter(): DateRange {
  const t = istToday();
  const qStart = Math.floor(t.getUTCMonth() / 3) * 3;
  const first = new Date(Date.UTC(t.getUTCFullYear(), qStart, 1));
  const last  = new Date(Date.UTC(t.getUTCFullYear(), qStart + 3, 0));
  return { from: yyyymmdd(first), to: yyyymmdd(last) };
}

function thisFY(): DateRange {
  const t = istToday();
  const fy = fiscalYearStart(t);
  const last = new Date(Date.UTC(fy.getUTCFullYear() + 1, 3, 0));   // 31 Mar next year
  return { from: yyyymmdd(fy), to: yyyymmdd(last) };
}

const QUICK_RANGES: { label: string; build: () => DateRange }[] = [
  { label: "This month",   build: thisMonth   },
  { label: "This quarter", build: thisQuarter },
  { label: "This FY",      build: thisFY      },
];

// ────────────────────────────────────────────────────────────────
// P&L aggregation hook
// ────────────────────────────────────────────────────────────────

interface PnLNumbers {
  revenue:        number;   // Invoices ≥ status='pending' within period
  revenueCount:   number;
  cogs:           number;   // Vendor bills category 'COGS-*' within period
  cogsCount:      number;
  grossMargin:    number;
  expenses:       number;
  expensesCount:  number;
  expensesByCategory: { category: string; total: number; count: number }[];
  commissions:      number;   // referral / channel-partner commissions (gross)
  commissionsCount: number;
  netProfit:      number;

  // GST snapshot
  outputGST: number;        // 18% of invoice subtotal proxy (using net_payable for simplicity)
  inputGST:  number;        // CGST + SGST + IGST on bills + gst_paid on expenses
  netGST:    number;

  // For quick scan
  marginPct: number;        // gross margin / revenue
  profitPct: number;        // net profit / revenue
}

function usePnL(range: DateRange) {
  return useQuery({
    queryKey: ["accounting", "pnl", range],
    queryFn: async (): Promise<PnLNumbers> => {
      const supabase = createClient();

      // ── Revenue: invoices issued in the period (accrual basis) ────
      // We include all non-draft / non-void invoices because the legal
      // revenue recognition point is invoice issue, not payment receipt.
      const { data: invoices, error: invErr } = await supabase
        .from("invoices")
        .select("amount, status, invoice_date, net_payable, taxable_value, tax_amount, tax_rate")
        .gte("invoice_date", range.from)
        .lte("invoice_date", range.to)
        .in("status", ["pending", "paid", "overdue"]);
      if (invErr) throw invErr;

      // Revenue = the TAXABLE value, never the GST-inclusive amount — output GST
      // is money owed to the government, not income (migration 0116 persists it).
      // Fall back to reverse-deriving for any legacy row missing the breakdown.
      const invTaxable = (i: { amount: number | null; taxable_value: number | null; tax_rate: number | null }) =>
        i.taxable_value ?? Math.round((i.amount ?? 0) * 100 / (100 + (i.tax_rate ?? 18)));
      const invTax = (i: { amount: number | null; tax_amount: number | null; taxable_value: number | null; tax_rate: number | null }) =>
        i.tax_amount ?? ((i.amount ?? 0) - invTaxable(i));

      // Credit / debit notes net revenue + output GST for the period (a credit
      // note reduces recognised revenue, a debit note increases it).
      const [{ data: cnP }, { data: dnP }] = await Promise.all([
        supabase.from("credit_notes").select("taxable_value, tax_amount, credit_date").gte("credit_date", range.from).lte("credit_date", range.to),
        supabase.from("debit_notes").select("taxable_value, tax_amount, debit_date").gte("debit_date", range.from).lte("debit_date", range.to),
      ]);
      const cnTaxable = (cnP ?? []).reduce((s, n) => s + (n.taxable_value ?? 0), 0);
      const cnTax     = (cnP ?? []).reduce((s, n) => s + (n.tax_amount ?? 0), 0);
      const dnTaxable = (dnP ?? []).reduce((s, n) => s + (n.taxable_value ?? 0), 0);
      const dnTax     = (dnP ?? []).reduce((s, n) => s + (n.tax_amount ?? 0), 0);

      const revenue       = (invoices ?? []).reduce((s, i) => s + invTaxable(i), 0) - cnTaxable + dnTaxable;
      const revenueCount  = (invoices ?? []).length;
      const outputGST     = (invoices ?? []).reduce((s, i) => s + invTax(i), 0) - cnTax + dnTax;

      // ── COGS: vendor bills with category like 'COGS-%' ────────────
      const { data: bills, error: bErr } = await supabase
        .from("vendor_bills")
        .select("total, subtotal, cgst, sgst, igst, category")
        .gte("bill_date", range.from)
        .lte("bill_date", range.to)
        .like("category", "COGS-%");
      if (bErr) throw bErr;

      const cogs      = (bills ?? []).reduce((s, b) => s + (b.subtotal ?? 0), 0);  // Pre-GST cost
      const cogsCount = (bills ?? []).length;
      const billsGst  = (bills ?? []).reduce((s, b) => s + (b.cgst ?? 0) + (b.sgst ?? 0) + (b.igst ?? 0), 0);

      // ── Expenses: non-COGS ─────────────────────────────────────────
      const { data: expenses, error: eErr } = await supabase
        .from("expenses")
        .select("amount, gst_paid, category")
        .gte("expense_date", range.from)
        .lte("expense_date", range.to);
      if (eErr) throw eErr;

      const expensesTotal = (expenses ?? []).reduce((s, e) => s + (e.amount ?? 0), 0);
      const expensesCount = (expenses ?? []).length;
      const expensesGst   = (expenses ?? []).reduce((s, e) => s + (e.gst_paid ?? 0), 0);

      // Break operating expenses down by category (Salaries, Rent, Software…),
      // biggest first — so you can see where the money went at a glance.
      const catAgg = (expenses ?? []).reduce<Record<string, { total: number; count: number }>>((m, e) => {
        const c = e.category || "Uncategorised";
        (m[c] ??= { total: 0, count: 0 }).total += e.amount ?? 0;
        m[c].count += 1;
        return m;
      }, {});
      const expensesByCategory = Object.entries(catAgg)
        .map(([category, v]) => ({ category, total: v.total, count: v.count }))
        .sort((a, b) => b.total - a.total);

      // ── Referral commissions earned in the period (operating expense) ──
      // The GROSS commission is the expense; TDS is only a withholding, not a
      // reduction. Cancelled accruals are excluded.
      const { data: comms } = await supabase
        .from("referral_commissions")
        .select("gross_commission, earned_date, status")
        .gte("earned_date", range.from)
        .lte("earned_date", range.to)
        .neq("status", "cancelled");
      const commissions      = (comms ?? []).reduce((s, c) => s + (c.gross_commission ?? 0), 0);
      const commissionsCount = (comms ?? []).length;

      // ── Compute derived numbers ─────────────────────────────────────
      const grossMargin = revenue - cogs;
      const netProfit   = grossMargin - expensesTotal - commissions;
      const inputGST    = billsGst + expensesGst;
      const netGST      = outputGST - inputGST;

      const marginPct = revenue > 0 ? (grossMargin / revenue) * 100 : 0;
      const profitPct = revenue > 0 ? (netProfit / revenue) * 100   : 0;

      return {
        revenue, revenueCount,
        cogs, cogsCount,
        grossMargin,
        expenses: expensesTotal, expensesCount, expensesByCategory,
        commissions, commissionsCount,
        netProfit,
        outputGST, inputGST, netGST,
        marginPct, profitPct,
      };
    },
  });
}

// ────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────

export default function PnLPage() {
  const [range, setRange] = React.useState<DateRange>(thisMonth());
  const { data, isLoading } = usePnL(range);
  const [drill, setDrill] = React.useState<PnLDrillKind | null>(null);
  const [drillExpenseCat, setDrillExpenseCat] = React.useState<string | null>(null);

  // Export the statement as a CSV the owner can hand to their CA (mirrors GST export).
  function exportCSV() {
    if (!data) return;
    downloadCSV(
      `pnl-${range.from}-to-${range.to}.csv`,
      ["Line", "Amount (INR)"],
      [
        ["Period", `${range.from} to ${range.to}`],
        ["Revenue", data.revenue],
        ["Cost of goods sold", -data.cogs],
        ["Gross margin", data.grossMargin],
        ["Operating expenses", -data.expenses],
        ["Commissions", -data.commissions],
        ["Net profit", data.netProfit],
        ["", ""],
        ["Output GST (on sales)", data.outputGST],
        ["Input GST (ITC)", data.inputGST],
        ["Net GST payable", data.netGST],
      ],
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">P&L Report</h1>
          <p className="text-sm text-ink-3 mt-1">
            Revenue minus cost of goods minus operating expenses = net profit.
            Accrual basis (invoice date, not payment date).
          </p>
        </div>
        <Button icon="download" onClick={exportCSV} disabled={isLoading || !data}>
          Export CSV
        </Button>
      </div>

      {/* Range picker */}
      <Card className="mb-6 p-3 md:p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1.5">
            {QUICK_RANGES.map((q) => {
              const target = q.build();
              const active = range.from === target.from && range.to === target.to;
              return (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => setRange(target)}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    active
                      ? "border-amber bg-amber-soft text-amber-ink font-semibold"
                      : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2"
                  }`}
                >
                  {q.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <label className="text-xs text-ink-3 font-semibold uppercase tracking-wide">From</label>
            <input
              type="date"
              value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
            />
            <label className="text-xs text-ink-3 font-semibold uppercase tracking-wide">To</label>
            <input
              type="date"
              value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
            />
          </div>
        </div>
      </Card>

      {/* P&L waterfall */}
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6 mb-6">
        {/* Left: waterfall */}
        <Card className="p-5 md:p-6">
          <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-4">
            For period · {range.from} to {range.to}
          </div>

          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : data ? (
            <div className="space-y-2.5">
              <Row label="Revenue"        amount={data.revenue}     hint={`${data.revenueCount} invoice${data.revenueCount === 1 ? "" : "s"}`} onHint={() => setDrill("revenue")} tone="ink" />
              <Row label={<>− <Term k="cogs">COGS</Term></>}         amount={-data.cogs}       hint={`${data.cogsCount} vendor bill${data.cogsCount === 1 ? "" : "s"}`} onHint={() => setDrill("cogs")} tone="rose" />

              <Divider />
              <Row label={<Term k="gross_margin">Gross Margin</Term>}
                   amount={data.grossMargin}
                   hint={`${data.marginPct.toFixed(1)}% margin`}
                   tone={data.grossMargin >= 0 ? "emerald" : "rose"}
                   emphasis />

              <Row label={<>− <Term k="opex">Operating expenses</Term></>}
                   amount={-data.expenses}
                   hint={`${data.expensesCount} ${data.expensesCount === 1 ? "entry" : "entries"}`}
                   onHint={() => { setDrillExpenseCat(null); setDrill("expenses"); }}
                   tone="rose" />

              {/* Category breakdown — click a group to see its entries. */}
              {data.expensesByCategory.length > 0 && (
                <div className="mt-1 mb-1 space-y-0.5">
                  {data.expensesByCategory.map((c) => (
                    <button
                      key={c.category}
                      type="button"
                      onClick={() => { setDrillExpenseCat(c.category); setDrill("expenses"); }}
                      title={`See ${c.category} entries`}
                      className="w-full flex items-center justify-between gap-3 rounded pl-6 pr-1 py-1 text-left transition-colors hover:bg-paper-2/60"
                    >
                      <span className="text-[13px] text-ink-2">
                        {c.category} <span className="text-[11px] text-ink-3">· {c.count}</span>
                      </span>
                      <span className="font-mono text-[13px] tabular-nums text-rose">-{rupee(c.total)}</span>
                    </button>
                  ))}
                </div>
              )}

              {data.commissions > 0 && (
                <Row label="− Referral commissions"
                     amount={-data.commissions}
                     hint={`${data.commissionsCount} ${data.commissionsCount === 1 ? "payout" : "payouts"}`}
                     tone="rose" />
              )}

              <Divider thick />
              <Row label="Net Profit"
                   amount={data.netProfit}
                   hint={`${data.profitPct.toFixed(1)}% net margin`}
                   tone={data.netProfit >= 0 ? "emerald" : "rose"}
                   emphasis
                   xl />
            </div>
          ) : null}
        </Card>

        {/* Right: GST snapshot */}
        <Card className="p-5 md:p-6">
          <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-4">
            GST snapshot (same period)
          </div>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : data ? (
            <div className="space-y-3 text-sm">
              <div className="flex justify-between items-baseline">
                <span className="text-ink-3"><Term k="output_gst">Output GST</Term> (on sales)</span>
                <span className="font-mono text-ink font-semibold">{rupee(data.outputGST)}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-ink-3">− <Term k="input_gst">Input GST</Term> paid</span>
                <span className="font-mono text-emerald">−{rupee(data.inputGST)}</span>
              </div>
              <div className="border-t-2 border-ink pt-3 flex justify-between items-baseline">
                <span className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold"><Term k="net_liability">Net liability</Term></span>
                <span className={`font-serif text-2xl ${data.netGST >= 0 ? "text-rose" : "text-emerald"}`}>
                  {rupee(data.netGST)}
                </span>
              </div>
              <p className="text-[11px] text-ink-3 leading-relaxed mt-3">
                Net positive = payable to govt. Negative = refund / carryforward credit.
                File via GSTR-3B by the 20th of next month.
              </p>
            </div>
          ) : null}
        </Card>
      </div>

      {/* Quick insights */}
      {data && data.revenue > 0 && (
        <Card className="p-5 bg-paper-2/30">
          <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-2">
            What this means
          </div>
          <ul className="text-sm text-ink-2 space-y-1.5 list-disc pl-5">
            {data.netProfit >= 0 ? (
              <li>Aapne is period mein <b className="text-emerald">{rupee(data.netProfit)}</b> net profit kamaya — {data.profitPct.toFixed(1)}% margin.</li>
            ) : (
              <li className="text-rose">Is period mein <b>{rupee(Math.abs(data.netProfit))} ka loss</b> hai. COGS ya expenses zyada hain.</li>
            )}
            {data.marginPct < 20 && data.revenue > 0 && (
              <li className="text-amber-ink">Gross margin is only {data.marginPct.toFixed(1)}% — a healthy reseller range is 25–35%. Check your vendor bills or review your pricing.</li>
            )}
            {data.cogs === 0 && (
              <li className="text-amber-ink">No COGS recorded for this period. Add your vendor bills (Google CSP / MS / Zoho invoices) to see the real margin.</li>
            )}
          </ul>
        </Card>
      )}

      <PnLDrilldownDialog
        open={drill !== null}
        onOpenChange={(o) => { if (!o) { setDrill(null); setDrillExpenseCat(null); } }}
        kind={drill}
        range={range}
        expenseCategory={drillExpenseCat}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// P&L row primitives
// ────────────────────────────────────────────────────────────────

function Row({
  label, amount, hint, onHint, tone, emphasis, xl,
}: {
  label: React.ReactNode;
  amount: number;
  hint?: string;
  /** When set, the hint becomes a button that opens the drill-down popup. */
  onHint?: () => void;
  tone: "ink" | "emerald" | "rose";
  emphasis?: boolean;
  xl?: boolean;
}) {
  const colorClass = tone === "emerald" ? "text-emerald"
                   : tone === "rose"    ? "text-rose"
                   : "text-ink";
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <div className={`${emphasis ? "font-semibold" : ""} ${xl ? "text-base" : "text-sm"} text-ink leading-tight`}>
          {label}
        </div>
        {hint && (
          onHint
            ? <button type="button" onClick={onHint} className="text-[11px] text-amber-ink hover:underline mt-0.5 inline-flex items-center gap-0.5">{hint} <span aria-hidden>→</span></button>
            : <div className="text-[11px] text-ink-3 mt-0.5">{hint}</div>
        )}
      </div>
      <div className={`font-mono whitespace-nowrap ${xl ? "font-serif text-3xl" : emphasis ? "text-lg font-semibold" : "text-base"} ${colorClass}`}>
        {amount < 0 ? "−" : ""}{rupee(Math.abs(amount))}
      </div>
    </div>
  );
}

function Divider({ thick = false }: { thick?: boolean }) {
  return <div className={`my-2 border-t ${thick ? "border-ink-2 border-t-2" : "border-hairline"}`} />;
}
