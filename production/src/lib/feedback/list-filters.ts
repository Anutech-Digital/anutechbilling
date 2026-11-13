/**
 * R-2726 — search, filters, sorting and paging for /admin/feedback, as pure data.
 *
 * 13 Nov 2026 (Pardeep): the page was one endless list of 290 long report bodies and a real
 * user's report was missed in it. This file is the ONE place that says what can be filtered:
 *   - `parseFeedbackFilters` reads the URL (only known values survive; anything else falls
 *     back to the default),
 *   - `feedbackFilterOps` turns the filters into PostgREST filter steps,
 *   - `applyFeedbackOps` / `applyFeedbackSort` put those steps on a query.
 *
 * ─── ACCESS RULE (unchanged by this card) ───────────────────────────────────
 * Nothing here widens what a caller may read. The two callers are:
 *   - "This workspace": the browser client, under the RLS policy `feedback_select`
 *     (tenant_id = current_tenant_id()). A filter can only narrow what RLS already allows.
 *     In this scope the `workspace` filter is DROPPED — no tenant_id step is ever built —
 *     so a hand-typed ?ws=<another tenant> does nothing at all.
 *   - "All workspaces": GET /api/admin/feedback/platform, which answers 401/403 from the
 *     session email BEFORE it parses a single parameter. Scope is never a request parameter.
 * Every value that reaches a filter is either one of a fixed list, a validated date / uuid,
 * or free text that is escaped (`\`, `%`, `_`; `*` — PostgREST's alias for `%` — becomes `_`)
 * and double-quoted inside or(), so it can never add a condition of its own.
 */
import { addDaysISO, istDayStartUtc } from "@/lib/dates/ist";

export const FEEDBACK_PAGE_SIZE = 50;
/** Longest search text kept, and the most words searched (each word must match). */
export const SEARCH_MAX_CHARS = 100;
export const SEARCH_MAX_WORDS = 5;

export const STATUS_FILTERS = ["all", "open", "queued", "ai_working", "fixed", "wont_fix", "duplicate"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: "All",
  open: "Open",
  queued: "Queued for AI",
  ai_working: "AI worker has it",
  fixed: "Fixed",
  wont_fix: "Won't fix",
  duplicate: "Duplicate",
};

export const TYPE_FILTERS = ["all", "bug", "feature", "ui_improvement"] as const;
export type TypeFilter = (typeof TYPE_FILTERS)[number];
export const TYPE_FILTER_LABEL: Record<TypeFilter, string> = {
  all: "Any type", bug: "Bug", feature: "Feature", ui_improvement: "UI polish",
};

export const SEVERITY_FILTERS = ["all", "critical", "high", "medium", "low"] as const;
export type SeverityFilter = (typeof SEVERITY_FILTERS)[number];
export const SEVERITY_FILTER_LABEL: Record<SeverityFilter, string> = {
  all: "Any severity", critical: "Critical", high: "High", medium: "Medium", low: "Low",
};

export const CARD_FILTERS = ["all", "has", "none"] as const;
export type CardFilter = (typeof CARD_FILTERS)[number];
export const CARD_FILTER_LABEL: Record<CardFilter, string> = {
  all: "Card or no card", has: "Has a card", none: "No card yet",
};

