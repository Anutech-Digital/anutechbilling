/**
 * PnlHeadline — the four numbers the P&L page exists to answer, first, in one row:
 * Revenue · Cost of goods (licence cost) · Expenses · Net profit.
 *
 * Every figure reads `model` (lib/accounting/pnl.ts), the basis-aware numbers. When the
 * cost of goods is not recorded, net profit is never a confident number that quietly
 * treats the licence cost as zero: if expenses alone exceed revenue it is a LOSS OF AT
 * LEAST the gap (a fact whatever the licence cost is); otherwise it is UNKNOWN, with
 * revenue − expenses given only as a ceiling (lib/accounting/pnl-bound.ts). Revenue
 * shows "invoiced − GST" so the ex-GST figure explains itself. The one note on the cost
 * basis lives here, once, instead of being repeated in every card below.
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { rupee } from "@/lib/utils";
import { cogsBasisNote, type PnlPeriod } from "@/lib/accounting/pnl";
import { netProfitView } from "@/lib/accounting/pnl-bound";
import { netFigure } from "@/lib/accounting/net-figure";
import { periodChange, changeTone, formatChange, signedRupee, TONE_CLASS, type Sense } from "@/lib/accounting/pnl-compare";

interface Props {
  model: PnlPeriod;
  revenueCount: number;
  expensesCount: number;
  /** Output GST on the same invoices — shown so "revenue = invoiced − GST" is visible. */
  outputGst: number;
  onOpen: (kind: "revenue" | "cogs" | "expenses") => void;
  /**
   * R-1832: the compare period — its model (null while it loads) and its short name
   * ("Sep 2026"). Absent = no comparison; the tiles read exactly as before.
   */
  compare?: { model: PnlPeriod | null; name: string } | null;
}

/** "vs ₹1,20,000 in Sep 2026 · ▲ ₹15,000 (12.5%)", coloured by what the change means. */
function VsLine({ now, was, sense, name, neg }: {
  now: number | null; was: number | null | undefined; sense: Sense; name: string; neg?: boolean;
}) {
  if (was === undefined) return <>vs … {name}</>;
  if (now === null || was === null) return <>vs {name}: not comparable — a figure is unknown</>;
  const d = periodChange(now, was);
  return (
    <>
      vs {signedRupee(was, neg)} in {name} ·{" "}
      <span className={`font-semibold ${TONE_CLASS[changeTone(d.abs, sense)]}`}>{formatChange(d)}</span>
    </>
  );
}

function Tile({
  label, value, sub, tone = "ink", onClick, vs,
}: {
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  tone?: "ink" | "emerald" | "rose" | "amber" | "muted";
  onClick?: () => void;
  /** R-1832: the comparison line under the value. */
  vs?: React.ReactNode;
}) {
  const color = {
    ink: "text-ink", emerald: "text-emerald", rose: "text-rose", amber: "text-amber-ink", muted: "text-ink-3",
  }[tone];
  const body = (
    <>
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className={`font-serif text-2xl md:text-[28px] leading-tight mt-1 tabular-nums ${color}`}>{value}</div>
      {vs && <div className="text-xs text-ink-2 mt-0.5 leading-snug" data-testid="pnl-tile-vs">{vs}</div>}
      <div className="text-xs text-ink-3 mt-0.5 leading-snug">{sub}</div>
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-md p-3 hover:bg-paper-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
    >
      {body}
    </button>
  ) : (
    <div className="p-3">{body}</div>
  );
}

