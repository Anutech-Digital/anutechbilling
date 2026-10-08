/**
 * R-210 (R-064 part) — the Customers list reads 50 rows at a time from the server.
 *
 * WHY: since R-046 the page read EVERY customer (fetchAllRows) just to paint 60 of them.
 * Correct, but at a few thousand customers the first paint waits for all of them.
 *
 * What moved to the server, and what did not:
 *   - The DEFAULT screen (view "All", newest first, with or without a search) is a paged
 *     server read: 50 rows, search + archived filter in the query, an exact total.
 *   - The chip counts and the KPI strip no longer need the customer rows at all. Every
 *     non-"All" view is a test on per-customer facts the page already loads in full
 *     (subscriptions, receivables, credits, projects, received this FY, missing state), so a
 *     chip's count is "customers in those maps that pass" plus, when a customer with NO
 *     facts would also pass (No business), the customers outside the maps — from the
 *     server's total. Exact, with no customer rows read.
 *   - The other views and the money sorts (MRR, debtors, …) order or filter by data that
 *     lives in other tables, so they still read the whole list (useCustomers), exactly as
 *     before. Only the default screen changed.
 */
import type { ProjectLike } from "@/lib/customers/portfolio-status";
import type { ContactSearchIndex } from "@/lib/contacts/search-index";

/** What a view chip tests a customer on (VIEW_DEFS in page.tsx). */
export type ViewCtx = { amount: number; credit: number; hasSub: boolean; projects: readonly ProjectLike[]; received: number; noState: boolean };

/** One view chip: its id and the test a customer must pass (the page owns the list, VIEW_DEFS). */
export type ViewDef = { id: string; test: (x: ViewCtx) => boolean };

/** The per-customer facts the page holds in full, keyed by customer id. */
export interface CustomerFacts {
  outstanding: ReadonlyMap<string, { amount: number }>;
  credits: Readonly<Record<string, number>>;
  subs: ReadonlyMap<string, { mrr: number }>;
  projects: ReadonlyMap<string, readonly ProjectLike[]>;
  received: Readonly<Record<string, { total: number } | undefined>>;
  noState: ReadonlySet<string>;
}

const NO_PROJECTS: readonly ProjectLike[] = [];

export function viewCtxFor(id: string, f: CustomerFacts): ViewCtx {
  return {
    amount: f.outstanding.get(id)?.amount ?? 0,
    credit: f.credits[id] ?? 0,
    hasSub: f.subs.has(id),
    projects: f.projects.get(id) ?? NO_PROJECTS,
    received: f.received[id]?.total ?? 0,
    noState: f.noState.has(id),
  };
}

/** A customer nothing is known about — what every customer outside the fact maps looks like. */
const EMPTY_CTX: ViewCtx = { amount: 0, credit: 0, hasSub: false, projects: NO_PROJECTS, received: 0, noState: false };

/**
 * Every chip's count without reading a single customer row.
 *
 * `allCount` is the server's count of customers (active + archived, as the chips always
 * counted). Customers that appear in no fact map all share EMPTY_CTX, so they pass a view
 * together or not at all — that is what makes "No business" countable from a total.
 */
export function customerViewCounts(
  allCount: number, f: CustomerFacts, views: readonly ViewDef[],
): Record<string, number> {
  const ids = new Set<string>();
  for (const k of f.outstanding.keys()) ids.add(k);
  for (const k of Object.keys(f.credits)) ids.add(k);
  for (const k of f.subs.keys()) ids.add(k);
  for (const k of f.projects.keys()) ids.add(k);
  for (const k of Object.keys(f.received)) ids.add(k);
  for (const k of f.noState) ids.add(k);
  const outside = Math.max(0, allCount - ids.size);

  const m: Record<string, number> = {};
  for (const v of views) {
    if (v.id === "all") { m[v.id] = allCount; continue; }
    let n = v.test(EMPTY_CTX) ? outside : 0;
    for (const id of ids) if (v.test(viewCtxFor(id, f))) n++;
    m[v.id] = n;
  }
  return m;
}

/**
 * The KPI money totals, from the fact maps alone. The page used to add these up over its
 * customer rows; each map is keyed by an existing customer's id, so summing the map is
 * the same number without the rows.
 */
export function customerMoneyTotals(f: Pick<CustomerFacts, "subs" | "outstanding" | "received">) {
  let mrr = 0, receivables = 0, received = 0;
  for (const v of f.subs.values()) mrr += v.mrr;
  for (const v of f.outstanding.values()) receivables += v.amount;
  for (const v of Object.values(f.received)) received += v?.total ?? 0;
  return { mrr, arr: mrr * 12, receivables, received };
}

/** More than this many person-matched customers → the search falls back to the full list
 *  (an `id.in.(…)` that long would make the request URL too big for the proxy). */
export const CONTACT_MATCH_ID_CAP = 200;

/**
 * Customers whose PEOPLE match the search (the contact link table, not customers.contact_*).
 * Same test as customerMatchesContact, run once over the index instead of once per row.
 * null = no search, or the index has not loaded yet.
 */
export function contactMatchedCustomerIds(index: ContactSearchIndex | undefined, search: string): string[] | null {
  const s = search.trim().toLowerCase();
  if (!s || !index) return null;
  const out: string[] = [];
  for (const [id, text] of index.textByCustomer) if (text.includes(s)) out.push(id);
  return out.sort();
}

export type CustomerListMode = "server" | "full";

/**
 * Which read the list uses. Server paging only where the server can produce exactly the
 * rows and order the old full-list code produced: view "All", newest first, and a search
 * whose person-matches fit in one request. Everything else reads the full list, as before.
 */
export function customerListMode(o: {
  view: string; sortKey: string; sortDir: "asc" | "desc"; contactIds: readonly string[] | null;
}): CustomerListMode {
  if (o.view !== "all") return "full";
  if (o.sortKey !== "recent" || o.sortDir !== "desc") return "full";
  if (o.contactIds && o.contactIds.length > CONTACT_MATCH_ID_CAP) return "full";
  return "server";
}
