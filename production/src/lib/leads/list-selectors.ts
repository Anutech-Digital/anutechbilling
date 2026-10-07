/**
 * Pure selectors behind the Sales & Pipeline screen — which leads are in which list,
 * and in what order.
 *
 * Lifted VERBATIM out of (app)/leads/page.tsx on 28 Sep 2026 (S35). They were `useMemo`
 * bodies inside a 5,125-line component, which meant the rules that decide what a rep
 * sees could only be checked in a browser. Behaviour is unchanged: list-selectors.test.ts
 * characterises every branch against the page's own semantics, and the page now calls
 * these instead of carrying a private copy.
 *
 * `now` is a parameter wherever the old memo read the clock, so a test can pin it. The
 * page passes `new Date()` at the same moment the memo used to read it.
 */
import type { Lead } from "@/lib/supabase/database.types";
import type { SmartView } from "@/components/features/leads/leads-smart-views";
import type { LeadListRow } from "@/lib/leads/list-page";
import { looksLikeJunk } from "@/lib/leads/junk";
import { leadMatchesSearch } from "@/lib/leads/lead-search";
import { localDateISO } from "@/lib/leads/outcomes";
import { isHotLead } from "@/lib/leads/heat";
import { staleDeals } from "@/lib/leads/velocity";
import { inSalesFolder, type SalesFolder } from "@/lib/leads/folders";
import { waitPriority, waitState } from "@/lib/leads/waiting";
import { istMonth, toIstDate } from "@/lib/dates/ist";

export type PriorityFilter = "low" | "medium" | "high";

/**
 * Won, lost and junk are out of the working list — those are finished, not work.
 *
 * ── ONE WORKING LIST: every OPEN lead, whatever stage it reached ───────────
 * This used to be `stage === "new" || stage === "contact"`, with everything further
 * along served only on /deals. The effect was that a lead VANISHED from the list the
 * moment somebody made progress on it: move it to `demo` and it left /leads entirely.
 */
export function isOpenLead(l: Pick<Lead, "stage" | "is_junk">): boolean {
  return l.stage !== "won" && l.stage !== "lost" && !l.is_junk;
}

/**
 * Whose leads — the reporting tree decides (lib/team/visibility.ts). `ids === null` means
 * "no narrowing". Unowned rows stay visible in every mode: that is the safety net.
 */
export function inWorkspace<T extends Pick<Lead, "owner_id">>(rows: readonly T[], ids: readonly string[] | null): T[] {
  if (ids === null) return [...rows];
  return rows.filter((l) => !l.owner_id || ids.includes(l.owner_id));
}

export interface JunkCounts {
  /** Confirmed junk — drives the Junk chip. */
  junk: number;
  /** Every non-junk lead — the "All leads" count. */
  everything: number;
  /** Non-junk leads the heuristic flags for review (surfaced in the Junk view). */
  suspects: number;
}

/* S40: the selectors take any row that carries the list columns (LeadListRow) — a full
   Lead does, and so does the Kanban board's slim row — and hand back the same type. */
export function junkCounts(workspaceLeads: readonly LeadListRow[]): JunkCounts {
  return {
    junk: workspaceLeads.filter((l) => l.is_junk).length,
    everything: workspaceLeads.filter((l) => !l.is_junk).length,
    suspects: workspaceLeads.filter((l) => !l.is_junk && looksLikeJunk(l).suspect).length,
  };
}

export interface SearchInput {
  search: string;
  stageFilter: readonly Lead["stage"][];
  priorityFilter: readonly PriorityFilter[];
  smartView: SmartView;
  /** The signed-in user; `mine` matches nothing while it is unknown. */
  currentUser: { userId: string } | null | undefined;
  /** Ids the duplicate index flagged — the Duplicates view filters on it. */
  dupFlagged: ReadonlySet<string>;
  now: Date;
  /**
   * "Kiska" — owner ids to keep, any-of; UNASSIGNED keeps leads with no owner. Empty or
   * absent = no constraint. (29 Sep 2026: Team view listed everyone's leads with no way to
   * pick one person's.)
   */
  ownerFilter?: readonly string[];
}

/** The ownerFilter value that means "no owner". */
export const UNASSIGNED = "__unassigned";

/**
 * Search + filter + smart view — applied BEFORE the folder cut so each view respects them.
 * This is the page's old `searched` memo.
 */