export function PnlHeadline({ model, revenueCount, expensesCount, outputGst, onOpen, compare }: Props) {
  const pctOfRevenue = (v: number) => (model.revenue > 0 ? Math.round((v / model.revenue) * 100) : null);
  const view = netProfitView(model);

  /* R-1832: each tile's compare line. Same `model` figures on both sides; an unknown cost of
     goods (or net profit) is "not comparable", never a change computed from a gap. */
  const p = compare?.model;
  const was = <T,>(f: (m: PnlPeriod) => T): T | undefined => (p ? f(p) : undefined);
  const vs = compare ? {
    revenue: <VsLine name={compare.name} sense="more-is-good" now={model.revenue} was={was((m) => m.revenue)} />,
    cogs: <VsLine name={compare.name} sense="more-is-bad" neg
      now={model.cogsBasis === "unknown" ? null : model.cogs}
      was={was((m) => (m.cogsBasis === "unknown" ? null : m.cogs))} />,
    expenses: <VsLine name={compare.name} sense="more-is-bad" neg now={model.expenses} was={was((m) => m.expenses)} />,
    net: <VsLine name={compare.name} sense="more-is-good"
      now={view.kind === "known" ? view.value : null}
      was={was((m) => { const v = netProfitView(m); return v.kind === "known" ? v.value : null; })} />,
  } : null;

  return (
    <Card className="mb-6 p-2 md:p-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-1">
        <Tile
          label="Revenue"
          value={rupee(model.revenue)}
          sub={<>{rupee(model.revenue + outputGst)} invoiced − {rupee(outputGst)} GST · {revenueCount} invoice{revenueCount === 1 ? "" : "s"}</>}
          onClick={() => onOpen("revenue")}
          vs={vs?.revenue}
        />
        {/* Cost of goods = licence cost + project delivery cost (salary on customer
            projects). The project part is always booked, so it shows even while the
            licence part is not recorded. */}
        <Tile
          label={model.projectCost > 0 ? "Cost of goods" : "Cost of goods (licence cost)"}
          value={model.cogsBasis === "unknown"
            ? (model.projectCost > 0 ? `− ${rupee(model.projectCost)} + ?` : "Not recorded")
            : `− ${rupee(model.cogs)}`}
          tone={model.cogsBasis === "unknown" ? "amber" : "rose"}
          sub={model.cogsBasis === "unknown"
            ? (model.projectCost > 0 ? "project salary · licence cost not recorded" : "enter vendor bills to see margin")
            : [
                model.projectCost > 0 ? `${rupee(model.projectCost)} project salary` : null,
                model.licenceCogs > 0
                  ? (model.cogsBasis === "estimated" ? "licences estimated"
                    : model.cogsBasis === "mixed" ? "licences partly estimated"
                    : "licences from vendor bills")
                  : null,
                model.grossMarginPct !== null ? `gross margin ${model.grossMarginPct}%` : null,
                /* R-1649: salaries are hidden from this role, so is the project cost and the margin. */
                model.projectCostHidden ? "project salary hidden for your role · gross margin hidden" : null,
              ].filter(Boolean).join(" · ")}
          onClick={() => onOpen("cogs")}
          vs={vs?.cogs}
        />
        <Tile
          label="Expenses"
          value={`− ${rupee(model.expenses)}`}
          tone="rose"
          sub={`${expensesCount} ${expensesCount === 1 ? "entry" : "entries"} · salaries, software, office…`}
          onClick={() => onOpen("expenses")}
          vs={vs?.expenses}
        />
        {view.kind === "known" ? (
          <Tile
            vs={vs?.net}
            label={netFigure(view.value).label}
            value={netFigure(view.value).text}
            tone={view.value >= 0 ? "emerald" : "rose"}
            sub={pctOfRevenue(view.value) === null ? "no revenue this period" : `${pctOfRevenue(view.value)}% of revenue`}
          />
        ) : view.kind === "loss-at-least" ? (
          /* Expenses alone exceed revenue, so this is a loss whatever the licence cost is. */
          <Tile
            vs={vs?.net}
            label="Net loss"
            value={<>at least {rupee(view.value)}</>}
            tone="rose"
            sub={`${model.projectCost > 0 ? "project cost and expenses" : "expenses"} alone exceed revenue · the licence cost, once recorded, only adds to it`}
          />
        ) : (
          <Tile
            vs={vs?.net}
            label="Net profit"
            value="Unknown"
            tone="muted"
            sub={<>cost of goods missing · at most {rupee(view.value)} (revenue − expenses)</>}
          />
        )}
      </div>

      {/* The cost-of-goods caveat, said once for the whole page. */}
      {model.cogsBasis !== "billed" && (
        <p className="mx-3 mb-1 mt-1 border-t border-hairline pt-2 text-xs leading-snug text-amber-ink">
          {cogsBasisNote(model)}
        </p>
      )}
    </Card>
  );
}
