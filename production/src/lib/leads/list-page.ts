/**
 * The client half of `list_leads()` and `lead_counts()` — pure, tested.
 *
 * S37 (migration 20260928200000) gave list_leads() keyset pages of slim rows. S40
 * (migration 20260929130000) taught it the rest of the page's filters — the owner ("Kiska")
 * filter, the View menu, the folder cut, the "wait" order, a merge cluster — and added
 * lead_counts(), which returns every number the Sales & Pipeline screen shows. The list
 * view pages through list_leads() and every chip reads lead_counts(), so at 20,000 leads the
 * page no longer downloads every lead to count them.
 *
 * The filter keys mirror lib/leads/list-selectors.ts#searchLeads / #listCut. Parity is
 * pinned three ways: list-page.test.ts (this file's TS oracle against the page's own
 * selectors), supabase/tests/list_rpcs.test.sql (S37's keys) and
 * supabase/tests/lead_counts.test.sql (every view × folder: count = rows paged out).
 */
import type { Lead } from "@/lib/supabase/database.types";
import type { SmartView } from "@/components/features/leads/leads-smart-views";
import type { SalesFolder } from "@/lib/leads/folders";
import { UNASSIGNED } from "@/lib/leads/list-selectors";
import { leadMatchesSearch, normalizeLeadSearch } from "@/lib/leads/lead-search";
import { canonicalSource } from "@/lib/leads/lead-sources";

/**
 * The columns list_leads() returns — must equal the LATEST migration's select list (checked
 * by lead-counts-sql-copy.test.ts). Everything the row, card and counts read; none of the free
 * text that made select("*") heavy.
 */
export const LEAD_LIST_COLUMNS = [
  "id", "company", "contact_name", "contact_email", "contact_phone",
  "plan", "seats", "value", "stage", "priority", "owner_id", "source",
  "is_junk", "created_at", "updated_at", "follow_up_date", "expected_close_date",
  "stage_changed_at", "enquiry_type", "project_id", "customer_id",
  "requires_human_attention", "pipeline", "subscription_type", "lost_reason",
  /* S40: the heat score (lib/leads/heat-score.ts) reads the company domain, and the
     board card shows why the AI handed a lead over. */
  "domain", "human_attention_reason",
] as const satisfies readonly (keyof Lead)[];

/**
 * One list row. `is_duplicate` is computed by list_leads() for the rows of a page (another
 * workspace lead shares the phone or company key — lib/leads/duplicates.ts); rows read any
 * other way (the board's slim query) do not carry it.
 */
export type LeadListRow = Pick<Lead, (typeof LEAD_LIST_COLUMNS)[number]> & { is_duplicate?: boolean };

/**
 * The keyset cursor, exactly as the server returned it — never rebuilt client-side. Its
 * shape follows the order in use: created_at for 'created', wait_key for 'wait'.
 */
export type LeadListCursor =
  | { created_at: string; id: string }
  | { wait_key: string; id: string }
  /* R-420 (migration 20261007300000): oldest / value / followup / name / stage. */
  | { sort_num: string; sort_txt: string; id: string };

export interface LeadListPage {
  rows: LeadListRow[];
  next_cursor: LeadListCursor | null;
}

