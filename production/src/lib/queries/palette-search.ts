/**
 * R-1121 — Ctrl+K searches the server, a few rows at a time.
 *
 * The palette is mounted on every page and, the first time it opened, read SIX whole tables
 * (customers, quotes, contacts, invoices, subscriptions, payments — every column, every row,
 * paged past the 1000-row cap) only to show ten of each. On a big workspace or a slow phone
 * that was the slowest thing in the app, and it showed "No results found" until it finished.
 *
 * Now: nothing is read until something is typed. Then each group asks the database for at
 * most PALETTE_LIMIT rows that match every typed word (PostgREST `or=` per word — repeated
 * `or` params are ANDed), with the columns the row shows. Rows come through RLS, and also
 * carry an explicit tenant filter when the tenant is known — the palette never asks for
 * another company's rows. Leads were already searched this way (useLeadSearch, S40).
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

type Client = ReturnType<typeof createClient>;

/** Rows per group per typed query. */
export const PALETTE_LIMIT = 8;
/** At most this many typed words become filters (a pasted paragraph is not a search). */
const MAX_TERMS = 4;

/**
 * The typed words, safe to place inside a quoted PostgREST or-value: the LIKE wildcards
 * `%` `*` and the quoting characters `"` `\` are dropped (same rule as customerSearchOr).
 */
export function paletteTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[%*"\\]/g, "")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, MAX_TERMS);
}

/** `col.ilike."%term%"` for each column, comma-joined — one PostgREST `or` group. */
export function ilikeAny(columns: readonly string[], term: string): string {
  return columns.map((c) => `${c}.ilike."%${term}%"`).join(",");
}

/** The filter-builder methods the searches use — real client or a test double. */
interface Filterable<T> {
  or(filters: string): T;
  eq(column: string, value: string): T;
}
function applyTerms<T extends Filterable<T>>(q: T, columns: readonly string[], terms: string[], tenantId?: string | null): T {
  let out = q;
  if (tenantId) out = out.eq("tenant_id", tenantId);
  for (const t of terms) out = out.or(ilikeAny(columns, t));
  return out;
}

// ── Columns: what each row shows, and what each search matches ────────────────────────

export const PALETTE_CUSTOMER_COLUMNS = "id, name, display_name, domain, city, state, contact_name, contact_email, contact_phone, gstin";
export const PALETTE_CUSTOMER_SEARCH = ["name", "display_name", "domain", "contact_name", "contact_email", "contact_phone", "gstin", "customer_number"] as const;

export const PALETTE_QUOTE_COLUMNS = "id, customer_name, amount, status, plan";
export const PALETTE_QUOTE_SEARCH = ["id", "customer_name", "plan", "domain"] as const;

/* quote_id: R-1639 — the payment search finds a GST invoice's payments through its quote. */
export const PALETTE_INVOICE_COLUMNS = "id, customer_name, amount, status, quote_id";
export const PALETTE_INVOICE_SEARCH = ["id", "customer_name", "external_number"] as const;

/* The full row: "Add seats" opens AddSeatsDialog with it. Eight rows, so it stays small. */
export const PALETTE_SUBSCRIPTION_COLUMNS = "*";
export const PALETTE_SUBSCRIPTION_SEARCH = ["customer_name", "plan", "vendor", "domain"] as const;

export const PALETTE_CONTACT_COLUMNS = "id, full_name, email, phone, company, title, customer_id";
export const PALETTE_CONTACT_SEARCH = ["full_name", "email", "phone", "company"] as const;

export const PALETTE_PAYMENT_COLUMNS = "id, amount, method, reference, received_at, customer_id, quote_id, invoice_id, receipt_voucher_no";
/* R-1639: the receipt number and the document (quote / imported invoice) the payment is on. */
export const PALETTE_PAYMENT_SEARCH = ["reference", "receipt_voucher_no", "quote_id", "invoice_id"] as const;