export function searchLeads<T extends LeadListRow>(workspaceLeads: readonly T[], input: SearchInput): T[] {
  const { search, stageFilter, priorityFilter, smartView, currentUser, dupFlagged, now } = input;
  let list: T[] = [...workspaceLeads];
  // 0. Junk cut — confirmed junk is hidden from EVERY working view. The "Junk"
  //    view is the cleanup workspace: confirmed junk + heuristic SUSPECTS (so
  //    you can review + mark them). Suspects still appear in working views
  //    (they're only flagged, not confirmed) until you mark them.
  list = smartView === "junk"
    ? list.filter((l) => l.is_junk || looksLikeJunk(l).suspect)
    : list.filter((l) => !l.is_junk);
  // 1. Text search across company / contact name / email / phone / plan —
  //    lib/leads/lead-search.ts (R-221: words may come from different fields; phone by digits).
  if (search.trim()) {
    list = list.filter((l) => leadMatchesSearch(l, search));
  }
  // 2. Stage filter (any-of). Empty array = no constraint.
  if (stageFilter.length > 0) {
    list = list.filter((l) => stageFilter.includes(l.stage));
  }
  // 3. Priority filter (any-of). Empty array = no constraint.
  if (priorityFilter.length > 0) {
    list = list.filter((l) => priorityFilter.includes(l.priority as PriorityFilter));
  }
  // 3b. Owner ("Kiska", any-of). Empty = no constraint.
  const owners = input.ownerFilter ?? [];
  if (owners.length > 0) {
    list = list.filter((l) => (l.owner_id ? owners.includes(l.owner_id) : owners.includes(UNASSIGNED)));
  }
  // 4. Single unified view filter. Sits on top of search + stage + priority.
  if (smartView !== "all" && smartView !== "everything") {
    /* localDateISO, not toISOString(). IST is UTC+5:30, so before 05:30 the ISO string
       is YESTERDAY's date — "arrived today" showed nothing and "overdue" quietly
       swallowed leads due today, for anyone working early. Same trap documented in
       lib/leads/outcomes.ts for the follow-up writes. */
    const todayStr = localDateISO(now);
    if (smartView === "mine") {
      list = list.filter((l) => currentUser && l.owner_id === currentUser.userId);
    } else if (smartView === "waiting") {
      /* The agent's own flag, not a guess about it. Open deals only — a handover on a lead
         somebody has since won or lost is history. */
      list = list.filter((l) => l.requires_human_attention === true && l.stage !== "won" && l.stage !== "lost");
    } else if (smartView === "today") {
      /* Arrived today (new inbound) — by the IST date it arrived. This compared created_at's
         UTC date prefix, so a lead that came in between 00:00 and 05:30 IST was not "today"
         until the next day. Fixed with S40, alongside lead_counts() which counts it the same
         way (supabase/tests/lead_counts.test.sql). */
      list = list.filter((l) => !!l.created_at && localDateISO(new Date(l.created_at)) === todayStr);
    } else if (smartView === "overdue") {
      // Follow-up overdue + still open — the rep's most actionable bucket.
      list = list.filter((l) => l.follow_up_date && l.follow_up_date < todayStr && l.stage !== "won" && l.stage !== "lost");
    } else if (smartView === "hot") {
      list = list.filter(isHotLead);
    } else if (smartView === "new") {
      list = list.filter((l) => l.stage === "new");
    } else if (smartView === "won-mtd") {
      list = list.filter((l) => wonThisMonth(l, now));
    } else if (smartView === "closing") {
      /* Same rule as closingBy() in lib/leads/forecast.ts: open, dated, on or before
         month end. Undated deals are excluded. */
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const monthEnd = localDateISO(last);
      list = list.filter((l) =>
        l.expected_close_date && l.expected_close_date <= monthEnd &&
        l.stage !== "won" && l.stage !== "lost");
    } else if (smartView === "stalled") {
      /* Past the SLA with no stage movement. staleDeals() already excludes closed
         deals and any whose age is unknown. */
      const stalledIds = new Set(staleDeals(list, now).map((l) => l.id));
      list = list.filter((l) => stalledIds.has(l.id));
    } else if (smartView === "duplicates") {
      list = list.filter((l) => dupFlagged.has(l.id));
    }
  }
  /* No follow-up cut here — that is the `followup` FOLDER's job, applied once in
     listCut() where every other folder is applied. */
  return list;
}

/**
 * What the LIST shows: the folder chips are the filter. The chip counts and the list BOTH
 * call inSalesFolder(), so a chip can never advertise a number the list contradicts.
 */
