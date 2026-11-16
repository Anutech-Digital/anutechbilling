"use client";
/**
 * R-2876 — Status / Last bill in ONE read.
 *
 * R-2861 measured the Renewals page: after the table showed, Status and Last bill waited for four trips in a
 * row (quotes + billing parts → part proformas + invoices → quote lines + credit / debit notes → payments).
 * Each trip asks only for rows named by the trip before, so the browser could not ask sooner.
 *
 * public.renewal_row_facts(p_sub_ids, p_quote_ids) (migration *_r2876_renewal_row_facts; read-only, SECURITY
 * INVOKER — RLS decides every row, as for the old reads) returns every row those trips can ask for, in one answer.
 * This file does NOT re-implement the page's rules on that answer. It hands the old readers (last-docs-data.ts
 * readRenewalDocRows / docsFromRows, last-paid-data.ts lastPaidFromDocRows) a stand-in for the Supabase client that
 * answers each of their reads from the answer already in memory: same filter, same columns, same order, same paging.
 * So the pure rules (last-docs.ts, last-paid.ts) get the rows they always got — the equality is proven on a fixture
 * in row-facts-r2876.test.ts and on the local database in e2e/cards/R-2876.spec.ts.
 *
 * COVERED OR NOT ANSWERED. The stand-in answers a read only when the function was asked for everything that read
 * can match (e.g. invoices by quote id: only for the quotes the function looked invoices up for). A read outside
 * that — an id it was not asked about, a table / column / filter / order / query method it does not know, a column
 * the function does not return — is recorded in `misses` and refused; the caller then throws the whole in-memory
 * result away and reads the old way (withRowFacts). A later change to the old reads can therefore make this path
 * fall back (slower, reported once to Sentry), never show different rows.
 *
 * FALLBACK. The function missing (app deployed before the DB step), any error from it, or more than
 * ROW_FACTS_MAX_SUBS listed subscriptions → the old reads, exactly as before this card. A failed read is not asked
 * again for ROW_FACTS_RETRY_MS (a missing function: not again on this page load), so a slow failure (a timeout) is
 * never paid on every refresh.
 */
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, unknown>;

/** The function's answer (see the migration's header). Every list is in `order by id`. */
export interface RenewalRowFacts {
  quotes: Row[];
  billings: Row[];
  links: Row[];
  invoices: Row[];
  credit_notes: Row[];
  debit_notes: Row[];
  subscriptions: Row[];
  payments: Row[];
  invoice_ids: string[];
}
const LISTS = ["quotes", "billings", "links", "invoices", "credit_notes", "debit_notes", "subscriptions", "payments", "invoice_ids"] as const;

export function isRowFacts(x: unknown): x is RenewalRowFacts {
  return !!x && typeof x === "object" && LISTS.every((k) => Array.isArray((x as Row)[k]));
}

/** What the function is asked with: the listed subscriptions and the quotes they point at. */
export interface FactsRef { id: string; quote_id: string | null; renewal_quote_id: string | null }

/** Above this many listed subscriptions the page reads the old way (one answer would get too large). */
export const ROW_FACTS_MAX_SUBS = 1500;
/** After a failed read (not "function missing") the one read is not tried again for this long. */
export const ROW_FACTS_RETRY_MS = 5 * 60_000;
/** Two readers that start within this window share one request (Last docs + Last paid start together). */
export const ROW_FACTS_JOIN_MS = 50;

type PageAnswer = Promise<{ data: Row[] | null; error: unknown }>;
/** The part of the Supabase query builder the Renewals readers use. */
export interface FactsQuery {
  select(cols: string): FactsQuery;
  in(col: string, ids: readonly unknown[]): FactsQuery;
  eq(col: string, value: unknown): FactsQuery;
  neq(col: string, value: unknown): FactsQuery;
  order(col: string, opts?: { ascending?: boolean }): FactsQuery;
  range(from: number, to: number): PageAnswer;
}
/** The stand-in client. `misses`: every read it refused (empty = everything was answered in full). */
export interface FactsClient {
  from(table: string): FactsQuery;
  readonly misses: string[];
}

