/**
 * Which stages each Sales page holds.
 *
 * R-057 (Pardeep, 30 Sep 2026): "Won leads sirf Deals page par (Leads page se hatao)".
 * Deals audit (30 Sep 2026): the Deals page is only REAL deals — quote, demo, trial, won,
 * lost (lib/leads/deal-rules.ts#DEALS_PAGE_STAGES). New / Contacted stay on /leads.
 *
 * /leads and /deals are one component over one table (see (app)/leads/page.tsx). Each page
 * sends its own `stages` list to BOTH list_leads() and lead_counts(), so the rows and every
 * server count that reads the searched set (folders, list.matching, hot card) agree.
 *
 * The one count lead_counts() takes before any filter — workspace.everything, the "All
 * leads" entry — is corrected per page: each page sums its own folders (/leads: inbox + talks
 * + lost; /deals: quoted + proving + won + lost), which ARE counted over the stage-scoped set.
 * That sum narrows with search / filters like the list does.
 *
 * R-070 (migration 20260930200000): the View-menu counts (lead_counts().views) are scoped to
 * the page too — scopeFiltersForPage also sends `page_stages` (every stage the page shows),
 * which lead_counts() applies to the View menu only. So on /deals "Hot", "Stalled" … count
 * deals, not New / Contacted leads. list_leads() never receives it (toListLeadsFilters).
 *
 * R-433 (Pardeep, 7 Oct 2026, re-approved 10 Oct): "sales aur deals me jo common hai wo hata
 * do — kanban view me lead me new aur contacted hi hone chahiye". /leads holds only New /
 * Contacted (plus Lost in the list — the board has no Lost column); a lead moves to /deals once
 * a quote is sent. Lost stays on both pages: a lead lost before any quote has nowhere else to be.
 */
import type { Lead } from "@/lib/supabase/database.types";
import type { LeadCounts, LeadListFilters } from "@/lib/leads/list-page";
import type { SalesFolder } from "@/lib/leads/folders";
import type { SmartView } from "@/components/features/leads/leads-smart-views";
import { STAGE_LABEL } from "@/lib/leads/stage-meta";
import { DEALS_PAGE_STAGES } from "@/lib/leads/deal-rules";

/** R-433: the only stages the Leads page shows — from a sent quote on, a lead is on /deals. */
export const LEADS_PAGE_STAGES: readonly Lead["stage"][] = ["new", "contact", "lost"];

const ALL_STAGES = Object.keys(STAGE_LABEL) as Lead["stage"][];

/** May a lead in this stage appear on this page? */
export function stageShownOnPage(stage: Lead["stage"], isDealsPage: boolean): boolean {
  return (isDealsPage ? DEALS_PAGE_STAGES : LEADS_PAGE_STAGES).includes(stage);
}

/** Every stage this page can show. */
export function pageStages(isDealsPage: boolean): Lead["stage"][] {
  return ALL_STAGES.filter((s) => stageShownOnPage(s, isDealsPage));
}

/**
 * The page's filters as sent to list_leads() and lead_counts(): `stages` becomes the picked
 * stages (or every stage the page shows when none is picked) minus the ones this page does
 * not show. A pick of only hidden stages falls back to "every shown stage" — an empty
 * `stages` means "no constraint" to the server, which would bring them back.
 */
export function scopeFiltersForPage(f: LeadListFilters, isDealsPage: boolean): LeadListFilters {
  const picked = (f.stages ?? []).filter((s) => stageShownOnPage(s, isDealsPage));
  const stages = picked.length > 0 ? picked : pageStages(isDealsPage);
  return { ...f, stages, page_stages: pageStages(isDealsPage) };
}

/** Folders whose stage cannot be on this page (Inbox = new, Talks = contact on /deals;
 *  Quote Sent, Demo / Trial and Won on /leads — R-433). Flags (Hot, Due) show on both. */
export function folderShownOnPage(id: SalesFolder, isDealsPage: boolean): boolean {
  if (isDealsPage) return id !== "inbox" && id !== "talks";
  return id !== "quoted" && id !== "proving" && id !== "won";
}

/**
 * The "All leads" / "Saari deals" count for this page. See the header for the two rules.
 */
export function everythingCountForPage(
  counts: Pick<LeadCounts, "workspace" | "kpi" | "folders">, isDealsPage: boolean,
): number {
  const f = counts.folders;
  if (isDealsPage) return f.quoted + f.proving + f.won + f.lost;
  /* R-433: /leads sums its own folders too (was workspace.everything − won, which still
     counted the Quote Sent / Demo / Trial leads that now live on /deals only). */
  return f.inbox + f.talks + f.lost;
}

/**
 * R-070: the Kanban header totals the server can vouch for — lead_counts().stage_totals, or
 * undefined when the board is not showing the set the server counted:
 *   • a folder is picked, or the Junk view is on — the board then shows the list cut
 *     (list-selectors.ts#boardCut), which stage_totals does not count;
 *   • the counts have not arrived, or the server predates the migration (no stage_totals).
 * With no folder the board leaves LOST out (boardCut: open + won), so Lost is dropped here
 * and that column keeps summing its own cards rather than showing a total it does not hold.
 */
export function boardServerTotals(
  counts: Pick<LeadCounts, "stage_totals"> | undefined,
  folder: SalesFolder | "all",
  smartView: SmartView,
): LeadCounts["stage_totals"] | undefined {
  if (!counts?.stage_totals || folder !== "all" || smartView === "junk") return undefined;
  return Object.fromEntries(
    Object.entries(counts.stage_totals).filter(([stage]) => stage !== "lost"),
  ) as LeadCounts["stage_totals"];
}

/**
 * R-470 — "Open deals" / "Pipeline" in "Show the numbers", for this page.
 *
 * lead_counts().kpi is over EVERY non-junk lead, whatever its stage. On /deals that read
 * "Open deals 1 · Pipeline ₹64.8K" for a lead in Contacted — a stage /deals does not show —
 * while Quote Sent, Demo Done and Trial Active were all empty. The tile counted a deal the
 * page could not list.
 *
 * On /deals the open numbers now come from stage_totals — the same scoped set the list and
 * the board read — over the open deal stages (quote / demo / trial). The subscription /
 * project split is not in stage_totals, so `openValueProject` is null there and the caller
 * shows the total alone. /leads keeps kpi, and so does /deals on a server that predates
 * stage_totals (it cannot do better).
 */
export interface OpenKpi { openCount: number; openValue: number; openValueProject: number | null }

const OPEN_DEAL_STAGES: readonly Lead["stage"][] = ["quote", "demo", "trial"];

export function openKpiForPage(
  counts: Pick<LeadCounts, "kpi" | "stage_totals">, isDealsPage: boolean,
): OpenKpi {
  const k = counts.kpi;
  if (!isDealsPage || !counts.stage_totals) {
    return { openCount: k.open_count, openValue: k.open_value, openValueProject: k.open_value_project };
  }
  let openCount = 0, openValue = 0;
  for (const s of OPEN_DEAL_STAGES) {
    const t = counts.stage_totals[s];
    if (!t) continue;
    openCount += t.count;
    openValue += t.value;
  }
  return { openCount, openValue, openValueProject: null };
}