export const SORT_KEYS = ["newest", "oldest", "severity", "status"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const SORT_LABEL: Record<SortKey, string> = {
  newest: "Newest first", oldest: "Oldest first", severity: "Highest severity score", status: "By status",
};

export const SCOPES = ["mine", "all"] as const;
export type FeedbackScope = (typeof SCOPES)[number];

export interface FeedbackFilters {
  q: string;
  status: StatusFilter;
  type: TypeFilter;
  severity: SeverityFilter;
  /** A reporter's email (lower case), or their name when the report has no email. "" = anyone. */
  reporter: string;
  /** A tenant id. Used in the "All workspaces" scope only. "" = every workspace. */
  workspace: string;
  /** The screen the report was filed on (route pattern, else the path). "" = any. */
  page: string;
  /** IST calendar days, YYYY-MM-DD, both included. "" = open end. */
  from: string;
  to: string;
  card: CardFilter;
  /** "Real users": leave out reports from internal / test addresses. */
  real: boolean;
  /** "New since my last visit" — the time itself is per browser and travels as `since`. */
  fresh: boolean;
  sort: SortKey;
  /** 1-based. */
  pageNo: number;
}

export const DEFAULT_FEEDBACK_FILTERS: FeedbackFilters = {
  q: "", status: "all", type: "all", severity: "all", reporter: "", workspace: "", page: "",
  from: "", to: "", card: "all", real: false, fresh: false, sort: "newest", pageNo: 1,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/* Control characters never belong in a filter value; they are dropped, not escaped. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

function pick<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}
function text(raw: string | null, max: number): string {
  return (raw ?? "").replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function day(raw: string | null): string {
  if (!raw || !DAY_RE.test(raw)) return "";
  return Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) ? "" : raw;
}

/** The URL → filters. Unknown or malformed values become the default, never an error. */
export function parseFeedbackFilters(params: URLSearchParams): FeedbackFilters {
  const pageNo = Number.parseInt(params.get("p") ?? "1", 10);
  const ws = params.get("ws") ?? "";
  return {
    q: text(params.get("q"), SEARCH_MAX_CHARS),
    status: pick(params.get("status"), STATUS_FILTERS, "all"),
    type: pick(params.get("type"), TYPE_FILTERS, "all"),
    severity: pick(params.get("sev"), SEVERITY_FILTERS, "all"),
    reporter: text(params.get("reporter"), 200).toLowerCase(),
    workspace: UUID_RE.test(ws) ? ws.toLowerCase() : "",
    page: text(params.get("page"), 300),
    from: day(params.get("from")),
    to: day(params.get("to")),
    card: pick(params.get("card"), CARD_FILTERS, "all"),
    real: params.get("real") === "1",
    fresh: params.get("new") === "1",
    sort: pick(params.get("sort"), SORT_KEYS, "newest"),
    pageNo: Number.isFinite(pageNo) && pageNo >= 1 && pageNo <= 10_000 ? pageNo : 1,
  };
}

/** Filters → URL params; a default value is left out, so an unfiltered list has a clean address. */
export function feedbackFiltersToParams(f: FeedbackFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.status !== "all") p.set("status", f.status);
  if (f.type !== "all") p.set("type", f.type);
  if (f.severity !== "all") p.set("sev", f.severity);
  if (f.reporter) p.set("reporter", f.reporter);
  if (f.workspace) p.set("ws", f.workspace);
  if (f.page) p.set("page", f.page);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.card !== "all") p.set("card", f.card);
  if (f.real) p.set("real", "1");
  if (f.fresh) p.set("new", "1");
  if (f.sort !== "newest") p.set("sort", f.sort);
  if (f.pageNo > 1) p.set("p", String(f.pageNo));
  return p;
}

/** An ISO instant from the browser ("new since"), or null when it is not one. */
export function parseSince(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 40) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ─── escaping ────────────────────────────────────────────────────────────────

/**
 * Free text for an ILIKE pattern that matches only itself: `\`, `%` and `_` are escaped.
 * PostgREST (and the data gateway) also turn `*` into `%` and offer no escape for it, so a
 * typed `*` becomes `_` — one character, which still matches the `*` it stood for.
 */
export function escapeLikeText(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, "_");
}