/** The columns the function returns per table (the SQL test asserts them) — a read may name only these. */
const QUOTE_COLUMNS = [
  "id", "status", "payment_status", "created_at", "created_date", "expires_date", "invoice_id", "renewal_subscription_id",
  "add_seats_subscription_id", "subscription_billing_id", "superseded_by", "revision_of", "amount", "currency", "exchange_rate",
  "line_items", "is_renewal", "is_extension", "is_add_seats", "is_one_off", "extension_months", "renewal_term_date",
] as const;
const COLUMNS: Record<string, readonly string[]> = {
  quotes: QUOTE_COLUMNS,
  subscription_billings: ["id", "subscription_id", "invoice_id", "term_start", "period_index", "due_on", "period_start", "period_end", "taxable_amount"],
  renewal_quote_subscriptions: ["id", "quote_id", "subscription_id", "renewal_term_date", "subtotal", "renewed_at", "released_at"],
  invoices: ["id", "quote_id", "invoice_date", "status", "amount", "paid_amount", "currency", "created_at", "due_date", "net_payable", "adjusted_advances", "written_off_at", "fx_rate"],
  credit_notes: ["id", "invoice_id", "amount"],
  debit_notes: ["id", "invoice_id", "amount"],
  subscriptions: ["id", "quote_id"],
  payments: ["id", "amount", "method", "status", "received_at", "refunded_at", "quote_id", "invoice_id", "receipt_voucher_no", "reference"],
};

type Covers = (id: unknown) => boolean;
interface Table {
  rows: Row[];
  /** column → may an `.in(column, ids)` with this id be answered in full? */
  covers: Record<string, Covers>;
  /** the function returned only rows with this value — the read must ask for exactly that */
  only?: { col: string; value: unknown };
}

type SelectItem = { col: string } | { embed: string; cols: string[] };
/** "a, b, quotes(c, d)" → columns and one-level embeds; anything else (a star, a cast, an alias) → null. */
export function parseSelect(select: string): SelectItem[] | null {
  const parts: string[] = [];
  let depth = 0; let cur = "";
  for (const ch of select) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  const out: SelectItem[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    const embed = /^([a-z_][a-z0-9_]*)\(([^()]*)\)$/.exec(p);
    if (embed) {
      const cols = embed[2].split(",").map((c) => c.trim());
      if (!cols.every((c) => /^[a-z_][a-z0-9_]*$/.test(c))) return null;
      out.push({ embed: embed[1], cols });
    } else if (/^[a-z_][a-z0-9_]*$/.test(p)) out.push({ col: p });
    else return null;
  }
  return out;
}

const idSet = (rows: readonly Row[], col = "id") => new Set<unknown>(rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined));

