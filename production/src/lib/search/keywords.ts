/**
 * Hidden search terms for the command palette.
 *
 * THE PROBLEM. The palette matches on what each row DISPLAYS. So a customer row
 * showed name + contact + email + domain and was findable by those — but not by
 * GSTIN or phone. A lead row showed company + plan + value + stage, so it could
 * not be found by the contact's name, their phone, or their email at all.
 *
 * That misses the two most common real lookups in a reseller's day:
 *
 *   • the phone rings and you type the number
 *   • someone says "this is Rohit from…" and you type Rohit
 *
 * Neither worked for leads. `keywords` (cmdk 1.1+) fixes it without cluttering
 * the row: the terms are matched but never rendered.
 *
 * WHY NOT JUST PUT EVERYTHING IN THE VISIBLE META. Because the row becomes
 * unreadable, and because scoring degrades — cmdk ranks by how well the query
 * matches, so padding every row with the same kinds of noise flattens the
 * ranking and the right answer stops coming first.
 *
 * WHY NOT A SERVER SEARCH ENDPOINT. At this size it would be slower. The whole
 * working set is a few hundred rows already held in the TanStack Query cache, so
 * matching happens in memory in well under a millisecond. A round trip to
 * Supabase from India measured 70–118ms in this same session — every keystroke
 * would cost more than the entire budget a "sub-50ms" search has. Trigram
 * indexes and /api/search start earning their keep when the data outgrows what
 * you would ship to a browser; they are a pessimisation before that.
 */

/** Digits only, so "+91 99999 30300" is found by "9999930300" or "30300". */
export function phoneDigits(phone: string | null | undefined): string[] {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 4) return [];
  const out = [digits];
  // Indian mobiles are ten digits and are stored with and without +91. Indexing
  // the last ten lets a number typed either way match a number stored either way.
  if (digits.length > 10) out.push(digits.slice(-10));
  return out;
}

/** Drop empties and duplicates, and normalise case — cmdk matches case-insensitively. */
function clean(terms: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const t of terms) {
    const v = t?.toString().trim().toLowerCase();
    if (v) seen.add(v);
  }
  return [...seen];
}

export interface CustomerLike {
  id?: string | null;
  name?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  gstin?: string | null;
  domain?: string | null;
}

/** Terms that identify a customer: who they are, how you reach them, their tax id. */
export function customerKeywords(c: CustomerLike): string[] {
  return clean([
    c.name, c.contact_name, c.contact_email, c.domain, c.gstin, c.id,
    ...phoneDigits(c.contact_phone),
    // GSTIN state code alone ("27") is too short to be a useful term and would
    // match half the table, so it is deliberately not indexed.
  ]);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * R-821 (10 Oct 2026): the grey line under a company in Ctrl+K. It fell back to the row's
 * UUID when the company had no contact or domain. Now: the domain, else city/state, else
 * the main contact's name, else nothing — never an id.
 */
export function companyPaletteMeta(c: CustomerLike & { city?: string | null; state?: string | null }): string {
  const t = (v: string | null | undefined) => {
    const s = (v ?? "").trim();
    return s && !UUID_RE.test(s) ? s : "";
  };
  const place = [t(c.city), t(c.state)].filter(Boolean).join(", ");
  return t(c.domain) || place || t(c.contact_name);
}

export interface LeadLike {
  id?: string | null;
  company?: string | null;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  domain?: string | null;
  plan?: string | null;
}

/**
 * Terms that identify a lead.
 *
 * The contact fields matter more here than anywhere else: a lead often has no
 * customer record yet, so the person's name and number are the only handles the
 * operator has when the phone rings.
 */
export function leadKeywords(l: LeadLike): string[] {
  return clean([
    l.company, l.contact_name, l.email, l.domain, l.plan, l.id,
    ...phoneDigits(l.phone),
  ]);
}

export interface QuoteLike {
  id?: string | null;
  customer_name?: string | null;
  plan?: string | null;
  amount?: number | null;
}

/** A quote is usually hunted by its number or by who it is for. */
export function quoteKeywords(q: QuoteLike): string[] {
  return clean([
    q.id, q.customer_name, q.plan,
    // The bare numeric tail of "Q-ET-2026-27-0042" — operators quote "42" or
    // "0042" over the phone far more often than the whole prefixed id.
    q.id ? String(q.id).replace(/^\D+/, "").replace(/-/g, "") : null,
    q.id ? String(q.id).split("-").pop() : null,
  ]);
}

export interface InvoiceLike {
  id?: string | null;
  customer_name?: string | null;
  amount?: number | null;
  status?: string | null;
}

export function invoiceKeywords(i: InvoiceLike): string[] {
  return clean([
    i.id, i.customer_name, i.status,
    i.id ? String(i.id).split("-").pop() : null,
  ]);
}

export interface SubscriptionLike {
  id?: string | null;
  customer_name?: string | null;
  plan?: string | null;
  vendor?: string | null;
  status?: string | null;
}

export function subscriptionKeywords(s: SubscriptionLike): string[] {
  return clean([s.customer_name, s.plan, s.vendor, s.status, s.id]);
}

export interface ContactLike {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  designation?: string | null;
}

export function contactKeywords(c: ContactLike): string[] {
  return clean([
    c.name, c.email, c.company, c.designation, c.id,
    ...phoneDigits(c.phone),
  ]);
}

/**
 * Does every word typed appear somewhere in these fields? (2 Oct 2026)
 *
 * The palette used cmdk's fuzzy scoring, which matches letters in order with gaps —
 * "Muskaan" found "Sachin KUmar TAkSh … solutions" (m-u-s-k-a-a-n spread across the
 * line) and listed it beside the real match. People search for a name or a number;
 * each word they type must be in the row as typed. Digits also match a number written
 * with spaces or dashes ("98765 43210" ↔ "+919876543210").
 */
export function matchesAllTerms(fields: (string | number | null | undefined)[], query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.filter((f) => f !== null && f !== undefined && f !== "").join(" \u0001 ").toLowerCase();
  const hayDigits = hay.replace(/\D/g, "");
  return words.every((w) => {
    if (hay.includes(w)) return true;
    const d = w.replace(/\D/g, "");
    return d.length >= 4 && d.length === w.replace(/[\s+\-()]/g, "").length && hayDigits.includes(d);
  });
}
