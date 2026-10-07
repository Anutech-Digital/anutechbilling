/**
 * Stage labels, dots and column sets for the Sales & Pipeline screen.
 *
 * Moved out of (app)/leads/page.tsx on 28 Sep 2026 (S35) so the board, the list, the drawer
 * and the filter menu read ONE table instead of four copies. Values are unchanged; the
 * characterization tests in stage-meta.test.ts pin them.
 */
import type { Lead } from "@/lib/supabase/database.types";

export interface StageMeta {
  id: Lead["stage"];
  label: string;
  dot: string;
}

/**
 * Stage config, in FUNNEL order. Lost is an outcome, not a column.
 *
 * R-249 (6 Oct 2026): the Kanban ran quote → demo → trial while the dashboard, the insight
 * band, the add-lead form and this table ran demo → trial → quote — the same deal moved
 * "backwards" between screens. The order is quote-first (a lead becomes a deal when a
 * quote goes out; demo and trial follow), and this is the one list every screen imports.
 */
export const LEAD_STAGES: StageMeta[] = [
  { id: "new",     label: "New",          dot: "bg-slate" },
  { id: "contact", label: "Contacted",    dot: "bg-amber" },
  { id: "quote",   label: "Quote Sent",   dot: "bg-indigo" },
  { id: "demo",    label: "Demo Done",    dot: "bg-indigo" },
  { id: "trial",   label: "Trial Active", dot: "bg-rose" },
  { id: "won",     label: "Won",          dot: "bg-emerald" },
];

/** The working stage ids in funnel order (no Lost). */
export const LEAD_STAGE_IDS: Lead["stage"][] = LEAD_STAGES.map((s) => s.id);

/**
 * Kanban columns — EVERY stage the page can show, in funnel order.
 *
 * ─── THIS WAS ["quote","demo","trial","won"] AND IT BROKE THE BOARD ─────────
 * That column set was correct while the board only ever ran on /deals, where New and
 * Contacted genuinely could not appear. When /leads gained the board (same commit
 * that merged the two lists), those two stages became the bulk of the page and had
 * no column to land in — so the board rendered four empty columns while its own
 * footer read "9 total deals visible". Zero cards and a count of nine, on the same
 * screen.
 *
 * The rule that stops it recurring: the board's columns must cover every stage the
 * list can contain. A card with nowhere to go does not error, it silently disappears
 * — and a disappeared deal is indistinguishable from no deal.
 *
 * `won` is the finish line, and it HOLDS CARDS. It used to be an always-empty drop
 * target, because the board rendered `filtered` — the open-only list — so the column
 * showed "No deals in won" directly beneath a chip reading 🏆 Won 2. Same failure as
 * the four empty columns above, one column further along.
 *
 * The board now renders `boardLeads`: every non-junk, non-lost lead. A rep who drags a
 * deal to Won sees it land there, which is the only proof the gesture worked. Dragging
 * one back OUT is refused — money is recorded against a won deal, and
 * lib/leads/stage-options.ts locks the same edit in the list.
 *
 * `lost` is not a column: it needs a reason, which the outcome dialog collects.
 */
export const DEAL_STAGES: StageMeta[] = (["new", "contact", "quote", "demo", "trial", "won"] as const).map(
  (id) => LEAD_STAGES.find((s) => s.id === id)!,
);

/** All stage meta including Lost. Used to build the page-aware Filter list. */
export const STAGE_META: StageMeta[] = [
  ...LEAD_STAGES,
  { id: "lost", label: "Lost", dot: "bg-ink-3" },
];

/**
 * Filter offers only the stages that can actually appear on THIS page (else filtering
 * e.g. "Won" on the raw Leads inbox always yields 0 rows). Mirrors the inline row
 * dropdown: raw inbox = New/Contacted; deals = the deal stages.
 */
export function filterStagesFor(isDealsPage: boolean): StageMeta[] {
  return STAGE_META.filter((s) =>
    isDealsPage
      ? s.id === "quote" || s.id === "demo" || s.id === "trial" || s.id === "won" || s.id === "lost"
      : s.id === "new" || s.id === "contact",
  );
}

export const STAGE_DOT: Record<Lead["stage"], string> = {
  new:     "bg-slate",
  contact: "bg-amber",
  demo:    "bg-indigo",
  trial:   "bg-rose",
  quote:   "bg-indigo",
  won:     "bg-emerald",
  lost:    "bg-ink-3",
};

export const STAGE_LABEL: Record<Lead["stage"], string> = {
  new: "New", contact: "Contacted", demo: "Demo Done", trial: "Trial Active",
  quote: "Quote Sent", won: "Won", lost: "Lost",
};
