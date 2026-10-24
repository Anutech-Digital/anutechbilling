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

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError, LoadErrorBanner } from "@/components/shared/load-error";
import { Term } from "@/components/shared/term";
import { Button } from "@/components/ui/button";
import { rupee } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { usePnL, usePnLMonths } from "@/lib/queries/pnl";
import { PnLDrilldownDialog, type PnLDrillKind } from "@/components/features/accounting/pnl-drilldown-dialog";
import { PnlWaterfall, HundredRupeeBar } from "@/components/features/accounting/pnl-waterfall";
import { MoneyFlow } from "@/components/features/accounting/money-flow";
import { isEstimatedBasis, licenceCostHint } from "@/lib/accounting/pnl";
import {
  COMPARE_OPTIONS, compareRange, rangeLabel, periodName, runningNote,
  opexBreakdown, revenueBreakdown, licenceBreakdown, pnlCsv,
  type CompareMode, type Sense,
} from "@/lib/accounting/pnl-compare";
import { Row, SubRows, UnknownRow, GstCompare, Divider, HIDDEN_NOTE, type Cmp } from "./statement-rows";
import { pnlWaterfall, hundredRupeeSplit } from "@/lib/accounting/waterfall";
import { ProfitDonut, MonthlyTrend } from "@/components/features/accounting/pnl-charts";
import {
  profitContribution, monthlySeriesFromPnl, trendHighlights,
} from "@/lib/accounting/pnl-charts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PnlHeadline } from "@/components/features/accounting/pnl-headline";
import { netProfitView } from "@/lib/accounting/pnl-bound";
import { netFigure } from "@/lib/accounting/net-figure";
import { ProjectMarginCard } from "@/components/features/accounting/project-margin-card";
import { ProjectCostDialog } from "@/components/features/accounting/project-cost-dialog";
import { ExpenseReportCard } from "@/components/features/accounting/expense-report-card";
import { utcDateISO } from "@/lib/dates/ist";

// ────────────────────────────────────────────────────────────────
// Range helpers — all IST-safe (Indian FY runs Apr 1 → Mar 31)
// ────────────────────────────────────────────────────────────────

function istToday(): Date {
  const now = new Date();
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
}