/** The stand-in client over one answer of the function (asked with these subscription and quote ids). */
export function factsClient(facts: RenewalRowFacts, subIds: readonly string[], quoteIds: readonly string[]): FactsClient {
  const misses: string[] = [];
  const subs = new Set<unknown>(subIds);
  const asked = new Set<unknown>(quoteIds);
  /* main = linked to the listed subscriptions: the function looked up THEIR invoices, payments and sibling subscriptions */
  const mainQuotes = idSet(facts.quotes.filter((q) => q.main === true));
  const anyQuote = new Set<unknown>([...idSet(facts.quotes), ...asked, ...idSet(facts.links, "quote_id"), ...idSet(facts.invoices, "quote_id")]);
  const quoteKey: Covers = (id) => mainQuotes.has(id) || asked.has(id);
  const billingIds = idSet(facts.billings);
  const invoiceIds = new Set<unknown>([...facts.invoice_ids, ...idSet(facts.invoices)]);
  const invoiceKey: Covers = (id) => invoiceIds.has(id);
  const quoteById = new Map(facts.quotes.map((q) => [q.id, q]));

  const tables: Record<string, Table> = {
    quotes: {
      rows: facts.quotes,
      covers: {
        renewal_subscription_id: (id) => subs.has(id),
        add_seats_subscription_id: (id) => subs.has(id),
        subscription_billing_id: (id) => billingIds.has(id),
        id: (id) => anyQuote.has(id),
      },
    },
    subscription_billings: { rows: facts.billings, covers: { subscription_id: (id) => subs.has(id) } },
    renewal_quote_subscriptions: { rows: facts.links, covers: { subscription_id: (id) => subs.has(id) } },
    invoices: { rows: facts.invoices, covers: { id: invoiceKey, quote_id: quoteKey } },
    credit_notes: { rows: facts.credit_notes, covers: { invoice_id: invoiceKey } },
    debit_notes: { rows: facts.debit_notes, covers: { invoice_id: invoiceKey } },
    subscriptions: { rows: facts.subscriptions, covers: { quote_id: quoteKey } },
    payments: { rows: facts.payments, covers: { quote_id: quoteKey, invoice_id: invoiceKey }, only: { col: "status", value: "received" } },
  };

  function from(name: string): FactsQuery {
    const t = tables[name];
    let bad: string | null = null;
    const miss = (why: string) => { if (!bad) { bad = why; misses.push(`${name}: ${why}`); } };
    if (!t) miss("table not in the answer");
    /* a column is usable only when the function returns it — and really did, on every row read */
    const column = (table: string, c: string) => { if (!(COLUMNS[table] ?? []).includes(c)) miss(`column ${table}.${c} is not in the answer`); };
    const pick = (table: string, row: Row, cols: readonly string[]): Row => {
      const out: Row = {};
      for (const c of cols) {
        if (!(c in row)) miss(`column ${table}.${c} is missing from a row`);
        out[c] = row[c] ?? null;
      }
      return out;
    };
    let items: SelectItem[] | null = null;
    const filters: ((r: Row) => boolean)[] = [];
    let ins = 0; let ordered = false; let onlyAsked = !t?.only;
    const q: FactsQuery = {   // every method hands back `self` (the proxy below), so an unknown method is caught anywhere in the chain
      select(cols) {
        items = parseSelect(cols);
        if (!items) miss(`select "${cols}" not understood`);
        else for (const it of items) {
          if ("col" in it) column(name, it.col);
          else if (name === "renewal_quote_subscriptions" && it.embed === "quotes") it.cols.forEach((c) => column("quotes", c));
          else miss(`embed ${it.embed} not in the answer`);
        }
        return self;
      },
      in(col, ids) {
        const covers = t?.covers[col];
        ins += 1;
        if (!covers) miss(`read by ${col} is not covered`);
        else if (!ids.every(covers)) miss(`read by ${col} asks for ids the answer does not cover`);
        const set = new Set<unknown>(ids);
        filters.push((r) => set.has(r[col]));
        return self;
      },
      eq(col, value) {
        column(name, col);
        if (t?.only && t.only.col === col && t.only.value === value) onlyAsked = true;
        filters.push((r) => r[col] === value);
        return self;
      },
      /* PostgREST's neq leaves a NULL out too */
      neq(col, value) {
        column(name, col);
        filters.push((r) => r[col] !== null && r[col] !== undefined && r[col] !== value);
        return self;
      },
      order(col, opts) {
        /* every list arrives in the database's own `order by id` — the only order answered here */
        if (col !== "id" || opts?.ascending === false || ordered) miss(`order by ${col} is not covered`);
        ordered = true;
        return self;
      },
      range(start, end) {
        if (ins !== 1) miss("the read must name one id list");
        if (!ordered) miss("the read has no order");
        if (!onlyAsked) miss(`only ${t?.only?.col} = ${String(t?.only?.value)} rows are in the answer`);
        if (!items) miss("the read selects nothing");
        const rows = bad || !t || !items ? [] : t.rows.filter((r) => filters.every((f) => f(r))).slice(start, end + 1).map((r) => {
          const out: Row = {};
          for (const it of items!) {
            if ("col" in it) Object.assign(out, pick(name, r, [it.col]));
            else {
              const quote = quoteById.get(r.quote_id);
              out[it.embed] = quote ? pick("quotes", quote, it.cols) : null;
            }
          }
          return out;
        });
        return Promise.resolve(bad ? { data: null, error: new Error(`R-2876: ${name}: ${bad}`) } : { data: rows, error: null });
      },
    };
    /* Any other builder method (.is, .or, .gte, .limit, .single, …) is a read this stand-in cannot answer: record the
       miss (so the caller falls back even when a reader swallows the error) and keep the chain alive up to range(). */
    const self: FactsQuery = new Proxy(q, {
      get(target, prop, receiver) {
        if (typeof prop !== "string" || prop in target || prop === "then") return Reflect.get(target, prop, receiver);
        return () => { miss(`query method .${prop}() is not covered`); return receiver; };
      },
    });
    return self;
  }
  return { from, misses };
}

/** One answer of the function; `client()` gives each reader its own stand-in (its own `misses`). */
export class RowFactsAnswer {
  constructor(private readonly facts: RenewalRowFacts, private readonly subIds: readonly string[], private readonly quoteIds: readonly string[]) {}
  client(): FactsClient { return factsClient(this.facts, this.subIds, this.quoteIds); }
}

/* When the one read may be tried again: Infinity = the function is missing on this server (deployed before the DB
   step) — not again on this page load; a time = a failed read (timeout, refused) — not again before it. */