/** The server-expressible filters (see the migration's header for each key's rule). */
export interface LeadListFilters {
  search?: string;
  stages?: Lead["stage"][];
  priorities?: Array<"low" | "medium" | "high">;
  junk?: "exclude" | "only" | "any";
  /** Team view: these owners OR unowned. */
  owner_ids?: string[];
  /** Exactly this owner ("Mine"). */
  owner_id?: string;
  /** Not won, not lost, not junk. */
  open_only?: boolean;
  /** "Kiska": owner ids any-of; UNASSIGNED keeps leads with no owner. */
  owners?: string[];
  /** R-392 Source filter: canonical source keys (lead-sources.ts#canonicalSource), any-of. */
  sources?: string[];
  /** The View menu. When set, it also decides the junk cut (and `junk` is ignored). */
  smart_view?: SmartView;
  /** The folder cut — applied only together with smart_view. */
  folder?: SalesFolder | "all";
  /** 'created' (newest first), 'wait' (lib/leads/waiting.ts#waitPriority), or an R-420 order
      (lib/leads/lead-sort.ts: oldest, value, followup, name, stage). */
  sort?: "created" | "wait" | "oldest" | "value" | "followup" | "name" | "stage";
  /** Only the OTHER leads that duplicate this one (the merge dialog's cluster). */
  dup_of?: string;
  /** Leads that a lead being TYPED would duplicate (the Add-lead form's warning). */
  dup_like?: { company?: string; contact_phone?: string; exclude_id?: string };
  /**
   * lead_counts() only (R-070, migration 20260930200000): the stages the PAGE shows
   * (page-scope.ts#pageStages) — the View menu counts only these. Not the user's stage pick,
   * which the View menu never reads. list_leads() does not take it (its `stages` already
   * carry the page scope), so toListLeadsFilters drops it.
   */
  page_stages?: Lead["stage"][];
}

/**
 * Build `p_filters` from page state, dropping every key that would mean "no constraint", so
 * two equivalent states give the same JSON — and therefore the same query key.
 *
 * `search` is sent NORMALIZED (lead-search.ts: lowercased, trimmed, one space between words —
 * R-221) and omitted when it is blank, so " Acme " and "acme" are one query key.
 */
export function toListLeadsFilters(input: LeadListFilters): LeadListFilters {
  const out: LeadListFilters = {};
  const search = input.search === undefined ? "" : normalizeLeadSearch(input.search);
  if (search !== "") out.search = search;
  if (input.stages && input.stages.length > 0) out.stages = [...input.stages].sort();
  if (input.priorities && input.priorities.length > 0) out.priorities = [...input.priorities].sort();
  if (input.junk && input.junk !== "exclude") out.junk = input.junk;
  if (input.owner_ids) out.owner_ids = [...input.owner_ids].sort();
  if (input.owner_id) out.owner_id = input.owner_id;
  if (input.open_only) out.open_only = true;
  if (input.owners && input.owners.length > 0) out.owners = [...input.owners].sort();
  if (input.sources && input.sources.length > 0) out.sources = [...input.sources].sort();
  if (input.smart_view) out.smart_view = input.smart_view;
  if (input.folder && input.folder !== "all") out.folder = input.folder;
  if (input.sort && input.sort !== "created") out.sort = input.sort;
  if (input.dup_of) out.dup_of = input.dup_of;
  if (input.dup_like) out.dup_like = input.dup_like;
  return out;
}

/**
 * The server rule, in TypeScript, for a row that is already in memory — the parity oracle
 * the tests hold both sides to. Mirrors the migration's WHERE clause key by key.
 */
export function matchesListLeadsFilters(l: LeadListRow, f: LeadListFilters, ownerName?: string | null): boolean {
  const junk = f.junk ?? "exclude";
  if (junk === "exclude" && l.is_junk) return false;
  if (junk === "only" && !l.is_junk) return false;
  /* public.lead_search_hit() — migrations 20261007000000 (R-221) and 20261007190000 (R-392:
     the source and the assigned person, whose name the caller passes as ownerName). */
  if (f.search !== undefined && !leadMatchesSearch(l, f.search, ownerName)) return false;
  /* public.lead_source_key(l.source) = any (v_sources) — R-392. */
  if (f.sources && f.sources.length > 0 && !f.sources.includes(canonicalSource(l.source))) return false;
  if (f.stages && f.stages.length > 0 && !f.stages.includes(l.stage)) return false;
  if (f.priorities && f.priorities.length > 0 && !f.priorities.includes(l.priority as "low" | "medium" | "high")) return false;
  if (f.owner_ids && l.owner_id && !f.owner_ids.includes(l.owner_id)) return false;
  if (f.owner_id && l.owner_id !== f.owner_id) return false;
  if (f.open_only && (l.stage === "won" || l.stage === "lost" || l.is_junk)) return false;
  if (f.owners && f.owners.length > 0
      && !(l.owner_id ? f.owners.includes(l.owner_id) : f.owners.includes(UNASSIGNED))) return false;
  return true;
}