export interface PaletteCustomer {
  id: string; name: string; display_name: string | null; domain: string | null;
  city: string | null; state: string | null; contact_name: string | null;
  contact_email: string | null; contact_phone: string | null; gstin: string | null;
}
export interface PaletteQuote { id: string; customer_name: string | null; amount: number | null; status: string | null; plan: string | null }
export interface PaletteInvoice { id: string; customer_name: string | null; amount: number | null; status: string | null; quote_id?: string | null }
export interface PaletteContact {
  id: string; full_name: string | null; email: string | null; phone: string | null;
  company: string | null; title: string | null; customer_id: string | null;
}
export interface PalettePayment {
  id: string; amount: number; method: string | null; reference: string | null;
  received_at: string | null; customer_id: string | null;
  quote_id: string | null; invoice_id: string | null; receipt_voucher_no: string | null;
  /** R-1639: whose payment — its quote's customer, else its invoice's, else its own customer. */
  customer_name?: string | null;
}

/** Text ids safe inside a PostgREST `in.("…")` list (same rule as customerPaymentsOr). */
function quotedIds(ids: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ids.map((id) => (id ?? "").replace(/["\\]/g, "").trim()).filter(Boolean))].map((id) => `"${id}"`);
}

// ── The searches (pure over the client, so the request shape is unit-tested) ─────────

export async function searchPaletteCustomers(db: Client, query: string, tenantId?: string | null): Promise<PaletteCustomer[]> {
  const terms = paletteTerms(query);
  if (terms.length === 0) return [];
  const { data, error } = await applyTerms(
    db.from("customers").select(PALETTE_CUSTOMER_COLUMNS), PALETTE_CUSTOMER_SEARCH, terms, tenantId,
  ).order("name", { ascending: true }).limit(PALETTE_LIMIT);
  if (error) throw error;
  return (data ?? []) as unknown as PaletteCustomer[];
}

export async function searchPaletteQuotes(db: Client, query: string, tenantId?: string | null): Promise<PaletteQuote[]> {
  const terms = paletteTerms(query);
  if (terms.length === 0) return [];
  const { data, error } = await applyTerms(
    db.from("quotes").select(PALETTE_QUOTE_COLUMNS), PALETTE_QUOTE_SEARCH, terms, tenantId,
  ).order("created_at", { ascending: false }).limit(PALETTE_LIMIT);
  if (error) throw error;
  return (data ?? []) as unknown as PaletteQuote[];
}

export async function searchPaletteInvoices(db: Client, query: string, tenantId?: string | null): Promise<PaletteInvoice[]> {
  const terms = paletteTerms(query);
  if (terms.length === 0) return [];
  const { data, error } = await applyTerms(
    db.from("invoices").select(PALETTE_INVOICE_COLUMNS), PALETTE_INVOICE_SEARCH, terms, tenantId,
  ).order("created_at", { ascending: false }).limit(PALETTE_LIMIT);
  if (error) throw error;
  return (data ?? []) as unknown as PaletteInvoice[];
}

export async function searchPaletteSubscriptions(db: Client, query: string, tenantId?: string | null) {
  const terms = paletteTerms(query);
  if (terms.length === 0) return [];
  const { data, error } = await applyTerms(
    db.from("subscriptions").select(PALETTE_SUBSCRIPTION_COLUMNS), PALETTE_SUBSCRIPTION_SEARCH, terms, tenantId,
  ).order("customer_name", { ascending: true }).limit(PALETTE_LIMIT);
  if (error) throw error;
  return data ?? [];
}

/** People from the contact book (imported / added). Lead and company people are found
 *  through the Leads and Companies groups, which search their contact fields. */
export async function searchPaletteContacts(db: Client, query: string, tenantId?: string | null): Promise<PaletteContact[]> {
  const terms = paletteTerms(query);
  if (terms.length === 0) return [];
  const { data, error } = await applyTerms(
    db.from("contacts").select(PALETTE_CONTACT_COLUMNS).neq("source", "enquiry"), PALETTE_CONTACT_SEARCH, terms, tenantId,
  ).order("full_name", { ascending: true }).limit(PALETTE_LIMIT);
  if (error) throw error;
  return (data ?? []) as unknown as PaletteContact[];
}

/**
 * Payments have no customer name, so they match by reference, receipt voucher no. (R-1639),
 * the quote / imported invoice they are on, the amount (digits typed), a company the
 * Companies search found (`customerIds`), or a GST invoice the Invoices search found
 * (`invoiceHits` — through the invoice's quote, or the invoice itself for an imported one).
 */
export async function searchPalettePayments(
  db: Client, query: string, customerIds: readonly string[], tenantId?: string | null,
  invoiceHits: readonly { id: string; quote_id?: string | null }[] = [],
): Promise<PalettePayment[]> {
  const terms = paletteTerms(query);
  if (terms.length === 0) return [];
  const whole = terms.join(" ");
  const parts = [ilikeAny(PALETTE_PAYMENT_SEARCH, whole)];
  const digits = whole.replace(/[,\s]/g, "");
  if (/^\d{1,12}(\.\d{1,2})?$/.test(digits)) parts.push(`amount.eq.${digits}`);
  const ids = [...new Set(customerIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length > 0) parts.push(`customer_id.in.(${ids.join(",")})`);
  const viaQuote = quotedIds(invoiceHits.map((i) => i.quote_id));
  if (viaQuote.length > 0) parts.push(`quote_id.in.(${viaQuote.join(",")})`);
  const viaInvoice = quotedIds(invoiceHits.map((i) => i.id));
  if (viaInvoice.length > 0) parts.push(`invoice_id.in.(${viaInvoice.join(",")})`);
  let q = db.from("payments").select(PALETTE_PAYMENT_COLUMNS);
  if (tenantId) q = q.eq("tenant_id", tenantId);
  const { data, error } = await q.or(parts.join(",")).order("received_at", { ascending: false }).limit(PALETTE_LIMIT);
  if (error) throw error;
  return await namePalettePayments(db, (data ?? []) as unknown as PalettePayment[], tenantId);
}

/**
 * R-1639: a payment found by its receipt number matched no company, so the palette had no
 * name for it ("Payment"). Name it the way /payments does (payment-customer.ts): the quote's
 * customer, else the imported invoice's, else the payment's own customer. At most three
 * small reads of the ≤ PALETTE_LIMIT ids found, and none when nothing was found.
 */
async function namePalettePayments(db: Client, rows: PalettePayment[], tenantId?: string | null): Promise<PalettePayment[]> {
  if (rows.length === 0) return rows;
  const lookup = async (table: "quotes" | "invoices" | "customers", col: "customer_name" | "name", ids: (string | null)[]) => {
    const want = [...new Set(ids.filter((id): id is string => !!id))];
    const out = new Map<string, string>();
    if (want.length === 0) return out;
    let q = db.from(table).select(`id, ${col}`);
    if (tenantId) q = q.eq("tenant_id", tenantId);
    const { data } = await q.in("id", want);
    for (const r of (data ?? []) as unknown as Record<string, string | null>[]) {
      const name = r[col]?.trim();
      if (r.id && name) out.set(r.id, name);
    }
    return out;
  };
  const [byQuote, byInvoice, byCustomer] = await Promise.all([
    lookup("quotes", "customer_name", rows.map((r) => r.quote_id)),
    lookup("invoices", "customer_name", rows.map((r) => (r.quote_id ? null : r.invoice_id))),
    lookup("customers", "name", rows.map((r) => r.customer_id)),
  ]);
  return rows.map((r) => ({
    ...r,
    customer_name: (r.quote_id && byQuote.get(r.quote_id))
      || (r.invoice_id && byInvoice.get(r.invoice_id))
      || (r.customer_id && byCustomer.get(r.customer_id))
      || null,
  }));
}

// ── Hooks ──────────────────────────────────────────────────────────────────────────────

/**
 * R-1121: quotes ("deals") matching a typed query, for a picker — the task "Related to" box
 * used to read the whole quotes table to offer eight. Nothing typed → nothing read.
 */
export function useQuotePickerSearch(query: string, enabled: boolean, tenantId?: string | null) {
  const q = query.trim();
  return useQuery({
    queryKey: ["palette", "quotes", tenantId ?? null, q],
    enabled: enabled && q.length > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: () => searchPaletteQuotes(createClient(), q, tenantId ?? null),
  });
}

/** One quote's picker label ("Acme · Q-…") by id — for a task that already links a deal. */
export function useQuoteLabel(id: string | null | undefined) {
  return useQuery({
    queryKey: ["palette", "quote-label", id],
    enabled: !!id,
    staleTime: 60_000,
    queryFn: async (): Promise<PaletteQuote | null> => {
      const { data, error } = await createClient().from("quotes").select(PALETTE_QUOTE_COLUMNS).eq("id", id!).maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as PaletteQuote | null;
    },
  });
}

export interface PaletteGroupsOn {
  companies: boolean; quotes: boolean; invoices: boolean; subscriptions: boolean;
  payments: boolean; contacts: boolean;
}

/**
 * Every group's search for one (already debounced) query. Off while the palette is closed,
 * while nothing is typed, and for a group this role may not open. `fetching` is true while
 * any group is still answering — the palette shows "Searching…" then, never "No results".
 */
export function usePaletteSearch(query: string, open: boolean, on: PaletteGroupsOn, tenantId?: string | null) {
  const q = query.trim();
  const live = open && q.length > 0;
  const base = { staleTime: 30_000, placeholderData: keepPreviousData } as const;
  const tid = tenantId ?? null;

  const customers = useQuery({ ...base, queryKey: ["palette", "customers", tid, q], enabled: live && (on.companies || on.payments),
    queryFn: () => searchPaletteCustomers(createClient(), q, tid) });
  const quotes = useQuery({ ...base, queryKey: ["palette", "quotes", tid, q], enabled: live && on.quotes,
    queryFn: () => searchPaletteQuotes(createClient(), q, tid) });
  /* Also for payments (R-1639): an invoice number typed finds that invoice's payments. */
  const invoices = useQuery({ ...base, queryKey: ["palette", "invoices", tid, q], enabled: live && (on.invoices || on.payments),
    queryFn: () => searchPaletteInvoices(createClient(), q, tid) });
  const subscriptions = useQuery({ ...base, queryKey: ["palette", "subscriptions", tid, q], enabled: live && on.subscriptions,
    queryFn: () => searchPaletteSubscriptions(createClient(), q, tid) });
  const contacts = useQuery({ ...base, queryKey: ["palette", "contacts", tid, q], enabled: live && on.contacts,
    queryFn: () => searchPaletteContacts(createClient(), q, tid) });
  const customerIds = live && !customers.isPlaceholderData ? (customers.data ?? []).map((c) => c.id) : [];
  const invoiceHits = live && !invoices.isPlaceholderData ? (invoices.data ?? []) : [];
  const invoiceKey = invoiceHits.map((i) => i.id).join(",");
  const payments = useQuery({ ...base, queryKey: ["palette", "payments", tid, q, customerIds.join(","), invoiceKey],
    enabled: live && on.payments && !customers.isFetching && !invoices.isFetching,
    queryFn: () => searchPalettePayments(createClient(), q, customerIds, tid, invoiceHits) });

  const all = [customers, quotes, invoices, subscriptions, contacts, payments];
  return {
    customers: live ? customers.data ?? [] : [],
    quotes: live ? quotes.data ?? [] : [],
    invoices: live ? invoices.data ?? [] : [],
    subscriptions: live ? subscriptions.data ?? [] : [],
    contacts: live ? contacts.data ?? [] : [],
    payments: live ? payments.data ?? [] : [],
    fetching: live && all.some((r) => r.isFetching),
  };
}