/** A value inside or()/and(): double-quoted, with `"` and `\` escaped — commas, dots and brackets stay text. */
export function quoteLogicValue(v: string): string {
  return `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

const contains = (s: string) => quoteLogicValue(`%${escapeLikeText(s)}%`);
const exactly = (s: string) => quoteLogicValue(s);

// ─── "Real users" ────────────────────────────────────────────────────────────

/**
 * Addresses that are the team's own or test data. A report from any other address — or with
 * no address at all — counts as a real user's: missing a real report is worse than one extra row.
 */
export const INTERNAL_REPORTER_DOMAINS = ["anutech.in", "example.com", "example.org", "example.net"] as const;
/** Reserved test TLDs (RFC 2606) — the local test company files from `…@example.test`. */
export const TEST_REPORTER_TLDS = ["test", "example", "invalid", "localhost"] as const;

export function isRealReporter(email: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return true;
  if (INTERNAL_REPORTER_DOMAINS.some((d) => e.endsWith(`@${d}`))) return false;
  if (TEST_REPORTER_TLDS.some((t) => e.endsWith(`.${t}`))) return false;
  return true;
}

function realUsersExpr(): string {
  const not = [
    ...INTERNAL_REPORTER_DOMAINS.map((d) => `%@${escapeLikeText(d)}`),
    ...TEST_REPORTER_TLDS.map((t) => `%.${escapeLikeText(t)}`),
  ].map((pattern) => `reporter_email.not.ilike.${quoteLogicValue(pattern)}`);
  return `reporter_email.is.null,and(${not.join(",")})`;
}

// ─── filters → query steps ───────────────────────────────────────────────────

export type FeedbackOp =
  | { k: "eq" | "gte" | "gt" | "lt"; col: string; v: string }
  | { k: "is_null" | "not_null"; col: string }
  /** One `or=(…)` — several of them are ANDed together by PostgREST. */
  | { k: "or"; expr: string };

/** Columns the search box reads. `agent_card` + `resolution_note` carry the board card id. */
export const SEARCH_COLUMNS = [
  "title", "body", "problem_summary", "reporter_name", "reporter_email",
  "page_path", "route_pattern", "agent_card", "resolution_note",
] as const;

/** A board card id as the AI's note writes it ("… R-354 (279cb0d2) …"). */
const CARD_IN_NOTE = "R-[0-9]{2,5}";

export interface FeedbackOpsOptions {
  scope: FeedbackScope;
  /** From `parseSince`; only read when `fresh` is on. */
  since?: string | null;
  /** Leave the status filter out — for the per-status counts on the tabs. */
  skipStatus?: boolean;
}

export function statusOps(status: StatusFilter): FeedbackOp[] {
  switch (status) {
    case "all": return [];
    case "queued": return [{ k: "eq", col: "status", v: "agent_queued" }, { k: "is_null", col: "agent_claimed_at" }];
    case "ai_working": return [{ k: "eq", col: "status", v: "agent_queued" }, { k: "not_null", col: "agent_claimed_at" }];
    default: return [{ k: "eq", col: "status", v: status }];
  }
}

/** Which tab a row belongs to — the same split `statusOps` makes, for the counts and the pill. */
export function statusFilterOf(row: { status: string; agent_claimed_at?: string | null }): Exclude<StatusFilter, "all"> {
  if (row.status === "agent_queued") return row.agent_claimed_at ? "ai_working" : "queued";
  if (row.status === "fixed" || row.status === "wont_fix" || row.status === "duplicate") return row.status;
  return "open";
}

export function feedbackFilterOps(f: FeedbackFilters, opts: FeedbackOpsOptions): FeedbackOp[] {
  const ops: FeedbackOp[] = [];

  /* The ONLY tenant step, and only for the platform route. See the header. */
  if (opts.scope === "all" && f.workspace && UUID_RE.test(f.workspace)) {
    ops.push({ k: "eq", col: "tenant_id", v: f.workspace });
  }

  if (!opts.skipStatus) ops.push(...statusOps(f.status));

  if (f.type !== "all") {
    ops.push({ k: "or", expr: `inferred_type.eq.${f.type},and(inferred_type.is.null,reported_type.eq.${f.type})` });
  }
  if (f.severity !== "all") ops.push({ k: "eq", col: "reported_severity", v: f.severity });

  if (f.reporter) {
    ops.push({
      k: "or",
      expr: `reporter_email.ilike.${exactly(escapeLikeText(f.reporter))},and(reporter_email.is.null,reporter_name.ilike.${exactly(escapeLikeText(f.reporter))})`,
    });
  }
  if (f.page) {
    ops.push({ k: "or", expr: `route_pattern.eq.${exactly(f.page)},and(route_pattern.is.null,page_path.eq.${exactly(f.page)})` });
  }

  if (f.from) ops.push({ k: "gte", col: "created_at", v: istDayStartUtc(f.from).toISOString() });
  if (f.to) ops.push({ k: "lt", col: "created_at", v: istDayStartUtc(addDaysISO(f.to, 1)).toISOString() });
  if (f.fresh && opts.since) ops.push({ k: "gt", col: "created_at", v: opts.since });

  if (f.card === "has") {
    ops.push({ k: "or", expr: `agent_card.not.is.null,resolution_note.match.${exactly(CARD_IN_NOTE)}` });
  } else if (f.card === "none") {
    ops.push({ k: "is_null", col: "agent_card" });
    ops.push({ k: "or", expr: `resolution_note.is.null,resolution_note.not.match.${exactly(CARD_IN_NOTE)}` });
  }

  if (f.real) ops.push({ k: "or", expr: realUsersExpr() });

  /* Every word must be found somewhere: one or=(…) per word, ANDed. */
  const words = f.q.split(" ").filter(Boolean).slice(0, SEARCH_MAX_WORDS);
  for (const w of words) {
    ops.push({ k: "or", expr: SEARCH_COLUMNS.map((c) => `${c}.ilike.${contains(w)}`).join(",") });
  }
  return ops;
}

// ─── applying to a PostgREST query ───────────────────────────────────────────

/** The part of a postgrest-js filter builder this file drives. */
export interface FeedbackQueryLike<Q> {
  eq(col: string, v: string): Q;
  gte(col: string, v: string): Q;
  gt(col: string, v: string): Q;
  lt(col: string, v: string): Q;
  is(col: string, v: null): Q;
  not(col: string, op: string, v: null): Q;
  or(expr: string): Q;
  order(col: string, o: { ascending: boolean; nullsFirst?: boolean }): Q;
}

export function applyFeedbackOps<Q extends FeedbackQueryLike<Q>>(query: Q, ops: readonly FeedbackOp[]): Q {
  let q = query;
  for (const op of ops) {
    switch (op.k) {
      case "eq": q = q.eq(op.col, op.v); break;
      case "gte": q = q.gte(op.col, op.v); break;
      case "gt": q = q.gt(op.col, op.v); break;
      case "lt": q = q.lt(op.col, op.v); break;
      case "is_null": q = q.is(op.col, null); break;
      case "not_null": q = q.not(op.col, "is", null); break;
      case "or": q = q.or(op.expr); break;
    }
  }
  return q;
}

/** Always ends on `id`, so two reports filed in the same instant keep one order across pages. */
export function applyFeedbackSort<Q extends FeedbackQueryLike<Q>>(query: Q, sort: SortKey): Q {
  let q = query;
  if (sort === "severity") q = q.order("severity_score", { ascending: false, nullsFirst: false });
  if (sort === "status") q = q.order("status", { ascending: true });
  q = q.order("created_at", { ascending: sort === "oldest" });
  return q.order("id", { ascending: true });
}

/** 0-based inclusive row range of a page, for `.range(from, to)`. */
export function pageRange(pageNo: number, size = FEEDBACK_PAGE_SIZE): { from: number; to: number } {
  const p = Math.max(1, Math.floor(pageNo) || 1);
  return { from: (p - 1) * size, to: p * size - 1 };
}

// ─── counts and facets ───────────────────────────────────────────────────────

export type StatusCounts = Record<StatusFilter, number>;

export function tallyStatuses(rows: readonly { status: string; agent_claimed_at?: string | null }[]): StatusCounts {
  const out: StatusCounts = { all: 0, open: 0, queued: 0, ai_working: 0, fixed: 0, wont_fix: 0, duplicate: 0 };
  for (const r of rows) { out[statusFilterOf(r)] += 1; out.all += 1; }
  return out;
}

export interface FacetSourceRow {
  tenant_id: string;
  reporter_name: string | null;
  reporter_email: string | null;
  route_pattern: string | null;
  page_path: string | null;
}
export interface FacetOption { value: string; label: string; count: number }
export interface FeedbackFacets {
  reporters: FacetOption[];
  pages: FacetOption[];
  /** Filled by the platform route only. */
  workspaces: FacetOption[];
}

/** The choices for the Reporter / Page / Workspace pickers, most reports first. */
export function buildFacets(rows: readonly FacetSourceRow[], tenantNames?: ReadonlyMap<string, string>): FeedbackFacets {
  const reporters = new Map<string, FacetOption>();
  const pages = new Map<string, FacetOption>();
  const workspaces = new Map<string, FacetOption>();
  const bump = (m: Map<string, FacetOption>, value: string, label: string) => {
    const cur = m.get(value);
    if (cur) cur.count += 1; else m.set(value, { value, label, count: 1 });
  };
  for (const r of rows) {
    const email = (r.reporter_email ?? "").trim().toLowerCase();
    const name = (r.reporter_name ?? "").trim();
    if (email) bump(reporters, email, name ? `${name} · ${email}` : email);
    else if (name) bump(reporters, name.toLowerCase(), name);
    const pg = r.route_pattern ?? r.page_path;
    if (pg) bump(pages, pg, pg);
    if (tenantNames) bump(workspaces, r.tenant_id, tenantNames.get(r.tenant_id) ?? "(unknown workspace)");
  }
  const sorted = (m: Map<string, FacetOption>) =>
    [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { reporters: sorted(reporters), pages: sorted(pages), workspaces: sorted(workspaces) };
}

// ─── chips ───────────────────────────────────────────────────────────────────

export type FilterChipKey = "q" | "type" | "severity" | "reporter" | "workspace" | "page" | "date" | "card";
export interface FilterChip { key: FilterChipKey; label: string }

/** The active filters as removable chips (status, the two quick chips and sort have their own controls). */
export function activeFilterChips(f: FeedbackFilters, facets?: FeedbackFacets | null): FilterChip[] {
  const chips: FilterChip[] = [];
  const label = (list: FacetOption[] | undefined, v: string) => list?.find((o) => o.value === v)?.label ?? v;
  if (f.q) chips.push({ key: "q", label: `Search: ${f.q}` });
  if (f.workspace) chips.push({ key: "workspace", label: `Workspace: ${label(facets?.workspaces, f.workspace)}` });
  if (f.reporter) chips.push({ key: "reporter", label: `Reporter: ${label(facets?.reporters, f.reporter)}` });
  if (f.type !== "all") chips.push({ key: "type", label: TYPE_FILTER_LABEL[f.type] });
  if (f.severity !== "all") chips.push({ key: "severity", label: `${SEVERITY_FILTER_LABEL[f.severity]} severity` });
  if (f.page) chips.push({ key: "page", label: `Page: ${f.page}` });
  if (f.from || f.to) chips.push({ key: "date", label: f.from && f.to ? `${f.from} to ${f.to}` : f.from ? `From ${f.from}` : `Up to ${f.to}` });
  if (f.card !== "all") chips.push({ key: "card", label: CARD_FILTER_LABEL[f.card] });
  return chips;
}

export function removeFilter(f: FeedbackFilters, key: FilterChipKey): FeedbackFilters {
  const next = { ...f, pageNo: 1 };
  switch (key) {
    case "q": next.q = ""; break;
    case "type": next.type = "all"; break;
    case "severity": next.severity = "all"; break;
    case "reporter": next.reporter = ""; break;
    case "workspace": next.workspace = ""; break;
    case "page": next.page = ""; break;
    case "date": next.from = ""; next.to = ""; break;
    case "card": next.card = "all"; break;
  }
  return next;
}

/** Anything narrower than the default view (sort and page number do not count). */
export function hasAnyFilter(f: FeedbackFilters): boolean {
  const d = DEFAULT_FEEDBACK_FILTERS;
  return f.q !== d.q || f.status !== d.status || f.type !== d.type || f.severity !== d.severity ||
    f.reporter !== d.reporter || f.workspace !== d.workspace || f.page !== d.page || f.from !== d.from ||
    f.to !== d.to || f.card !== d.card || f.real || f.fresh;
}

// ─── "New since my last visit" ───────────────────────────────────────────────

/** A new visit starts when the page opens after this long without one. */
export const VISIT_GAP_MS = 30 * 60_000;
export interface VisitMemory { seenAt: string | null; since: string | null }

/**
 * What to remember when the page opens at `now`. After 30+ quiet minutes the last time the
 * page was seen becomes "since"; a reload inside a visit keeps the same "since", so the chip
 * shows the same reports before and after a reload.
 */
export function nextVisitMemory(prev: VisitMemory | null, now: Date): VisitMemory {
  const seen = prev?.seenAt ? Date.parse(prev.seenAt) : NaN;
  const nowIso = now.toISOString();
  if (Number.isNaN(seen)) return { seenAt: nowIso, since: prev?.since ?? null };
  if (now.getTime() - seen >= VISIT_GAP_MS) return { seenAt: nowIso, since: new Date(seen).toISOString() };
  return { seenAt: nowIso, since: prev?.since ?? null };
}

// ─── one typed doorway for the two callers ───────────────────────────────────

/**
 * postgrest-js types its filter methods per table column; this file drives them by name.
 * Both callers (the browser hook and the platform route) pass their `from("feedback").select(…)`
 * through `looseFeedbackQuery` once, so the cast lives in one place.
 */
export interface LooseFeedbackQuery extends FeedbackQueryLike<LooseFeedbackQuery> {
  range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: unknown }>;
}
export function looseFeedbackQuery(q: unknown): LooseFeedbackQuery {
  return q as LooseFeedbackQuery;
}

/** The two reads behind one page of the list, built the same way for both callers. */
export function feedbackPageQueries(
  select: (cols: string) => unknown,
  f: FeedbackFilters,
  opts: Omit<FeedbackOpsOptions, "skipStatus">,
) {
  const { from, to } = pageRange(f.pageNo);
  return {
    /** The rows of this page. */
    page: () => applyFeedbackSort(applyFeedbackOps(looseFeedbackQuery(select("*")), feedbackFilterOps(f, opts)), f.sort).range(from, to),
    /** status + claim of EVERY row the other filters match — for the tab counts and the total. */
    counts: (a: number, b: number) =>
      applyFeedbackOps(looseFeedbackQuery(select(COUNT_COLUMNS)), feedbackFilterOps(f, { ...opts, skipStatus: true }))
        .order("id", { ascending: true }).range(a, b),
  };
}
export const COUNT_COLUMNS = "status, agent_claimed_at";
export const FACET_COLUMNS = "tenant_id, reporter_name, reporter_email, route_pattern, page_path, status, dispatched_at";
