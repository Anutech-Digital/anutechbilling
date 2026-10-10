"use client";
/**
 * The Sales & Pipeline Kanban board — moved verbatim out of (app)/leads/page.tsx (S35,
 * 28 Sep 2026), with the drag state it alone uses. The page decides WHEN it renders and
 * WHICH leads it holds (`boardCut` in lib/leads/list-selectors.ts).
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { LeadCard } from "@/components/features/leads/lead-card";
import { Icon } from "@/components/ui/icon";
import { rupee, cn } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";
import type { LeadListRow, StageTotal } from "@/lib/leads/list-page";
import type { useChangeLeadStage } from "@/lib/leads/use-change-stage";
import { DEAL_STAGES, LEAD_STAGES, type StageMeta } from "@/lib/leads/stage-meta";
import { BOARD_COLUMN_CAP } from "@/lib/queries/leads";
import { checkBoardMove } from "@/lib/leads/deal-rules";
import { boardColumnSummary } from "@/lib/leads/forecast";
import { leadTitle } from "@/lib/leads/display-name";

export interface LeadsKanbanBoardProps {
  boardLeads: LeadListRow[];
  /** Each column's server total (useLeadsBoard) — the board holds the newest BOARD_COLUMN_CAP. */
  columnTotals?: Partial<Record<Lead["stage"], number>>;
  /** R-070: each column's header from the server (lead_counts().stage_totals) — count, ₹ and
      weighted ₹ over the whole stage, not the visible cards. Undefined = sum the cards (≈). */
  serverColumnTotals?: Partial<Record<Lead["stage"], StageTotal>>;
  changeStage: ReturnType<typeof useChangeLeadStage>["changeStage"];
  setSelected: (l: LeadListRow) => void;
  setAddOpen: (open: boolean) => void;
  /** The columns, in order. Default every deal stage; /leads leaves out Won (R-057). */
  stages?: readonly StageMeta[];
  /** R-835: the word for a card. /leads passes "lead" (its board holds New and Contacted
      only since R-433); /deals keeps the default "deal". */
  noun?: "lead" | "deal";
}

