/**
 * R-420 (Pardeep, 7 Oct 2026): sort the Sales & Pipeline leads — list AND Kanban.
 *
 * One choice, kept in the URL (?sort=, default "newest" — not written), drives three readers:
 *   1. the list: list_leads() orders and pages on the server (serverSortFor; migration
 *      20261007300000_lead_list_sort.sql), so page 2 continues the same order;
 *   2. the Kanban's per-column read (boardOrderFor): a column with more than
 *      BOARD_COLUMN_CAP cards loads the top of THIS order, not just the newest;
 *   3. the Kanban's columns themselves (sortBoardLeads): cards are sorted inside each column
 *      with leadSortKey — the TS twin of the migration's (sort_num, sort_txt, id) key.
 * The list's column headers still re-sort the loaded rows (listHeaderSortFor is the header
 * state that mirrors the chosen order, so its arrow points the right way).
 */
import type { LeadListFilters, LeadListRow } from "./list-page";
import type { SortCol } from "./list-selectors";
import { LEAD_STAGE_IDS } from "./stage-meta";

export const LEAD_SORTS = ["newest", "oldest", "value", "followup", "name", "stage", "wait"] as const;
export type LeadSort = (typeof LEAD_SORTS)[number];
export const DEFAULT_LEAD_SORT: LeadSort = "newest";
/** The URL key (?sort=value). */
export const LEAD_SORT_PARAM = "sort";

/** Short, plain labels — the dropdown fits a 375px phone. */
export const LEAD_SORT_LABELS: Record<LeadSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  value: "Value: high to low",
  followup: "Next follow-up",
  name: "Name A–Z",
  stage: "Stage",
  wait: "Waiting for reply",
};

/** The sort as list_leads() takes it. "newest" is the server's default 'created'. */
export function serverSortFor(sort: LeadSort): NonNullable<LeadListFilters["sort"]> {
  return sort === "newest" ? "created" : sort;
}

/** The list header state that shows the chosen order (arrow on the matching column). */
export function listHeaderSortFor(sort: LeadSort): { sortBy: SortCol; sortDir: "asc" | "desc" } {
  switch (sort) {
    case "oldest":   return { sortBy: "created", sortDir: "asc" };
    case "value":    return { sortBy: "value", sortDir: "desc" };
    case "followup": return { sortBy: "followup", sortDir: "asc" };
    case "name":     return { sortBy: "contact", sortDir: "asc" };
    case "stage":    return { sortBy: "stage", sortDir: "asc" };
    case "wait":     return { sortBy: "wait", sortDir: "desc" };
    case "newest":
    default:         return { sortBy: "created", sortDir: "desc" };
  }
}

/** One PostgREST order term. */
export interface BoardOrderTerm { column: keyof LeadListRow; ascending: boolean; nullsFirst?: boolean }

/**
 * The Kanban column read's order (useLeadsBoard): which BOARD_COLUMN_CAP cards a big column
 * loads. The display name is not a column, so "name" orders by contact then company — close
 * enough to pick the top 200; sortBoardLeads then orders them exactly. "stage" and "wait"
 * read the newest (one column is one stage; the board has no first-reply data).
 */
export function boardOrderFor(sort: LeadSort): BoardOrderTerm[] {
  const newest: BoardOrderTerm = { column: "created_at", ascending: false };
  switch (sort) {
    case "oldest":   return [{ column: "created_at", ascending: true }, { column: "id", ascending: true }];
    case "value":    return [{ column: "value", ascending: false, nullsFirst: false }, newest, { column: "id", ascending: false }];
    case "followup": return [{ column: "follow_up_date", ascending: true, nullsFirst: false }, newest, { column: "id", ascending: false }];
    case "name":     return [
      { column: "contact_name", ascending: true, nullsFirst: false },
      { column: "company", ascending: true, nullsFirst: false },
      newest, { column: "id", ascending: false },
    ];
    default:         return [newest, { column: "id", ascending: false }];
  }
}

const clean = (v: string | null | undefined) => (typeof v === "string" ? v.trim() : "");
const epoch = (iso: string | null | undefined) => (iso ? Date.parse(iso) / 1000 : 0);

/** The row's name as the sort reads it: contact, else company, else email, else phone (display-name.ts), lowercased. */
export function leadSortName(l: Pick<LeadListRow, "contact_name" | "company" | "contact_email" | "contact_phone">): string {
  return (clean(l.contact_name) || clean(l.company) || clean(l.contact_email) || clean(l.contact_phone)).toLowerCase();
}

/** Funnel position of a stage — LEAD_STAGE_IDS order, then lost, then anything else. */
export function stageRank(stage: string): number {
  const i = (LEAD_STAGE_IDS as readonly string[]).indexOf(stage);
  if (i >= 0) return i + 1;
  return stage === "lost" ? LEAD_STAGE_IDS.length + 1 : LEAD_STAGE_IDS.length + 2;
}

/**
 * The order list_leads() uses for `sort`, as an ascending tuple (primary, tie-break, text);
 * the id breaks a final tie. The migration folds primary and tie-break into one numeric
 * (primary × 10¹⁰ − arrival epoch) — exact in Postgres, but past 2^53 in a JS number, so
 * here the two stay apart; the order is the same. "newest" and "wait" (server keys of their
 * own) read newest first here.
 */
export function leadSortKey(
  l: Pick<LeadListRow, "created_at" | "value" | "follow_up_date" | "stage" | "contact_name" | "company" | "contact_email" | "contact_phone">,
  sort: LeadSort,
): [number, number, string] {
  const created = epoch(l.created_at);
  switch (sort) {
    case "oldest":   return [created, 0, ""];
    case "value":    return [-(l.value ?? 0), -created, ""];
    /* No date sorts LAST — Infinity stands for the migration's far-future sentinel. */
    case "followup": return [l.follow_up_date ? epoch(l.follow_up_date) : Number.POSITIVE_INFINITY, -created, ""];
    case "name": {
      const n = leadSortName(l);
      return [n === "" ? 1 : 0, 0, n];
    }
    case "stage":    return [stageRank(l.stage), -created, ""];
    default:         return [-created, 0, ""];
  }
}

const cmp = <T extends number | string>(a: T, b: T): number => (a === b ? 0 : a < b ? -1 : 1);

/** The Kanban's cards in the chosen order (the board keeps this order inside each column). */
export function sortBoardLeads<T extends LeadListRow>(rows: readonly T[], sort: LeadSort): T[] {
  const keyed = rows.map((r) => ({ r, k: leadSortKey(r, sort) }));
  keyed.sort((a, b) => cmp(a.k[0], b.k[0]) || cmp(a.k[1], b.k[1]) || a.k[2].localeCompare(b.k[2]) || cmp(a.r.id, b.r.id));
  return keyed.map((x) => x.r);
}