/**
 * The folder a view actually needs. The "All" folder means OPEN deals (listCut below, and the
 * same cut in list_leads()/lead_counts()), so "Won this month" under "All" was won AND open —
 * always empty. Found 2 Oct 2026 (R-118) when the dashboard's "Won this month · 4 deals" tile
 * opened /deals?view=won-mtd onto "No wins this month yet". (The View menu does not list
 * won-mtd, so before the tile nothing reached it from the UI.)
 * Won-this-month therefore cuts inside the Won folder.
 */
export function folderForView(folder: SalesFolder | "all", smartView: SmartView): SalesFolder | "all" {
  return folder === "all" && smartView === "won-mtd" ? "won" : folder;
}

export function listCut<T extends LeadListRow>(
  searched: readonly T[], folder: SalesFolder | "all", smartView: SmartView, todayISO: string,
): T[] {
  if (smartView === "junk") return [...searched];
  if (folder === "all" && smartView === "everything") return [...searched];
  if (folder === "all") return searched.filter(isOpenLead);
  return searched.filter((l) => inSalesFolder(l, folder, todayISO));
}

/**
 * What the BOARD shows. The board must contain its own last column: with no folder picked
 * its base is every non-junk, non-lost lead (open + won), so a deal dragged to Won lands
 * there. Picking a folder hands control back to the list cut, unchanged.
 */
export function boardCut<T extends LeadListRow>(
  searched: readonly T[], filtered: readonly T[], folder: SalesFolder | "all", smartView: SmartView,
): T[] {
  return folder === "all" && smartView !== "junk"
    ? searched.filter((l) => isOpenLead(l) || l.stage === "won")
    : [...filtered];
}

export interface PipelineTotals {
  /** Every non-junk lead — the deal universe. */
  dealUniverse: Lead[];
  /** Non-junk, not won, not lost. */
  openDeals: Lead[];
  /** Sum of `value` over openDeals. */
  totalValue: number;
}

/**
 * EVERY NON-JUNK LEAD IS A DEAL. Junk is the only exclusion: a stage is no longer a
 * reason to be left out of the totals. Derived from the workspace set, never from the
 * searched one, so the totals answer "how much is there".
 */
export function pipelineTotals(workspaceLeads: readonly Lead[]): PipelineTotals {
  const dealUniverse = workspaceLeads.filter((l) => !l.is_junk);
  const openDeals = dealUniverse.filter((l) => l.stage !== "won" && l.stage !== "lost");
  const totalValue = openDeals.reduce((s, l) => s + (l.value ?? 0), 0);
  return { dealUniverse, openDeals, totalValue };
}

/* Research (Pencil & Paper): har column par sort hona chahiye. "wait" DEFAULT hai. */
export type SortCol =
  | "wait" | "created" | "value" | "company" | "stage" | "age"
  | "contact" | "email" | "phone" | "plan" | "seats" | "followup" | "owner";

/** Days since an ISO instant/date. >14 means stale. */
export function daysSince(iso: string, nowMs: number = Date.now()): number {
  return Math.floor((nowMs - new Date(iso).getTime()) / 86400000);
}

export interface SortContext {
  /** Lead id → first reply instant, from queries/lead-first-reply.ts. */
  firstReplies: ReadonlyMap<string, string>;
  /** One `now` for every row, so two rows' waits cannot differ by a render's jitter. */
  now: Date;
  /** Owner id → display name, for the owner sort (names, never uuids). */
  ownerName: (ownerId: string) => string | null | undefined;
}

/**
 * The list view's sort — strictly by the chosen column. Blank values always sort LAST in
 * both directions (the `cmpText` rule). This is the old `sorted` memo from LeadListView.
 */
