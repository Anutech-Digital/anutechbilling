/**
 * R-1005 (12 Oct 2026, data-leak audit item e) — per-user limits on the browser data gateway
 * (/api/sb/rest/v1) for LOW roles (lib/auth/roles.ts GATEWAY_LIMITED_BY_ROLE: sales,
 * sales_senior, support, delivery, partner_agent; owner / manager / accountant / billing are
 * not limited).
 *
 * ══ THE HOLE ═══════════════════════════════════════════════════════════════════════════════
 *   Anyone signed in holds a session token the gateway accepts. Nothing counted their calls, so
 *   a low role could loop `?select=*&offset=N` over every table its RLS lets it read and walk
 *   out with the whole customer book in a few minutes — RLS decides WHICH rows, not HOW MANY.
 *
 * ══ WHAT IS LIMITED (low roles only) ════════════════════════════════════════════════════════
 *   1. Rate      — GATEWAY_LIMITS.perMinute requests a minute per user (rateLimitShared: one
 *                  count across Cloud Run instances when RATE_LIMIT_STORE=postgres).
 *   2. Rows/day  — GATEWAY_LIMITS.dailyRows rows returned per user per IST day. Counted from the
 *                  response's Content-Range after the read; checked before the next one. Shared
 *                  store: public.gateway_rows_add() (migration 20261012024706_r1005_gateway_row_budget), same
 *                  opt-in and memory fallback as the rate limiter.
 *   3. Paging    — offset ≤ maxOffset, limit ≤ maxLimit, at every level (embeds included).
 *   4. Columns   — no `select=*` (or no select at all, which means *) on customers, contacts or
 *                  payments, top level or embedded. Name the columns you need.
 *   Every refusal is a plain-English JSON 429 / 400 and one `gateway_refused` log line.
 *
 * R-1400: embedded child rows count in the row budget too (embeddedRowCount — Content-Range only
 * counts the top level), and an embed written by its FK column (`customer_id(*)`) is resolved to
 * the table it points at, so it meets the same star block as `customers(*)`.
 */
import "server-only";
import { withIdentity } from "@/server/db/gateway";
import { rateLimitShared } from "@/lib/security/rate-limit";
import { isGatewayLimitedRole } from "@/lib/auth/roles";
import { MAX_ROWS } from "./build";
import { parseSelect, type SelectItem } from "./parse";
import { getCatalog, type Catalog } from "./catalog";

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The numbers, in one place. Env overrides exist so they can be tuned without a release. */
export function gatewayLimits() {
  return {
    perMinute: envInt("GATEWAY_LOW_ROLE_PER_MINUTE", 300),
    dailyRows: envInt("GATEWAY_LOW_ROLE_DAILY_ROWS", 20_000),
    maxOffset: envInt("GATEWAY_LOW_ROLE_MAX_OFFSET", 5_000),
    maxLimit: MAX_ROWS,
  };
}

/** Tables a low role must name columns on. */
export const STAR_BLOCKED_TABLES: ReadonlySet<string> = new Set(["customers", "contacts", "payments"]);

export interface GatewayRefusal {
  status: 400 | 429;
  code: string;
  reason: "rate" | "rows" | "offset" | "limit" | "star";
  message: string;
  retryAfterSec?: number;
}

// ─── who is limited ─────────────────────────────────────────────────────────────────────────

const ROLE_TTL_MS = 60_000;
const roleCache = new Map<string, { role: string | null; at: number }>();

/** users.role for this user, read as that user (RLS: own row). Cached a minute. */
export async function gatewayRole(userId: string): Promise<string | null> {
  const hit = roleCache.get(userId);
  if (hit && Date.now() - hit.at < ROLE_TTL_MS) return hit.role;
  let role: string | null = null;
  try {
    role = await withIdentity({ mode: "user", userId }, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ role: string | null }[]>(
        "select role::text as role from public.users where id = $1::uuid", userId);
      return rows[0]?.role ?? null;
    });
  } catch {
    role = null; // unknown → limited (fail closed); not cached, so the next call retries
    return role;
  }
  if (roleCache.size > 10_000) roleCache.clear();
  roleCache.set(userId, { role, at: Date.now() });
  return role;
}

export { isGatewayLimitedRole };

// ─── shape of one request (pure) ────────────────────────────────────────────────────────────

function hasStar(items: SelectItem[]): boolean {
  return items.some((i) => i.kind === "star");
}

/** The catalog parts the shape check needs to resolve an embed. */
export type EmbedCatalog = Pick<Catalog, "tables" | "fks">;

/**
 * The table an embed reads. `customers(...)` names it; `customer_id(...)` (PostgREST's
 * column-name embedding) names the parent's FK column, so follow that FK. Without a catalog —
 * or when the name is unknown — `x_id` is read as table `xs`, which errs toward blocking.
 */
