/**
 * R-1637 (24 Oct 2026) — which website orders /online-orders reads.
 *
 * The page read the newest 100 orders (`.limit(100)`) and then searched and summed "Paid this
 * month" over only those, so an older order could not be found and its money was missing from
 * the tile. Now:
 *   - the list is one page at a time (ORDERS_PAGE more per "Load more"), with the total count;
 *   - the search box filters in the database (company, email, contact, domain, order id);
 *   - "Paid this month" reads EVERY order created in the IST month (paged past the 1000-row
 *     cap) and runs the same money pipeline as the list (order-money.ts, R-1120) — never the
 *     loaded slice.
 * Every read carries the tenant filter as well as RLS.
 */
import { WEBSITE_ORDER_FILTER } from "@/lib/online-orders/sources";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { istDayStartUtc, istMonth, monthBounds } from "@/lib/dates/ist";
import type { createClient } from "@/lib/supabase/client";

type Client = ReturnType<typeof createClient>;

/** Orders per page of the list; "Load more" adds this many. */
export const ORDERS_PAGE = 100;

export const LEAD_ORDER_COLUMNS =
  "id, company, contact_name, contact_email, contact_phone, plan, seats, value, stage, source, notes, created_at, follow_up_date, domain, utm_source, trial_started_at, trial_expires_at, owner:users!leads_owner_id_fkey(full_name)";

/* notes: a trial's domain is written there ("Domain: acme.in") when the domain column is empty —
   the row shows it (domainFromNotes), so the search finds it. */
const SEARCH_COLUMNS = ["company", "contact_email", "contact_name", "domain", "notes"] as const;

/**
 * The search box as one PostgREST `or` group, or null when blank. LIKE wildcards and quote
 * characters are dropped (same rule as the Ctrl+K search). An order number is shown as
 * "ORD-0042" for lead L-0042, so a typed "ORD-" prefix is dropped for the id match.
 */
export function orderSearchOr(search: string): string | null {
  const s = search.toLowerCase().replace(/[%*"\\]/g, "").trim();
  if (!s) return null;
  const id = s.replace(/^ord-?/, "") || s;
  return [...SEARCH_COLUMNS.map((c) => `${c}.ilike."%${s}%"`), `id.ilike."%${id}%"`].join(",");
}

/** The IST calendar month `now` falls in, as UTC instants: created_at >= from and < to. */
export function monthCreatedRange(now: Date = new Date()): { from: string; to: string } {
  const { start, nextStart } = monthBounds(istMonth(now));
  return { from: istDayStartUtc(start).toISOString(), to: istDayStartUtc(nextStart).toISOString() };
}

/** One page of the list: the newest `limit` website orders matching the search, and how many match in all. */
export async function fetchOrderLeadsPage<T>(
  db: Client,
  opts: { tenantId: string | null | undefined; search: string; limit: number },
): Promise<{ rows: T[]; total: number | null }> {
  let q = db.from("leads").select(LEAD_ORDER_COLUMNS, { count: "exact" });
  if (opts.tenantId) q = q.eq("tenant_id", opts.tenantId);
  q = q.or(WEBSITE_ORDER_FILTER);
  const search = orderSearchOr(opts.search);
  if (search) q = q.or(search);
  const { data, error, count } = await q
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(0, Math.max(1, opts.limit) - 1);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as T[], total: count ?? null };
}

/** Every website order created in this IST month — what "Paid this month" and "New today" count. */
export async function fetchMonthOrderLeads<T>(
  db: Client,
  opts: { tenantId: string | null | undefined; now?: Date },
): Promise<T[]> {
  const { from, to } = monthCreatedRange(opts.now);
  return await fetchAllRows<T>((a, z) => {
    let q = db.from("leads").select(LEAD_ORDER_COLUMNS);
    if (opts.tenantId) q = q.eq("tenant_id", opts.tenantId);
    return q
      .or(WEBSITE_ORDER_FILTER)
      .gte("created_at", from)
      .lt("created_at", to)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(a, z) as unknown as PromiseLike<{ data: T[] | null; error: unknown }>;
  });
}