// ── lead_counts() ───────────────────────────────────────────────────────────

/** Folder / flag ids, as lead_counts().folders keys them — the same ids as folders.ts. */
export type LeadFolderCounts = Record<SalesFolder, number>;

/**
 * What lead_counts(p_filters) returns (migration 20260929130000). Each section is counted
 * over the base the page used for it — see the function's header for which is which.
 */
export interface LeadCounts {
  /** The IST date every date rule used. */
  today: string;
  /** Every lead the caller can see, no filter: team-toggle note, Kiska counts, KPI tiles. */
  pool: { total: number; unassigned: number; high_priority: number; by_owner: Record<string, number>;
    /** R-392: leads per canonical source key (public.lead_source_key) — the Source filter's
        options. Optional: absent until migration 20261007190000 is applied. */
    by_source?: Record<string, number>;
    /** R-489: the pool cut to the stages THIS page shows, junk left out — what the team note
        counts. Optional: absent until migration 20261009190500 is applied. */
    page_total?: number; page_unassigned?: number };
  /** The team cut only: "All leads", the Junk entry. */
  workspace: { junk: number; everything: number; suspects: number };
  /** Open leads in the workspace: the View menu. */
  views: {
    all: number; mine: number; waiting: number; today: number; overdue: number; hot: number;
    new: number; stalled: number; closing: number; duplicates: number;
  };
  /** Every filter + the view: the folder rows. */
  folders: LeadFolderCounts;
  /** The list itself (filters + view + folder). */
  list: {
    matching: number;
    /** Quote / trial rows in the list — the hot-lead card. */
    hot: number;
    /** The highest-value one of those. */
    hot_top: Pick<Lead, "id" | "company" | "contact_name" | "contact_email" | "contact_phone" | "plan" | "value" | "stage"> | null;
  };
  /** Non-junk workspace: "Show the numbers". */
  kpi: { open_count: number; open_value: number; open_value_project: number; won: number; lost: number };
  /**
   * R-070 (migration 20260930200000): the searched set per stage — cards, ₹ value (value > 0
   * summed) and weighted ₹ (forecast.ts#weightedValue per deal, summed). A stage with no
   * lead is absent. Optional: a server without the migration does not send it, and the
   * board then falls back to summing its visible cards (and says "≈").
   */
  stage_totals?: Partial<Record<Lead["stage"], StageTotal>>;
}

/** One stage of lead_counts().stage_totals. */
export interface StageTotal { count: number; value: number; weighted: number }

/** lead_counts() takes the list's filters minus the paging-only keys, plus page_stages. */
export function toLeadCountsFilters(input: LeadListFilters): LeadListFilters {
  const f = toListLeadsFilters(input);
  delete f.sort;
  delete f.dup_of;
  delete f.dup_like;
  if (input.page_stages && input.page_stages.length > 0) f.page_stages = [...input.page_stages].sort();
  return f;
}

/**
 * R-489 (R-457 leftover): the counts behind the team-toggle note ("Plus 2 unassigned…").
 * pool.unassigned counted every lead in the tenant — a WON lead /leads never shows was in it.
 * The page-scoped numbers win; before migration 20261009190500 is applied they are absent
 * and the old numbers are used, so nothing breaks in between.
 */
export function teamNoteCounts(pool: LeadCounts["pool"]): { total: number; unassigned: number } {
  if (typeof pool.page_total === "number" && typeof pool.page_unassigned === "number") {
    return { total: pool.page_total, unassigned: pool.page_unassigned };
  }
  return { total: pool.total, unassigned: pool.unassigned };
}