export function embedTarget(parent: string | null, relation: string, cat?: EmbedCatalog): string {
  if (cat?.tables.has(relation)) return relation;
  if (cat && parent) {
    const fk = cat.fks.find((f) => f.table === parent && f.columns.length === 1 && f.columns[0] === relation);
    if (fk) return fk.refTable;
  }
  if (relation.endsWith("_id")) return `${relation.slice(0, -3)}s`;
  return relation;
}

/** First blocked table reached with `*` — top level (`table`) or through an embed. */
function starOnBlocked(table: string | null, items: SelectItem[], cat?: EmbedCatalog): string | null {
  if (table && STAR_BLOCKED_TABLES.has(table) && hasStar(items)) return table;
  for (const i of items) {
    if (i.kind === "embed") {
      const found = starOnBlocked(embedTarget(table, i.relation, cat), i.items, cat);
      if (found) return found;
    }
  }
  return null;
}

type EmbedItem = Extract<SelectItem, { kind: "embed" }>;

/** Rows carried by embeds (to-many: each element; to-one: 1), at every depth. */
export function embeddedRowCount(items: SelectItem[], body: unknown): number {
  const embeds = items.filter((i): i is EmbedItem => i.kind === "embed");
  if (embeds.length === 0 || body === null || typeof body !== "object") return 0;
  const rows: unknown[] = Array.isArray(body) ? body : [body];
  let n = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const e of embeds) {
      const v = (row as Record<string, unknown>)[e.alias ?? e.relation];
      if (Array.isArray(v)) n += v.length + embeddedRowCount(e.items, v);
      else if (v && typeof v === "object") n += 1 + embeddedRowCount(e.items, v);
    }
  }
  return n;
}

/** True when the request's select embeds another table (then its body must be counted). */
export function selectHasEmbeds(search: URLSearchParams): boolean {
  try {
    return parseSelect(search.get("select")).some((i) => i.kind === "embed");
  } catch {
    return false;
  }
}

/** Embedded rows in a response body (JSON text) for this request's select. 0 if unreadable. */
export function embeddedRowsInBody(search: URLSearchParams, bodyText: string): number {
  try {
    return embeddedRowCount(parseSelect(search.get("select")), JSON.parse(bodyText));
  } catch {
    return 0;
  }
}

/**
 * Paging / column checks for a limited user. `path` is what follows /rest/v1/
 * ("customers", "rpc/foo"). Returns null when the request may go ahead.
 */
export function checkGatewayShape(
  method: string, path: string, search: URLSearchParams, cat?: EmbedCatalog,
): GatewayRefusal | null {
  const lim = gatewayLimits();
  for (const [key, value] of search) {
    const last = key.split(".").pop();
    if ((last === "offset" || last === "limit") && /^\d+$/.test(value)) {
      const n = Number(value);
      if (last === "offset" && n > lim.maxOffset) {
        return {
          status: 400, code: "ROS_OFFSET", reason: "offset",
          message: `This list cannot be read past row ${lim.maxOffset} in one go. Use search or filters to narrow it down.`,
        };
      }
      if (last === "limit" && n > lim.maxLimit) {
        return {
          status: 400, code: "ROS_LIMIT", reason: "limit",
          message: `At most ${lim.maxLimit} rows can be read per request.`,
        };
      }
    }
  }
  const m = method.toUpperCase();
  // HEAD returns no rows (counts only); writes return only the rows they wrote; rpc has its own shape.
  if (m !== "GET" || path.startsWith("rpc/")) return null;
  let items: SelectItem[];
  try {
    items = parseSelect(search.get("select"));
  } catch {
    return null; // the handler answers a bad select with its own 400
  }
  const table = starOnBlocked(path, items, cat);
  if (table) {
    return {
      status: 400, code: "ROS_SELECT_STAR", reason: "star",
      message: `Reading all columns of ${table} is not allowed for your role. Ask for the columns you need by name.`,
    };
  }
  return null;
}

// ─── daily row budget ───────────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 330 * 60_000;

/** The IST calendar day (YYYY-MM-DD) and the ms left until it ends. */
export function istDay(now = Date.now()): { day: string; msLeft: number } {
  const ist = now + IST_OFFSET_MS;
  const day = new Date(ist).toISOString().slice(0, 10);
  const nextMidnightIst = Date.parse(`${day}T00:00:00Z`) + 86_400_000 - IST_OFFSET_MS;
  return { day, msLeft: Math.max(1000, Math.min(86_400_000, nextMidnightIst - now)) };
}

const memRows = new Map<string, number>();

