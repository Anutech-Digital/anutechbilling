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

interface Props {
  model: PnlPeriod;
  revenueCount: number;
  expensesCount: number;
  /** Output GST on the same invoices — shown so "revenue = invoiced − GST" is visible. */
  outputGst: number;
  onOpen: (kind: "revenue" | "cogs" | "expenses") => void;
}

function Tile({
  label, value, sub, tone = "ink", onClick,
}: {
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  tone?: "ink" | "emerald" | "rose" | "amber" | "muted";
  onClick?: () => void;
}) {
  const color = {
    ink: "text-ink", emerald: "text-emerald", rose: "text-rose", amber: "text-amber-ink", muted: "text-ink-3",
  }[tone];
  const body = (
    <>
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className={`font-serif text-2xl md:text-[28px] leading-tight mt-1 tabular-nums ${color}`}>{value}</div>
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

export function PnlHeadline({ model, revenueCount, expensesCount, outputGst, onOpen }: Props) {
  const pctOfRevenue = (v: number) => (model.revenue > 0 ? Math.round((v / model.revenue) * 100) : null);
  const view = netProfitView(model);

  return (
    <Card className="mb-6 p-2 md:p-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-1">
        <Tile
          label="Revenue"
          value={rupee(model.revenue)}
          sub={<>{rupee(model.revenue + outputGst)} invoiced − {rupee(outputGst)} GST · {revenueCount} invoice{revenueCount === 1 ? "" : "s"}</>}
          onClick={() => onOpen("revenue")}
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
              ].filter(Boolean).join(" · ")}
          onClick={() => onOpen("cogs")}
        />
        <Tile
          label="Expenses"
          value={`− ${rupee(model.expenses)}`}
          tone="rose"
          sub={`${expensesCount} ${expensesCount === 1 ? "entry" : "entries"} · salaries, software, office…`}
          onClick={() => onOpen("expenses")}
        />
        {view.kind === "known" ? (
          <Tile
            label={netFigure(view.value).label}
            value={netFigure(view.value).text}
            tone={view.value >= 0 ? "emerald" : "rose"}
            sub={pctOfRevenue(view.value) === null ? "no revenue this period" : `${pctOfRevenue(view.value)}% of revenue`}
          />
        ) : view.kind === "loss-at-least" ? (
          /* Expenses alone exceed revenue, so this is a loss whatever the licence cost is. */
          <Tile
            label="Net loss"
            value={<>at least {rupee(view.value)}</>}
            tone="rose"
            sub={`${model.projectCost > 0 ? "project cost and expenses" : "expenses"} alone exceed revenue · the licence cost, once recorded, only adds to it`}
          />
        ) : (
          <Tile
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