let offUntil = 0;
let reported = false;
/** Reads in flight, by what they ask — joined only by a reader that starts within ROW_FACTS_JOIN_MS. */
const inFlight = new Map<string, { at: number; read: Promise<RowFactsAnswer | null> }>();
/** Tests only. */
export function resetRowFactsForTest(): void { offUntil = 0; reported = false; inFlight.clear(); }

function isMissingFunction(e: unknown): boolean {
  const err = (e ?? {}) as { code?: unknown; status?: unknown; message?: unknown };
  return err.code === "PGRST202" || err.code === "42883" || err.status === 404
    || (typeof err.message === "string" && /could not find the function/i.test(err.message));
}
/** The page still works (old reads) — but the speed-up is off, so say it once per page load: console + Sentry. */
function report(why: string, e?: unknown, expected = false): void {
  if (reported) return;
  reported = true;
  console.warn(`R-2876: renewal row facts not used (${why}) — reading the old way`, e ?? "");
  if (expected) return;   // a missing function right after a deploy is the planned order, not an error
  try {
    Sentry.captureMessage(`R-2876: Renewals one-read not used — ${why}`, { level: "warning", extra: { error: e instanceof Error ? e.message : (e as { message?: unknown } | undefined)?.message ?? null } });
  } catch { /* monitoring must never break the page */ }
}

/** The one read. null = not available / not usable here → the caller reads the old way. */
export async function readRenewalRowFacts(rows: readonly FactsRef[], now: () => number = Date.now): Promise<RowFactsAnswer | null> {
  if (now() < offUntil || rows.length === 0 || rows.length > ROW_FACTS_MAX_SUBS) return null;
  const subIds = [...new Set(rows.map((s) => s.id))].sort();
  const quoteIds = [...new Set(rows.flatMap((s) => [s.quote_id, s.renewal_quote_id]).filter((x): x is string => !!x))].sort();
  try {
    const { data, error } = await (createClient() as unknown as SupabaseClient).rpc("renewal_row_facts", { p_sub_ids: subIds, p_quote_ids: quoteIds });
    if (error) {
      const missing = isMissingFunction(error);
      offUntil = missing ? Number.POSITIVE_INFINITY : now() + ROW_FACTS_RETRY_MS;
      report(missing ? "the function is not on this server yet" : "the read failed", error, missing);
      return null;
    }
    if (!isRowFacts(data)) {
      offUntil = now() + ROW_FACTS_RETRY_MS;
      report("unexpected answer");
      return null;
    }
    return new RowFactsAnswer(data, subIds, quoteIds);
  } catch (e) {
    offUntil = now() + ROW_FACTS_RETRY_MS;
    report("the read failed", e);
    return null;
  }
}

/**
 * Shared by Last docs and Last paid: started together, they are ONE request. A reader that starts later (after a
 * payment or a quote change invalidated it) never joins a read that began before that change — it asks again, as the
 * old payment reads did.
 */
export function fetchRenewalRowFacts(rows: readonly FactsRef[], now: () => number = Date.now): Promise<RowFactsAnswer | null> {
  const key = rows.map((s) => `${s.id}:${s.quote_id ?? ""}:${s.renewal_quote_id ?? ""}`).sort().join("|");
  const running = inFlight.get(key);
  if (running && now() - running.at <= ROW_FACTS_JOIN_MS) return running.read;
  const entry = { at: now(), read: readRenewalRowFacts(rows, now) };
  inFlight.set(key, entry);
  void entry.read.finally(() => { if (inFlight.get(key) === entry) inFlight.delete(key); });
  return entry.read;
}

/**
 * Run a reader on the one-read answer; anything not fully answered → the old reads.
 * `viaFacts` gets the stand-in client and must pass it to every read it makes.
 */
export async function withRowFacts<T>(
  rows: readonly FactsRef[], viaFacts: (client: FactsClient) => Promise<T>, oldWay: () => Promise<T>,
): Promise<T> {
  const client = (await fetchRenewalRowFacts(rows))?.client();
  if (client) {
    try {
      const out = await viaFacts(client);
      if (client.misses.length === 0) return out;
      offUntil = Date.now() + ROW_FACTS_RETRY_MS;   // the answer does not fit the readers: do not pay for it on every refresh
      report(`not covered: ${client.misses[0]}`);
    } catch (e) {
      offUntil = Date.now() + ROW_FACTS_RETRY_MS;
      report("the answer could not be used", e);
    }
  }
  return oldWay();
}