function memAdd(key: string, rows: number): number {
  if (memRows.size > 50_000) memRows.clear();
  const used = (memRows.get(key) ?? 0) + rows;
  memRows.set(key, used);
  return used;
}

async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const SHARED_TIMEOUT_MS = 300;
const SHARED_COOLDOWN_MS = 30_000;
let sharedDownUntil = 0;

/** Shared count via public.gateway_rows_add (service_role only). null = use memory. */
async function sharedAdd(key: string, rows: number, limit: number, windowMs: number): Promise<number | null> {
  if (process.env.RATE_LIMIT_STORE !== "postgres" || Date.now() < sharedDownUntil) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SHARED_TIMEOUT_MS);
  try {
    let f: (input: string, init?: RequestInit) => Promise<Response> = fetch;
    if (process.env.DATA_GATEWAY === "1") {
      const { gatewayFetch } = await import("./fetch");
      f = gatewayFetch(url, { allowService: true }) as typeof f;
    }
    const r = await f(`${url.replace(/\/$/, "")}/rest/v1/rpc/gateway_rows_add`, {
      method: "POST",
      headers: { apikey: svc, authorization: `Bearer ${svc}`, "content-type": "application/json" },
      body: JSON.stringify({ p_key: await hashKey(key), p_rows: rows, p_limit: limit, p_window_ms: windowMs }),
      cache: "no-store",
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const out = (await r.json()) as Array<{ used: number }>;
    const used = Array.isArray(out) ? Number(out[0]?.used) : NaN;
    if (!Number.isFinite(used)) throw new Error("bad answer");
    return used;
  } catch {
    sharedDownUntil = Date.now() + SHARED_COOLDOWN_MS;
    console.warn("[gateway-limits] shared row store unavailable — memory fallback for 30s");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Add `rows` to today's count for this user (0 = just read it). Returns the new total. */
export async function addGatewayRows(userId: string, rows: number, now = Date.now()): Promise<number> {
  const { day, msLeft } = istDay(now);
  const key = `gw-rows:${userId}:${day}`;
  const shared = await sharedAdd(key, rows, gatewayLimits().dailyRows, msLeft);
  return shared ?? memAdd(key, rows);
}

/** Rows a response carried, from its Content-Range ("0-49/*" → 50; "*\/0" → 0). */
export function rowsFromContentRange(header: string | null): number {
  const m = /^(\d+)-(\d+)\//.exec(header ?? "");
  return m ? Number(m[2]) - Number(m[1]) + 1 : 0;
}

// ─── the whole check ────────────────────────────────────────────────────────────────────────

/** Everything that runs BEFORE the query for a limited user. */
export async function gatewayGuard(
  userId: string, method: string, path: string, search: URLSearchParams,
): Promise<GatewayRefusal | null> {
  const lim = gatewayLimits();
  const rate = await rateLimitShared(`gw:${userId}`, { limit: lim.perMinute, windowMs: 60_000 });
  if (!rate.ok) {
    return {
      status: 429, code: "ROS_RATE", reason: "rate", retryAfterSec: rate.retryAfterSec,
      message: `Too many requests — please wait ${rate.retryAfterSec} seconds and try again.`,
    };
  }
  let cat: EmbedCatalog | undefined;
  if (selectHasEmbeds(search)) {
    try { cat = await getCatalog(); } catch { cat = undefined; } // unresolved → the x_id rule
  }
  const shape = checkGatewayShape(method, path, search, cat);
  if (shape) return shape;
  const m = method.toUpperCase();
  // Reads only: a low role who used up the day's reads can still save their work.
  if (m === "GET" || (m === "POST" && path.startsWith("rpc/"))) {
    const used = await addGatewayRows(userId, 0);
    if (used >= lim.dailyRows) {
      return {
        status: 429, code: "ROS_DAILY_ROWS", reason: "rows", retryAfterSec: Math.ceil(istDay().msLeft / 1000),
        message: `You have reached today's limit of ${lim.dailyRows.toLocaleString("en-IN")} records read. It resets at midnight (IST). Ask your owner or manager if you need more.`,
      };
    }
  }
  return null;
}

export function refusalResponse(r: GatewayRefusal): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (r.retryAfterSec) headers["Retry-After"] = String(r.retryAfterSec);
  return new Response(JSON.stringify({ code: r.code, details: null, hint: null, message: r.message }), { status: r.status, headers });
}

export function logRefusal(r: GatewayRefusal, ctx: { userId: string; role: string | null; method: string; path: string }): void {
  console.warn(JSON.stringify({ event: "gateway_refused", card: "R-1005", reason: r.reason, code: r.code, ...ctx }));
}

/** Test only. */
export function resetGatewayLimitState(): void {
  roleCache.clear();
  memRows.clear();
  sharedDownUntil = 0;
}