function yyyymmdd(d: Date): string {
  return utcDateISO(d);
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

// P&L aggregation — lib/queries/pnl.ts (shared with the Balance Sheet). The FY trend is the
// same P&L month by month (usePnLMonths, R-1647).

// ────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────

export default function PnLPage() {
  const [range, setRange] = React.useState<DateRange>(thisMonth());
  const { data, isLoading, isError, refetch } = usePnL(range);
  const [drill, setDrill] = React.useState<PnLDrillKind | null>(null);
  const [drillExpenseCat, setDrillExpenseCat] = React.useState<string | null>(null);
  const [projectCostOpen, setProjectCostOpen] = React.useState(false);

  /* ── R-1832: Compare — None · Previous period · Same period last year ─────
     Off by default, so the page reads as before. The compare period is the SAME P&L
     (usePnL → report_pnl → assemblePnl, depreciation only to today — R-1808), fetched
     only once the owner asks for it. Whole months move by whole months (This month →
     last month, a quarter → the quarter before, an FY → the FY before) — lib/accounting/
     pnl-compare.ts. */
  const [compareMode, setCompareMode] = React.useState<CompareMode>("none");
  const cmpRange = React.useMemo(() => compareRange(range, compareMode), [range, compareMode]);
  const { data: cmpData, isError: cmpError } = usePnL(cmpRange ?? range, cmpRange !== null);
  /* undefined while loading; null when comparison is off. */
  const prev = cmpRange ? cmpData : null;
  const cmpName = cmpRange ? periodName(cmpRange) : "";

  /* R-1833: "Show all" per statement group (Revenue / Licence cost / Operating expenses). */
  const [showAll, setShowAll] = React.useState<Record<string, boolean>>({});
  const toggleAll = (k: string) => setShowAll((s) => ({ ...s, [k]: !s[k] }));

  const today = React.useMemo(() => yyyymmdd(istToday()), []);
  const running = runningNote(range, today);

  const [vendorTab, setVendorTab] = React.useState<string | "all">("all");

  /* Profit contribution + the FY trend. R-1647: each month of the trend is THAT month's P&L
     (same assemblePnl / reportProfit as the statement), not a cost ratio borrowed from the
     range on screen — so the chart, "best / weakest month" and the statement cannot disagree. */
  const contribution = React.useMemo(
    () => profitContribution(data?.model.byVendor ?? []),
    [data?.model.byVendor],
  );
  const fyStart = React.useMemo(() => fiscalYearStart(istToday()).getUTCFullYear(), []);
  const { data: monthPnl } = usePnLMonths(fyStart, today, !!data);
  const trend = React.useMemo(
    () => (monthPnl ? monthlySeriesFromPnl({ fyStartYear: fyStart, today, months: monthPnl }) : undefined),
    [monthPnl, fyStart, today],
  );
  const highlights = React.useMemo(() => trendHighlights(trend ?? []), [trend]);

  // Export the statement as a CSV the owner can hand to their CA (mirrors GST export).
  function exportCSV() {
    if (!data) return;
    /* Same figures as the screen (`model`): a missing cost of goods exports as "not recorded",
       not as ₹0. With a comparison on, the compare amount and the change are columns too;
       the sub-lines (R-1833) are indented rows under their line. */
    const csv = pnlCsv(data, range, cmpRange && prev ? { data: prev, range: cmpRange } : null);
    downloadCSV(
      cmpRange && prev
        ? `pnl-${range.from}-to-${range.to}-vs-${cmpRange.from}-to-${cmpRange.to}.csv`
        : `pnl-${range.from}-to-${range.to}.csv`,
      csv.headers,
      csv.rows,
    );
  }

  /* R-1833: the statement's sub-lines — each group adds up to its line (lib/accounting/pnl-compare.ts). */
  const revenueLines = data ? revenueBreakdown(data, prev, { showAll: showAll.revenue }) : null;
  const licenceLines = data ? licenceBreakdown(data, prev, { showAll: showAll.licence }) : null;
  const opexLines = data ? opexBreakdown(data, prev, { showAll: showAll.opex }) : null;
  const cmpOn = cmpRange !== null;
  /** The compare cell for a statement line: undefined while the compare period loads. */
  const cmp = (now: number | null, was: (p: NonNullable<typeof prev>) => number | null, sense: Sense, neg = false): Cmp | undefined =>
    cmpOn ? { now, was: prev ? was(prev) : undefined, sense, neg } : undefined;

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
          <div className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-2 sm:flex sm:w-auto sm:ml-auto">
            <label htmlFor="pnl-from" className="text-xs text-ink-3 font-semibold uppercase tracking-wide">From</label>
            <input id="pnl-from"
              type="date"
              value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              className="w-full sm:w-auto min-w-0 px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
            />
            <label htmlFor="pnl-to" className="text-xs text-ink-3 font-semibold uppercase tracking-wide">To</label>
            <input id="pnl-to"
              type="date"
              value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              className="w-full sm:w-auto min-w-0 px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
            />
          </div>
        </div>
        {/* R-1832: one control for the comparison. None keeps the page as it was. */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-hairline pt-3" role="group" aria-label="Compare">
          <span className="text-xs text-ink-3 font-semibold uppercase tracking-wide mr-1">Compare</span>
          {COMPARE_OPTIONS.map((o) => (
            <button
              key={o.mode}
              type="button"
              aria-pressed={compareMode === o.mode}
              onClick={() => setCompareMode(o.mode)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                compareMode === o.mode
                  ? "border-amber bg-amber-soft text-amber-ink font-semibold"
                  : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        {cmpRange && (
          <p className="mt-2 text-xs text-ink-2" data-testid="pnl-compare-heading">
            <b className="font-semibold">{rangeLabel(range)}</b> vs <b className="font-semibold">{rangeLabel(cmpRange)}</b>
            {running && <span className="text-ink-3"> · this period {running}</span>}
            {cmpError && <span className="text-rose"> · the compare period could not load</span>}
          </p>
        )}
      </Card>

      {/* R-270: a failed load says so. Before, every figure below simply vanished (or
          kept the last range) with nothing telling the owner the numbers were missing. */}
      {isError && (data
        ? <LoadErrorBanner onRetry={() => { void refetch(); }} />
        : <div className="mb-6"><LoadError what="Profit & Loss" onRetry={() => { void refetch(); }} /></div>)}

      {/* ── THE ANSWER FIRST ────────────────────────────────────────────────
          Revenue · cost of goods · expenses · net profit, before any chart. The page used
          to open on a "per ₹100" bar that refused to draw when the licence cost was
          missing, with the statement itself at the bottom. */}
      {!isLoading && data && (
        <PnlHeadline
          model={data.model}
          revenueCount={data.revenueCount}
          expensesCount={data.expensesCount}
          outputGst={data.outputGST}
          compare={cmpRange ? { model: prev?.model ?? null, name: cmpName } : null}
          onOpen={(k) => { if (k === "expenses") setDrillExpenseCat(null); setDrill(k); }}
        />
      )}

      {/* P&L waterfall */}
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6 mb-6">
        {/* Left: waterfall */}
        <Card className="p-5 md:p-6">
          <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-4">
            Profit &amp; Loss statement · {cmpRange ? <>{rangeLabel(range)} vs {rangeLabel(cmpRange)}</> : <>{range.from} to {range.to}</>}
          </div>
          {/* R-1832: column heads for the compare columns (wider screens; a phone stacks them under the amount). */}
          {cmpOn && data && (
            <div className="hidden sm:flex items-end justify-end gap-3 mb-2 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
              <span className="min-w-[8rem] text-right">This period</span>
              <span className="w-28 text-right">{cmpName}</span>
              <span className="w-36 text-right">Change</span>
            </div>
          )}

          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : data ? (
            <div className="space-y-2.5">
              {/* These rows read `model`, not the flat fields. The flat `cogs` comes from
                  `vendor_bills`, which is empty here — it is what printed "₹0 · 100.0%
                  margin" directly under a chart saying 37%. One page cannot hold two
                  answers to the same question. */}
              {/* Revenue is the invoiced amount less the GST on it — GST is collected for
                  the government, not earned — and the hint says so in numbers. */}
              <Row label="Revenue"        amount={data.model.revenue}
                   hint={`${rupee(data.model.revenue + data.outputGST)} invoiced − ${rupee(data.outputGST)} GST · ${data.revenueCount} invoice${data.revenueCount === 1 ? "" : "s"}`}
                   onHint={() => setDrill("revenue")} tone="ink"
                   cmp={cmp(data.model.revenue, (p) => p.model.revenue, "more-is-good")} />
              {revenueLines && (
                <SubRows group={revenueLines} cmpOn={cmpOn} cmpLoading={cmpOn && !prev}
                         showAll={!!showAll.revenue} onToggleAll={() => toggleAll("revenue")}
                         onOpen={() => setDrill("revenue")} />
              )}
              {/* Unknown is written as unknown. "₹0" under an unrecorded cost of goods — and a
                  "₹0" gross margin under it — read as facts; they are gaps. */}
              {/* Salary spent building customers' software is the cost of those sales —
                  moved here from operating expenses (lib/accounting/project-cost.ts). */}
              {(data.model.projectCost > 0 || (prev?.model.projectCost ?? 0) > 0) && (
                <Row label={<>− <Term k="cogs">Cost of goods</Term> (project delivery)</>}
                     cmp={cmp(data.model.projectCostHidden ? null : data.model.projectCost,
                       (p) => p.model.projectCostHidden ? null : p.model.projectCost, "more-is-bad", true)}
                     amount={-data.model.projectCost}
                     hint={[
                       data.projectCost.labour > 0 ? `${rupee(data.projectCost.labour)} salary on projects` : null,
                       data.projectCost.direct > 0 ? `${rupee(data.projectCost.direct)} project expenses` : null,
                       data.projectCost.capped ? "capped to salary booked" : null,
                     ].filter(Boolean).join(" · ")}
                     onHint={() => setProjectCostOpen(true)}
                     tone="rose" />
              )}
              {/* R-1649: salaries are owner / manager / accountant only, so for other roles the
                  project cost is unknown — said so, never printed as ₹0. */}
              {data.model.projectCostHidden && (
                <UnknownRow label={<>− <Term k="cogs">Cost of goods</Term> (project delivery)</>} value="Hidden" note={HIDDEN_NOTE}
                            cmpOn={cmpOn} />
              )}
              {data.model.cogsBasis === "unknown" ? (
                <UnknownRow label={<>− <Term k="cogs">Cost of goods</Term> (licence cost)</>} value="Not recorded" note="enter the vendor bills"
                            cmpOn={cmpOn} />
              ) : data.model.licenceCogs === 0 && data.model.projectCost > 0 && !(prev && prev.model.licenceCogs > 0) ? null : (
                <>
                  <Row label={<>− <Term k="cogs">Cost of goods</Term> (licence cost)</>}
                       amount={-data.model.licenceCogs}
                       hint={licenceCostHint(data.model, data.cogsCount)}
                       onHint={() => setDrill("cogs")}
                       tone="rose"
                       cmp={cmp(data.model.licenceCogs, (p) => p.model.cogsBasis === "unknown" ? null : p.model.licenceCogs, "more-is-bad", true)} />
                  {licenceLines && (
                    <SubRows group={licenceLines} cmpOn={cmpOn} cmpLoading={cmpOn && !prev}
                             showAll={!!showAll.licence} onToggleAll={() => toggleAll("licence")}
                             onOpen={() => setDrill("cogs")} />
                  )}
                </>
              )}

              <Divider />
              {data.model.grossMargin === null ? (
                data.model.projectCostHidden && data.model.netProfit !== null
                  ? <UnknownRow label={<Term k="gross_margin">Gross Margin</Term>} value="Hidden" note="needs the project salary — net profit below is complete" cmpOn={cmpOn} />
                  : <UnknownRow label={<Term k="gross_margin">Gross Margin</Term>} value="Unknown" note="needs the cost of goods" cmpOn={cmpOn} />
              ) : (
                <Row label={<Term k="gross_margin">Gross Margin</Term>}
                     amount={data.model.grossMargin}
                     hint={data.model.grossMarginPct === null ? "no revenue this period" : `${data.model.grossMarginPct}% margin`}
                     tone={data.model.grossMargin >= 0 ? "emerald" : "rose"}
                     emphasis
                     cmp={cmp(data.model.grossMargin, (p) => p.model.grossMargin, "more-is-good")} />
              )}

              <Row label={<>− <Term k="opex">Operating expenses</Term></>}
                   amount={-(data.expenses - data.model.projectCost)}
                   hint={`${data.expensesCount} ${data.expensesCount === 1 ? "entry" : "entries"}${data.model.projectCost > 0 ? ` · ${rupee(data.model.projectCost)} moved to project cost` : ""}`}
                   onHint={() => { setDrillExpenseCat(null); setDrill("expenses"); }}
                   tone="rose"
                   cmp={cmp(data.expenses - data.model.projectCost, (p) => p.expenses - p.model.projectCost, "more-is-bad", true)} />

              {/* R-1833: the expense heads inside the statement, adding up to the line above;
                  a category opens its entries. The Expense report card below keeps vendors and months. */}
              {opexLines && (
                <SubRows group={opexLines} cmpOn={cmpOn} cmpLoading={cmpOn && !prev}
                         showAll={!!showAll.opex} onToggleAll={() => toggleAll("opex")}
                         onOpen={(l) => { setDrillExpenseCat(l.category ?? null); setDrill("expenses"); }} />
              )}

              {(data.commissions > 0 || (prev?.commissions ?? 0) > 0) && (
                <Row label="− Referral commissions"
                     amount={-data.commissions}
                     hint={`${data.commissionsCount} ${data.commissionsCount === 1 ? "payout" : "payouts"}`}
                     tone="rose"
                     cmp={cmp(data.commissions, (p) => p.commissions, "more-is-bad", true)} />
              )}
              {(data.depreciation > 0 || (prev?.depreciation ?? 0) > 0) && (
                <Row label="− Depreciation" amount={-data.depreciation} tone="rose" hint="R-1578: Assets register, Income-tax WDV, days in this period"
                     cmp={cmp(data.depreciation, (p) => p.depreciation, "more-is-bad", true)} />
              )}
              <Divider thick />
              {/* From `model`, like every other line of this statement. The flat
                  `data.netProfit` subtracts vendor-bill COGS, which is ₹0 when no bills are
                  entered — so the statement said "margin unknown" on one line and printed a
                  confident net profit two lines later. */}
              {data.model.netProfit === null ? (
                /* Without the licence cost the exact figure is unknown — but when expenses
                   alone exceed revenue it is certainly a loss of at least the gap. */
                (() => {
                  const v = netProfitView(data.model);
                  return v.kind === "loss-at-least" ? (
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="text-base font-semibold text-ink leading-tight">Net Loss</div>
                      <div className="text-right">
                        <div className="font-serif text-2xl text-rose">at least {rupee(v.value)}</div>
                        <div className="text-xs text-amber-ink">the licence cost, once recorded, only adds to it</div>
                      </div>
                    </div>
                  ) : (
                    <UnknownRow label="Net Profit" value="Unknown" note={`cost of goods not recorded · at most ${rupee(v.value)}`} large cmpOn={cmpOn} />
                  );
                })()
              ) : (
                <Row label={data.model.netProfit < 0 ? "Net Loss" : "Net Profit"}
                     amount={data.model.netProfit}
                     hint={data.model.revenue > 0
                       ? `${((data.model.netProfit / data.model.revenue) * 100).toFixed(1)}% of revenue`
                       : "no revenue this period"}
                     tone={data.model.netProfit >= 0 ? "emerald" : "rose"}
                     emphasis
                     xl
                     cmp={cmp(data.model.netProfit, (p) => p.model.netProfit, "more-is-good")} />
              )}
            </div>
          ) : null}
        </Card>

        {/* Right: GST snapshot */}
        <Card className="p-5 md:p-6">
          <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-4">
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
              {/* R-1832: GST compares too, in neutral colour — more GST simply follows more sales. */}
              {cmpOn && <GstCompare now={data.outputGST} was={prev?.outputGST} name={cmpName} />}
              <div className="flex justify-between items-baseline">
                <span className="text-ink-3">− <Term k="input_gst">Input GST</Term> paid</span>
                <span className="font-mono text-emerald">−{rupee(data.inputGST)}</span>
              </div>
              {cmpOn && <GstCompare now={data.inputGST} was={prev?.inputGST} name={cmpName} />}
              {data.itcBlocked > 0 && (
                <div className="flex justify-between items-baseline text-xs">
                  <span className="text-ink-3">GST with no credit (no tax invoice, proforma, no GSTIN, wrong head, or s.17(5)), counted as expense / cost of goods</span>
                  <span className="font-mono text-ink-3">{rupee(data.itcBlocked)}</span>
                </div>
              )}
              <div className="border-t-2 border-ink pt-3 flex justify-between items-baseline">
                <span className="text-2xs uppercase tracking-wider text-ink-3 font-semibold"><Term k="net_liability">Net liability</Term></span>
                <span className={`font-serif text-2xl ${data.netGST >= 0 ? "text-rose" : "text-emerald"}`}>
                  {rupee(data.netGST)}
                </span>
              </div>
              {cmpOn && <GstCompare now={data.netGST} was={prev?.netGST} name={cmpName} />}
              <p className="text-xs text-ink-3 leading-relaxed mt-3">
                Net positive = payable to govt. Negative = refund / carryforward credit.
                File via GSTR-3B by the 20th of next month.
              </p>
            </div>
          ) : null}
        </Card>
      </div>

      {/* Quick insights */}
      {data && data.revenue > 0 && (
        <Card className="p-5 bg-paper-2/30 mb-6">
          <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
            What this means
          </div>
          <ul className="text-sm text-ink-2 space-y-1.5 list-disc pl-5">
            {/* Every line reads `model`. These used to run off the flat fields, so the
                page could congratulate the owner on a 100% margin in the same breath as
                telling them no COGS was recorded — two conclusions from one gap. */}
            {data.model.netProfit === null ? (
              netProfitView(data.model).kind === "loss-at-least" ? (
                <li className="text-rose">
                  This period shows <b>a loss of at least {rupee(netProfitView(data.model).value)}</b>:
                  {data.model.projectCost > 0 ? " project cost and expenses alone" : " expenses alone"} are more than revenue. The loss will grow once licence cost is recorded.
                </li>
              ) : (
                <li className="text-amber-ink">
                  Net profit can&apos;t be stated for this period — no licence cost is recorded, and
                  a licence you buy and resell is never 100% profit.
                </li>
              )
            ) : data.model.netProfit >= 0 ? (
              <li>
                You made <b className="text-emerald">{rupee(data.model.netProfit)}</b> net
                profit this period
                {data.model.revenue > 0 && ` — ${Math.round((data.model.netProfit / data.model.revenue) * 100)}% margin`}.
              </li>
            ) : (
              <li className="text-rose">
                This period shows <b>a loss of {rupee(Math.abs(data.model.netProfit))}</b>.{" "}
                {/* Name the cost this business actually has — a project-only period has no licence cost. */}
                {data.model.projectCost > 0 && data.model.licenceCogs === 0
                  ? <>Salary on projects ({rupee(data.model.projectCost)}) and running costs ({rupee(data.model.expenses)}) together are more than revenue.</>
                  : data.model.projectCost > 0
                    ? <>Licence cost, salary on projects and running costs together are more than revenue.</>
                    : <>Licence cost or running costs are too high.</>}
              </li>
            )}
            {data.model.grossMarginPct !== null && data.model.grossMarginPct < 20 && data.model.revenue > 0 && (
              <li className="text-amber-ink">Gross margin is only {data.model.grossMarginPct}% — a healthy reseller range is 25–35%. Check your vendor bills or review your pricing.</li>
            )}
            {data.projectCost.capped && (
              <li className="text-amber-ink">
                Salary allocated to projects ({rupee(data.projectCost.labourAllocated)}) is more than the salary booked this period
                ({rupee(data.projectCost.salaryPool)}), so project cost is capped at the salary booked.
                Book this period&apos;s salary entries.
              </li>
            )}
            {data.projectCost.undated > 0 && (
              <li className="text-amber-ink">
                {data.projectCost.undated} project labour allocation{data.projectCost.undated === 1 ? " has" : "s have"} no date
                (neither on the allocation nor on the project), so they are not counted in any period. Add a start date on the project page.
              </li>
            )}
            {isEstimatedBasis(data.model.cogsBasis) && (
              <li className="text-amber-ink">
                {data.model.cogsBasis === "mixed"
                  ? <>{rupee(data.model.estimatedLicenceCogs)} of the licence cost above is estimated from your own wholesale rates — the vendors with no bill in this period. Enter their invoices to make this exact.</>
                  : <>The licence cost above is estimated from your own wholesale rates — no vendor bills are recorded. Enter the Google CSP / Microsoft / Zoho invoices to make this exact.</>}
              </li>
            )}
          </ul>
        </Card>
      )}


      {/* ── EXPENSE REPORT ─────────────────────────────────────────────────────
          The operating expenses behind the statement, by vendor and month. R-1833: the
          categories now sit inside the statement, so this card no longer repeats them. */}
      {!isLoading && data && (
        <ExpenseReportCard
          report={data.expenseReport}
          periodLabel={`${range.from} to ${range.to}`}
          fileStem={`${range.from}-to-${range.to}`}
          movedToCogs={data.model.projectCost}
        />
      )}

      {/* ── PROJECT MARGIN ─────────────────────────────────────────────────────
          Software built for customers: what each project brought in this period against
          the salary and expenses spent delivering it. */}
      {/* R-1649: per-project margins need the salaries — hidden for roles that cannot read them. */}
      {!isLoading && data && !data.model.projectCostHidden && (data.projectCost.byProject.length > 0 || data.projectCost.undated > 0) && (
        <ProjectMarginCard result={data.projectCost} periodLabel={`${range.from} to ${range.to}`} />
      )}

      {/* ── THE MONEY FLOW ───────────────────────────────────────────────────
          The chart the page always claimed to have: "P&L waterfall" was a comment over a
          list of rows. Bars are clickable into the same drill-down the rows use, so it is
          a way in rather than a picture. */}
      {!isLoading && data && (() => {
        const m = data.model;
        const steps = pnlWaterfall(m);
        return (
          <Card className="p-4 md:p-5 mb-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
              <h2 className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">
                Where the money went
              </h2>
              {/* R-1832: the comparison moved to the one Compare control at the top. */}
              {isEstimatedBasis(m.cogsBasis) && (
                <Badge kind="warning" size="sm">{m.cogsBasis === "mixed" ? "Licence cost partly estimated" : "Licence cost estimated"}</Badge>
              )}
            </div>

            {/* ── THE HEADLINE, BEFORE THE CHART ───────────────────────────────
                One bar, three parts, no lakhs. A waterfall on a 7%-margin business draws
                the most important number as four pixels; this draws it as a sentence.
                Placed ABOVE the waterfall because it is what should be read first — the
                waterfall then explains how it got there. */}
            {(() => {
              const split = hundredRupeeSplit({
                revenue: m.revenue, cogs: m.cogs, expenses: m.expenses,
              });
              /* R-1649: with the project salary hidden, "cost" vs "running costs" would be split wrong. */
              return split && !m.projectCostHidden ? (
                <div className="mb-4 border-b border-hairline pb-4">
                  <HundredRupeeBar
                    split={split}
                    costLabel={m.projectCost > 0 ? (m.licenceCogs > 0 ? "Licences + project salary" : "Project salary") : "Vendor licences"}
                    costTo={m.projectCost > 0 ? (m.licenceCogs > 0 ? "licences and project salary" : "salary on projects") : "the vendor"}
                  />
                </div>
              ) : null;
            })()}

            {steps ? (
              /* ── BOTH, LIST FIRST ───────────────────────────────────────────
                 Pardeep, after using the waterfall: "isko samjhane me dimag lagana pad
                 raha hai" — and then, having seen the list: keep the waterfall too, as an
                 additional view. So both render, list first.

                 The one risk in showing two pictures of one thing is that a reader wonders
                 whether they are different data. The waterfall therefore carries a
                 sub-heading saying it is the SAME five numbers — that sentence is what
                 makes "additional" free rather than confusing. */
              <>
                <MoneyFlow
                  scale={m.revenue}
                  rows={[
                    {
                      key: "revenue", group: "in", label: "Revenue",
                      amount: m.revenue,
                      hint: `${data.revenueCount} invoice${data.revenueCount === 1 ? "" : "s"} issued`,
                      onOpen: () => setDrill("revenue"),
                    },
                    {
                      key: "cogs", group: "out",
                      label: m.projectCost > 0 ? "Cost of goods (licences + project salary)" : "Cost of goods (licence cost)",
                      amount: m.cogs,
                      hint: [
                        m.projectCost > 0 ? `${rupee(m.projectCost)} project delivery` : null,
                        m.licenceCogs > 0
                          ? licenceCostHint(m, data.cogsCount)
                          : null,
                      ].filter(Boolean).join(" · ") || "nothing bought to resell",
                      ofSalesPct: m.revenue > 0 ? Math.round((m.cogs / m.revenue) * 100) : null,
                      estimated: isEstimatedBasis(m.cogsBasis),
                      onOpen: () => setDrill("cogs"),
                    },
                    {
                      key: "opex", group: "out", label: "Running the business",
                      amount: m.expenses,
                      hint: `${data.expensesCount} ${data.expensesCount === 1 ? "entry" : "entries"} — salaries, hosting, office${m.projectCost > 0 ? " (project salary moved to cost of goods)" : ""}`,
                      ofSalesPct: m.revenue > 0 ? Math.round((m.expenses / m.revenue) * 100) : null,
                      onOpen: () => { setDrillExpenseCat(null); setDrill("expenses"); },
                    },
                    {
                      key: "gross", group: "left", label: "Gross margin",
                      amount: m.grossMargin ?? 0,
                      hint: "what reselling earns, before running costs",
                      ofSalesPct: m.grossMarginPct,
                    },
                    {
                      // R-1486: signed, so a loss reads "Net loss −₹68,100" (was Math.abs + "Net profit").
                      key: "net", group: "left", label: netFigure(m.netProfit ?? 0).label,
                      amount: m.netProfit ?? 0,
                      hint: (m.netProfit ?? 0) < 0
                        ? "a LOSS — running costs exceeded the margin"
                        : "what the business actually kept",
                      ofSalesPct: m.netProfit !== null && m.revenue > 0
                        ? Math.round((m.netProfit / m.revenue) * 100) : null,
                    },
                  ]}
                />

                <div className="mt-5 border-t border-hairline pt-4">
                  <div className="mb-3">
                    <h3 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                      Same five numbers, as steps
                    </h3>
                    <p className="text-xs leading-snug text-ink-3">
                      Each bar starts where the one before it ended, so the dotted line follows
                      the money down from sales to what you kept. Click a bar for the entries.
                    </p>
                  </div>
                  <PnlWaterfall
                    steps={steps}
                    onSelect={(key) => {
                      if (key === "revenue") setDrill("revenue");
                      else if (key === "cogs") setDrill("cogs");
                      else if (key === "opex") { setDrillExpenseCat(null); setDrill("expenses"); }
                    }}
                  />
                </div>
              </>
            ) : (
              /* The chart REFUSES to draw when the cost of goods is unknown. A waterfall's
                 shape asserts that every step is known — drawing one over a missing COGS
                 would be the same confident lie the ₹0 told, only prettier. §24: say what
                 is wrong and where to fix it. */
              m.projectCostHidden && m.netProfit !== null ? (
                <div className="rounded-md border border-amber/40 bg-amber-soft/30 px-3 py-2.5">
                  <p className="text-[12px] font-medium text-ink">
                    The step chart needs the project delivery cost — salary on customer projects — which your role cannot see.
                  </p>
                  <p className="mt-0.5 text-xs leading-snug text-ink-2">
                    Net profit above is complete. The owner, a manager or the accountant sees the gross margin and this chart.
                  </p>
                </div>
              ) :
              <div className="rounded-md border border-amber/40 bg-amber-soft/30 px-3 py-2.5">
                <p className="text-[12px] font-medium text-ink">
                  The step chart needs the cost of goods (licence cost), which isn&apos;t recorded for this period.
                </p>
                <p className="mt-0.5 text-xs leading-snug text-ink-2">
                  Enter the vendor bills (Google / Microsoft / Zoho invoices) and it draws itself.
                </p>
              </div>
            )}
            {/* The cost-basis note is said once, in the headline at the top of the page —
                it used to appear here twice more. */}

          </Card>
        );
      })()}

      {/* ── PROFIT BY VENDOR ─────────────────────────────────────────────────
          Both sides come from the SAME subscription rows, so each vendor's margin is
          internally coherent. Only vendors that actually have subscriptions get a tab —
          a Microsoft tab reading ₹0 would look like a business failing at Microsoft
          rather than one not selling it. */}
      {!isLoading && data && data.model.byVendor.length > 0 && (
        <Card className="p-4 md:p-5 mb-6">
          <h2 className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-3">
            Profit by vendor · from your subscription book
          </h2>

          {/* The donut drives the SAME `vendorTab` the buttons below do — one selection,
              two ways to make it. Two independent selections on one card is how a reader
              ends up looking at a chart for Google and a table for everything. */}
          <div className="mb-4 border-b border-hairline pb-4">
            <ProfitDonut
              slices={contribution.slices}
              losing={contribution.losing}
              totalGross={contribution.totalGross}
              selected={vendorTab}
              onSelect={setVendorTab}
            />
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-1">
            {(["all", ...data.model.byVendor.map((v) => v.vendor)] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVendorTab(v)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                  vendorTab === v
                    ? "bg-ink text-paper"
                    : "text-ink-2 hover:bg-paper-2",
                )}
              >
                {v === "all" ? "All" : data.model.byVendor.find((x) => x.vendor === v)!.label}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            {data.model.byVendor
              .filter((v) => vendorTab === "all" || v.vendor === vendorTab)
              .map((v) => (
                <div key={v.vendor} className="rounded-md border border-hairline p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink">{v.label}</span>
                    <span className="text-xs text-ink-3 tabular-nums">
                      {v.subscriptions} subscription{v.subscriptions === 1 ? "" : "s"} · {v.seats} seats
                    </span>
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Figure label="Revenue" value={v.revenue} tone="amber" />
                    <Figure label="Licence cost" value={v.cost} tone="rose" />
                    <Figure label="Gross" value={v.gross} tone={v.gross >= 0 ? "emerald" : "rose"} />
                    <div>
                      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Margin</div>
                      <div className={cn(
                        "font-serif text-lg leading-none tabular-nums",
                        v.marginPct === null ? "text-ink-3" : v.marginPct >= 25 ? "text-emerald" : "text-amber-ink",
                      )}>
                        {/* An em dash, never "0%" and never "100%" — see vendorLine. */}
                        {v.marginPct === null ? "—" : `${v.marginPct}%`}
                      </div>
                    </div>
                  </div>
                  {v.marginNote && (
                    <p className="mt-1.5 text-xs leading-snug text-amber-ink">{v.marginNote}</p>
                  )}
                </div>
              ))}
          </div>
        </Card>
      )}

      {/* ── THE FINANCIAL YEAR, MONTH BY MONTH ───────────────────────────────
          The period cards answer "how was this month". This answers "is the business
          getting better", which is the question an owner actually carries around. */}
      {trend && trend.length > 1 && (
        <Card className="p-4 md:p-5 mb-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
            <h2 className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">
              This financial year, month by month
            </h2>
            <span className="text-xs text-ink-3">
              Bars in ₹ · margin line in % on the right
            </span>
          </div>

          <MonthlyTrend points={trend} />

          {/* The two months worth pointing at, in words. A chart tells you the shape; a
              sentence tells you which month to go and look at. */}
          {highlights.best && highlights.worst && highlights.best.key !== highlights.worst.key && (
            <p className="mt-2 border-t border-hairline pt-2 text-xs leading-snug text-ink-2">
              {/* "Best month was Apr at ₹-90,000" makes a reader stop and re-read. When
                  every finished month is a loss, the honest sentence is about the size of
                  the losses, not about a winner there wasn't one of. */}
              {highlights.best.netProfit < 0 ? (
                <>
                  <span className="text-rose">Every finished month this year lost money.</span>{" "}
                  Smallest loss was <b>{highlights.best.label}</b> at {rupee(Math.abs(highlights.best.netProfit))};
                  worst was <b>{highlights.worst.label}</b> at {rupee(Math.abs(highlights.worst.netProfit))}.
                </>
              ) : (
                <>
                  Best month so far was <b>{highlights.best.label}</b> at {rupee(highlights.best.netProfit)} net;
                  weakest was <b>{highlights.worst.label}</b> at {rupee(highlights.worst.netProfit)}.
                  {highlights.lossMonths > 0 && (
                    <> <span className="text-rose">{highlights.lossMonths} month{highlights.lossMonths === 1 ? "" : "s"} lost money.</span></>
                  )}
                </>
              )}
              {" "}The current month is still running and is left out of both.
            </p>
          )}
        </Card>
      )}

      {data && (
        <ProjectCostDialog
          open={projectCostOpen}
          onClose={() => setProjectCostOpen(false)}
          result={data.projectCost}
          employeeNames={data.employeeNames}
          periodLabel={`${range.from} to ${range.to}`}
        />
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


/** One figure in the vendor card. Colour by direction, not by size. */
function Figure({ label, value, tone }: {
  label: string; value: number; tone: "amber" | "rose" | "emerald";
}) {
  const cls = tone === "rose" ? "text-rose" : tone === "emerald" ? "text-emerald" : "text-amber-ink";
  return (
    <div>
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className={cn("font-serif text-lg leading-none tabular-nums", cls)}>{rupee(value)}</div>
    </div>
  );
}