export function sortLeads<T extends LeadListRow>(leads: readonly T[], sortBy: SortCol, sortDir: "asc" | "desc", ctx: SortContext): T[] {
  const { firstReplies, now: nowForWait, ownerName } = ctx;
  const out = [...leads];
  const dir = sortDir === "asc" ? 1 : -1;
  /* Khaali/gायab value HAMESHA neeche, dono direction me. */
  const text = (v: string | null | undefined) => (v ?? "").trim();
  const cmpText = (x: string | null | undefined, y: string | null | undefined) => {
    const a2 = text(x), b2 = text(y);
    if (!a2 && !b2) return 0;
    if (!a2) return 1 * (sortDir === "asc" ? 1 : -1) * dir;   // khaali neeche
    if (!b2) return -1 * (sortDir === "asc" ? 1 : -1) * dir;
    return a2.localeCompare(b2) * dir;
  };

  out.sort((a, b) => {
    switch (sortBy) {
      /* Default. `waitPriority` ek hi number me do baatein rakhta hai — ruki hui leads
         har jawab-di-gayi lead se upar, aur unme lambi wait pehle.
         NISHAAN DHYAAN SE: `(pa - pb)`, `(pb - pa)` nahi. `sortDir` ka default `desc`
         hai (dir = -1), to `(pa - pb) * -1` bada number pehle laata hai. */
      case "wait": {
        const pa = waitPriority(waitState(a.created_at, firstReplies.get(a.id) ?? null, nowForWait));
        const pb = waitPriority(waitState(b.created_at, firstReplies.get(b.id) ?? null, nowForWait));
        return (pa - pb) * dir;
      }
      case "value":    return ((a.value ?? 0) - (b.value ?? 0)) * dir;
      case "seats":    return ((a.seats ?? 0) - (b.seats ?? 0)) * dir;
      case "company":  return cmpText(a.company, b.company);
      case "contact":  return cmpText(a.contact_name, b.contact_name);
      case "email":    return cmpText(a.contact_email, b.contact_email);
      case "phone":    return cmpText(a.contact_phone, b.contact_phone);
      case "plan":     return cmpText(a.plan, b.plan);
      case "followup": return cmpText(a.follow_up_date, b.follow_up_date);
      /* Naam se sort, id se nahi — id ek random uuid hai. */
      case "owner":
        return cmpText(
          a.owner_id ? ownerName(a.owner_id) : null,
          b.owner_id ? ownerName(b.owner_id) : null,
        );
      case "stage":    return a.stage.localeCompare(b.stage) * dir;
      case "age":      return (daysSince(a.updated_at) - daysSince(b.updated_at)) * dir;
      case "created":
      default:         return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * dir;
    }
  });
  return out;
}

/** Clicking a column header: same column flips direction; a new one starts asc for company, desc otherwise. */
export function nextSort(current: { sortBy: SortCol; sortDir: "asc" | "desc" }, col: SortCol): { sortBy: SortCol; sortDir: "asc" | "desc" } {
  if (current.sortBy === col) return { sortBy: col, sortDir: current.sortDir === "asc" ? "desc" : "asc" };
  return { sortBy: col, sortDir: col === "company" ? "asc" : "desc" };
}

export interface OpenTaskChip { due: string; overdue: boolean; count: number }

/**
 * Open follow-up tasks per lead — the earliest (most overdue) one and how many there are.
 * Only pending/snoozed tasks count. This is the old `openTaskByLead` memo.
 */
export function openTaskIndex(
  tasks: readonly { lead_id: string | null; status: string; due_at: string }[], nowMs: number,
): Map<string, OpenTaskChip> {
  const m = new Map<string, OpenTaskChip>();
  for (const t of tasks) {
    if (!t.lead_id || (t.status !== "pending" && t.status !== "snoozed")) continue;
    const prev = m.get(t.lead_id);
    if (!prev) m.set(t.lead_id, { due: t.due_at, overdue: new Date(t.due_at).getTime() < nowMs, count: 1 });
    else {
      prev.count += 1;
      if (new Date(t.due_at).getTime() < new Date(prev.due).getTime()) {
        prev.due = t.due_at; prev.overdue = new Date(t.due_at).getTime() < nowMs;
      }
    }
  }
  return m;
}

/**
 * "Won this month" — WON this month, by the IST calendar month of the win.
 *
 * It used to be `stage = 'won' AND created_at >= 1st of the month (browser time)`: a lead that
 * came in in August and was won on 3 September never counted as September's win, while one
 * created on 1 September and won last week did. The win date is `stage_changed_at` (the last
 * stage move — for a won lead, the move to won; won is locked, so nothing moves it after).
 * A won row with no stage_changed_at (older data) falls back to created_at.
 *
 * The SQL twins in lead_counts() and list_leads() (`v_view = 'won-mtd'`) use the same rule
 * since R-070 (migration 20260930200000: coalesce(stage_changed_at, created_at) ≥ the IST
 * month start) — supabase/tests/deal_totals_billing_dup.test.sql pins both.
 */
export function wonThisMonth(l: Pick<Lead, "stage" | "stage_changed_at" | "created_at">, now: Date): boolean {
  if (l.stage !== "won") return false;
  const at = l.stage_changed_at ?? l.created_at;
  if (!at) return false;
  return toIstDate(at).slice(0, 7) === istMonth(now);
}