export function LeadsKanbanBoard({ boardLeads, columnTotals, serverColumnTotals, changeStage, setSelected, setAddOpen, stages = DEAL_STAGES, noun = "deal" }: LeadsKanbanBoardProps) {
  const router = useRouter();
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overStage, setOverStage] = React.useState<Lead["stage"] | null>(null);

  // Drag handlers
  const handleDrop = async (toStage: Lead["stage"]) => {
    if (dragId) {
      const lead = boardLeads.find((l) => l.id === dragId);
      /* A won deal cannot be dragged back out.
         The inline stage dropdown already refuses this (lib/leads/stage-options.ts) because
         un-winning means money already recorded — a payment, an invoice, a subscription.
         Leaving the board as a second, unguarded route to the same write would make the
         lock decorative: the rep would simply drag instead.
         §24 — say what happened, why, and what to do instead, never a bare "not allowed". */
      if (lead && lead.stage === "won" && toStage !== "won") {
        toast.error(`${leadTitle(lead).label} is already won`, {
          description:
            "Money is recorded against it — a payment, an invoice and a subscription. " +
            "Reopening it here would leave those behind. Raise a credit note on the invoice instead.",
          action: { label: "Open invoices", onClick: () => router.push("/invoices") },
        });
        setDragId(null);
        setOverStage(null);
        return;
      }
      /* The form's rules, on the board too (lib/leads/deal-rules.ts#checkBoardMove): no
         jumping the quote-first gate from New / Contacted, and Won needs a deal value and a
         close date. Checked BEFORE the write, so a refused card never moves — the toast says
         what is missing. Not inside changeStage: the outcome chips and the manager's stage
         override in the drawer are deliberate, confirmed routes with rules of their own. */
      const verdict = lead ? checkBoardMove(lead, toStage) : null;
      if (lead && verdict && !verdict.ok) {
        toast.error(verdict.title, {
          description: verdict.description,
          action: { label: "Lead kholo", onClick: () => setSelected(lead) },
        });
      } else if (lead && lead.stage !== toStage) {
        // Dropping onto Lost opens the reason prompt first; if it's dismissed
        // changeStage returns false and the card stays where it was.
        const moved = await changeStage(lead, toStage);
        if (moved) {
          const stageLabel = LEAD_STAGES.find((s) => s.id === toStage)?.label;
          toast.success(`${leadTitle(lead).label} → ${stageLabel}`);
        }
      }
    }
    setDragId(null);
    setOverStage(null);
  };

  return (
    <div className="flex-1 min-h-[460px] flex flex-col overflow-hidden">
      {/* Auto-fit Kanban grid stretching 100% of remaining viewport height.

          `lg:grid-cols-none` is load-bearing — without it the first two columns
          collapse to ZERO WIDTH and the board hides most of the pipeline.

          Measured on 22 Aug 2026 at a 1051px viewport, before the reset was added:
              grid-template-columns: 0px 0px 220px 220px 220px 220px
          New (9 leads) and Contacted (26) were the 0px ones — 35 of 37 deals with no
          width to render in, while the footer read "37 total deals visible". Reported
          from this screen as "canban view sahi show nahi ho raha hai".

          The mechanism: `sm:grid-cols-2` sets an EXPLICIT two-column template, and
          nothing used to switch it off further up. With `grid-flow-col`, items 1-2 land
          in those explicit columns and 3-6 create implicit ones —
          `auto-cols-[minmax(220px,1fr)]` only ever applies to the IMPLICIT columns. The
          four implicit columns took 880px of a 779px container, leaving the explicit
          pair's `1fr` to resolve to 0. Resetting the template makes all six implicit, so
          every column gets the 220px floor and the row scrolls as intended (1380px).

          4 Oct 2026: the two-column grid between sm and lg is gone too. At an 800px window
          the sidebar leaves ~470px, the 2x3 grid squeezed each row to a header and the cards
          had no height at all ("Won 8" with nothing under it — Pardeep). From sm up the board
          is now always one scrolling row of columns, each at least 240px. */}
      <div className="flex-1 min-h-0 grid grid-cols-1 sm:grid-cols-none sm:grid-flow-col sm:auto-cols-[minmax(240px,1fr)] sm:grid-rows-1 gap-3 overflow-x-auto overflow-y-hidden pb-1">
        {stages.map((stage) => {
          const stageLeads = boardLeads.filter((l) => l.stage === stage.id);
          /* count · ₹ total · probability-weighted ₹ (lib/leads/forecast.ts). From the server
             when it sent this column (R-070 — exact even when capped); otherwise the visible
             cards, and a capped column says "≈". A stage the server did not send (no lead in
             it, or Lost — page-scope.ts#boardServerTotals) sums its own cards, which is exact
             for a column that cannot be capped. */
          const sum = boardColumnSummary(
            stageLeads,
            (columnTotals?.[stage.id] ?? 0) > BOARD_COLUMN_CAP,
            serverColumnTotals?.[stage.id],
          );
          const isOver = overStage === stage.id;

          return (
            <div
              key={stage.id}
              onDragOver={(e) => {
                e.preventDefault();
                setOverStage(stage.id);
              }}
              onDragLeave={() => setOverStage(null)}
              onDrop={() => handleDrop(stage.id)}
              className={cn(
                "rounded-xl p-2.5 flex flex-col min-h-0 h-full overflow-hidden transition-colors bg-paper-2/70 border-2",
                isOver ? "border-solid border-amber" : "border-dashed border-hairline"
              )}
            >
              {/* Column header — count · ₹ total, then the weighted ₹ on its own line. */}
              <div className="px-1 pb-2 mb-2 border-b border-hairline shrink-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className={cn("w-2 h-2 rounded-full", stage.dot)} />
                    <span className="text-xs font-bold text-ink">{stage.label}</span>
                    <span className="text-3xs px-1.5 py-0.5 rounded-full bg-paper text-ink-2 font-mono tabular-nums border border-hairline">
                      {sum.count}
                    </span>
                  </div>
                  <span className="font-serif text-xs font-bold text-amber-ink tabular-nums">
                    {sum.total > 0 ? `${sum.partial ? "≈ " : ""}${rupee(sum.total, { compact: true })}` : ""}
                  </span>
                </div>
                {(sum.total > 0 || sum.partial) && (
                  <div className="mt-1 flex items-center justify-between text-3xs text-ink-3 tabular-nums">
                    <span title="By stage probability">
                      Weighted {rupee(sum.weighted, { compact: true })}
                    </span>
                    {sum.partial && <span>≈ visible cards only</span>}
                  </div>
                )}
              </div>

              {/* Cards container — per-column independent vertical scroll */}
              <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5 custom-scrollbar">
                {stageLeads.map((lead) => (
                  <LeadCard
                    key={lead.id}
                    lead={lead}
                    isDragging={dragId === lead.id}
                    onDragStart={setDragId}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverStage(null);
                    }}
                    onClick={(l) => setSelected(l)}
                  />
                ))}

                {stageLeads.length === 0 && (
                  <div className="h-20 flex items-center justify-center border border-dashed border-hairline/60 rounded-md text-xs text-ink-3">
                    No {noun}s in {stage.label}
                  </div>
                )}

                {/* WC-scale: a column holds its newest BOARD_COLUMN_CAP cards. Said out loud,
                    so a capped column is not read as the whole stage. */}
                {(columnTotals?.[stage.id] ?? 0) > BOARD_COLUMN_CAP && (
                  <p className="px-1 py-1.5 text-3xs text-ink-3 tabular-nums">
                    Newest {BOARD_COLUMN_CAP.toLocaleString("en-IN")} of {(columnTotals?.[stage.id] ?? 0).toLocaleString("en-IN")} · List view shows all
                  </p>
                )}
              </div>

              {/* Quick Add Deal in column */}
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="mt-2 shrink-0 border border-dashed border-hairline hover:border-hairline-strong rounded-md py-1.5 text-xs font-medium text-ink-3 hover:text-ink flex items-center justify-center gap-1 transition-colors cursor-pointer bg-paper/50 hover:bg-paper"
              >
                <Icon name="plus" size={12} /> Add {noun}
              </button>
            </div>
          );
        })}
      </div>

      {/* Footer status bar */}
      <div className="shrink-0 flex items-center justify-between text-xs text-ink-3 pt-1.5 px-1">
        <span className="flex items-center gap-1">
          <Icon name="info" size={12} /> Drag cards across columns to update pipeline stage instantly
        </span>
        {/* `boardLeads`, not `filtered`. This footer counted the LIST's set while the
            columns render the BOARD's, and the moment the Won column started holding
            cards the two disagreed on the same screen — 11 cards above "9 visible".
            "Visible" must mean what is visible. */}
        <span className="font-mono">{boardLeads.length} total {noun}{boardLeads.length === 1 ? "" : "s"} visible</span>
      </div>
    </div>
  );
}
