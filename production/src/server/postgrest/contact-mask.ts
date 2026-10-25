/**
 * R-1009 (23 Oct 2026, data-leak audit): role-based masking of a lead's / customer's / contact's
 * phone and email AT THE DATA GATEWAY (/api/sb/rest/v1), not only on screen.
 *
 * ══ WHY HERE ════════════════════════════════════════════════════════════════════════════════
 *   lib/auth/roles.ts has always said a role without can_view_contact_details (sales,
 *   accountant, partner agent) sees a masked phone / email — and that "a masked string in the
 *   DOM with the real one in the JSON payload is not masking". Every list and detail screen
 *   reads leads / customers / contacts through this gateway, so masking the RESPONSE here covers
 *   all of them at once, and the real value never reaches that browser.
 *
 * ══ WHAT ════════════════════════════════════════════════════════════════════════════════════
 *   maskContactsInBody   — the response: every CONTACT_COLUMNS value of those tables, top level
 *                          or embedded (customers(...), customer_id(...)), through maskContact();
 *                          every phone / email inside a CONTACT_JSON_COLUMNS jsonb list too (R-1820).
 *   stripMaskedContactWrites — the request: a masked value in an insert / update body is
 *                          dropped, so editing a lead's name never saves "••••3210" as its phone.
 *   maskedQueryRefusal   — R-1821: a filter, order or cast on a masked column is refused (400).
 *                          Masking the answer is not enough when the QUESTION can be about the
 *                          real value: ?contact_phone=like.*98765* or order=contact_phone told a
 *                          masked role the number digit by digit.
 *   Owner and manager are never masked (the matrix gives them the permission).
 *
 * ══ WHAT IT DOES NOT COVER (said on the card) ═══════════════════════════════════════════════
 *   RPC results other than RPC_CONTACT_KEYS (list_leads) and find_lead_duplicates' matched_on,
 *   server-rendered pages and API routes that return contacts, and other tables holding a phone
 *   (whatsapp_messages, inbound_emails) — those are separate paths. list_leads' / lead_counts'
 *   search still matches a typed WORD against the real email inside SQL (a phone-like or "@"
 *   search is refused here — R-1821); closing that fully needs a list_leads change.
 */
import { can, isMaskedContact, maskContact } from "@/lib/auth/roles";
import { parseQuery, parseSelect, type Filter, type SelectItem } from "./parse";
import { embedTarget, type EmbedCatalog } from "./gateway-limits";

export { isMaskedContact };

/** Table → its plain text columns that hold a person's phone / email (the reveal route opens only these). */
export const CONTACT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  leads: ["contact_email", "contact_phone"],
  customers: ["contact_email", "contact_phone", "contact_mobile"],
  contacts: ["email", "phone", "whatsapp"],
  /* R-1820: a parent account's own contact — read directly and as customers' embed. */
  customer_groups: ["contact_email", "contact_phone"],
  /* R-1850: a director's own email / phone in the directors register. */
  company_directors: ["email", "phone"],
};

/**
 * R-1820: table → its jsonb columns that hold a LIST of people's phones / emails. Every string
 * inside is masked except under JSON_PLAIN_KEYS (fail closed: a new key added to these items
 * later is masked until someone lists it as plain).
 *   contacts.emails / contacts.phones  — [{ value, label }]           (contact-form.tsx)
 *   customers.contact_persons          — [{ first_name, email, phone, mobile, designation, … }]
 */
export const CONTACT_JSON_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  contacts: ["emails", "phones"],
  customers: ["contact_persons"],
};

/** Keys inside a contact jsonb item that are NOT a phone or email — left readable. */
export const JSON_PLAIN_KEYS: ReadonlySet<string> = new Set([
  "label", "salutation", "first_name", "last_name", "name", "designation", "department", "title",
  "is_primary", "primary", "type", "kind", "id",
]);

/** Every column of `table` the masker hides: plain contact columns + contact jsonb lists. */
export function maskedColumns(table: string): readonly string[] {
  return [...(CONTACT_COLUMNS[table] ?? []), ...(CONTACT_JSON_COLUMNS[table] ?? [])];
}

/**
 * RPCs the browser calls that hand back lead / customer rows with their contact columns. Their
 * whole JSON result is walked and these keys masked wherever they appear. list_leads is the
 * Leads page itself ({ rows: [to_jsonb(lead)…], next_cursor }). Checked 23 Oct 2026 against
 * every browser .rpc() whose SQL mentions a phone / email: the rest return none of these
 * (customers_name_only) or another table's phone (today_inbox, list_whatsapp_threads →
 * whatsapp_messages — listed as not covered on the card). find_lead_duplicates: see
 * coarseDuplicates.
 */
export const RPC_CONTACT_KEYS: Readonly<Record<string, readonly string[]>> = {
  list_leads: CONTACT_COLUMNS.leads,
};

/**
 * R-1821: find_lead_duplicates(p_phone, p_email, …) says WHICH key matched (matched_on). For a
 * masked role every match reads "possible" — the Add-lead form still warns, but the answer no
 * longer confirms that a typed phone / email is this lead's.
 */
export const RPC_COARSE_MATCH = "find_lead_duplicates";

/** R-1821: RPCs whose p_filters.search matches the real phone / email inside SQL. */
export const RPC_CONTACT_SEARCH: ReadonlySet<string> = new Set(["list_leads", "lead_counts"]);

/** True when this role must get masked contacts. Unknown / missing role → masked (fail closed). */
export function mustMaskContacts(role: string | null | undefined): boolean {
  return !can(role, "can_view_contact_details");
}

function maskOne(v: unknown): unknown {
  /* A number: a cast (contact_phone::int8) or a phone stored in a jsonb list as a number. */
  if (typeof v === "number" && Number.isFinite(v)) return maskContact(String(v));
  if (typeof v !== "string" || !v.trim() || isMaskedContact(v)) return v;
  return maskContact(v);
}

/** A contact jsonb list with every phone / email masked. Returns the same reference when nothing changed. */
function maskJson(v: unknown, plainKey = false): unknown {
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const m = maskJson(x);
      if (m !== x) changed = true;
      return m;
    });
    return changed ? out : v;
  }
  if (v && typeof v === "object") {
    const r = v as Record<string, unknown>;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(r)) {
      const m = maskJson(x, JSON_PLAIN_KEYS.has(k));
      if (m !== x) changed = true;
      out[k] = m;
    }
    return changed ? out : v;
  }
  if (plainKey) return v;
  /* Booleans and null pass through; every string or number is a possible phone / email. */
  return typeof v === "string" || typeof v === "number" ? maskOne(v) : v;
}

/** Any masked value anywhere inside this (jsonb) value? */
function holdsMasked(v: unknown): boolean {
  if (typeof v === "string") return isMaskedContact(v);
  if (Array.isArray(v)) return v.some(holdsMasked);
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).some(holdsMasked);
  return false;
}

type EmbedItem = Extract<SelectItem, { kind: "embed" }>;

function maskRows(table: string, items: SelectItem[], body: unknown, cat?: EmbedCatalog): boolean {
  if (body === null || typeof body !== "object") return false;
  const rows: unknown[] = Array.isArray(body) ? body : [body];
  const cols = CONTACT_COLUMNS[table] ?? [];
  const jsonCols = CONTACT_JSON_COLUMNS[table] ?? [];
  const star = items.some((i) => i.kind === "star");
  /* Output key → masked? A star selects every column under its own name. */
  const keys = new Set<string>();
  const jsonKeys = new Set<string>();
  if (star) {
    cols.forEach((c) => keys.add(c));
    jsonCols.forEach((c) => jsonKeys.add(c));
  }
  for (const i of items) {
    if (i.kind !== "column") continue;
    if (cols.includes(i.name)) keys.add(i.alias ?? i.name);
    if (jsonCols.includes(i.name)) jsonKeys.add(i.alias ?? i.name);
  }
  const embeds = items.filter((i): i is EmbedItem => i.kind === "embed");
  let changed = false;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    for (const k of keys) {
      if (!(k in r)) continue;
      const m = maskOne(r[k]);
      if (m !== r[k]) { r[k] = m; changed = true; }
    }
    for (const k of jsonKeys) {
      if (!(k in r)) continue;
      /* A jsonb column cast to text (::text) arrives as a string — masked whole. */
      const m = typeof r[k] === "string" ? maskOne(r[k]) : maskJson(r[k]);
      if (m !== r[k]) { r[k] = m; changed = true; }
    }
    for (const e of embeds) {
      const child = r[e.alias ?? e.relation];
      if (maskRows(embedTarget(table, e.relation, cat), e.items, child, cat)) changed = true;
    }
  }
  return changed;
}

function reaches(table: string, items: SelectItem[], cat?: EmbedCatalog): boolean {
  if (maskedColumns(table).length > 0) return true;
  return items.some((i) => i.kind === "embed" && reaches(embedTarget(table, i.relation, cat), i.items, cat));
}

/** Every `keys` value anywhere in this JSON, masked in place. */
function maskDeep(node: unknown, keys: readonly string[]): boolean {
  if (!node || typeof node !== "object") return false;
  let changed = false;
  if (Array.isArray(node)) {
    for (const x of node) if (maskDeep(x, keys)) changed = true;
    return changed;
  }
  const r = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(r)) {
    if (keys.includes(k)) {
      const m = maskOne(v);
      if (m !== v) { r[k] = m; changed = true; }
    } else if (v && typeof v === "object" && maskDeep(v, keys)) {
      changed = true;
    }
  }
  return changed;
}

/** find_lead_duplicates rows with matched_on made coarse ("possible"). */
function coarseDuplicates(body: unknown): boolean {
  if (!Array.isArray(body)) return false;
  let changed = false;
  for (const row of body) {
    if (!row || typeof row !== "object" || !("matched_on" in row)) continue;
    (row as Record<string, unknown>).matched_on = ["possible"];
    changed = true;
  }
  return changed;
}

/** Does this request read a contact table — at the top, through an embed, or a listed RPC? */
export function touchesContactTables(path: string, search: URLSearchParams, cat?: EmbedCatalog): boolean {
  if (path.startsWith("rpc/")) {
    const name = path.slice(4);
    return Boolean(RPC_CONTACT_KEYS[name]) || name === RPC_COARSE_MATCH;
  }
  try {
    return reaches(path, parseSelect(search.get("select")), cat);
  } catch {
    return maskedColumns(path).length > 0;
  }
}

/**
 * The response body with every contact value masked. Same text back when nothing changed or
 * the body is not JSON.
 */
export function maskContactsInBody(path: string, search: URLSearchParams, text: string, cat?: EmbedCatalog): string {
  if (path.startsWith("rpc/")) {
    const name = path.slice(4);
    const keys = RPC_CONTACT_KEYS[name];
    if (!keys && name !== RPC_COARSE_MATCH) return text;
    try {
      const body: unknown = JSON.parse(text);
      const changed = keys ? maskDeep(body, keys) : coarseDuplicates(body);
      return changed ? JSON.stringify(body) : text;
    } catch {
      return text;
    }
  }
  let body: unknown;
  let items: SelectItem[];
  try {
    body = JSON.parse(text);
    items = parseSelect(search.get("select"));
  } catch {
    return text;
  }
  return maskRows(path, items, body, cat) ? JSON.stringify(body) : text;
}

/**
 * An insert / update body without any masked contact value (so it cannot overwrite the real
 * one). A jsonb contact list holding ANY masked value is dropped whole — the real list cannot
 * be rebuilt from a masked copy, and keeping the real one beats saving "••••3210" into it.
 */
export function stripMaskedContactWrites(path: string, text: string | null): string | null {
  const cols = CONTACT_COLUMNS[path] ?? [];
  const jsonCols = CONTACT_JSON_COLUMNS[path] ?? [];
  if ((cols.length === 0 && jsonCols.length === 0) || !text) return text;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }
  const rows: unknown[] = Array.isArray(body) ? body : [body];
  let changed = false;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    for (const c of cols) {
      if (typeof r[c] === "string" && isMaskedContact(r[c] as string)) { delete r[c]; changed = true; }
    }
    for (const c of jsonCols) {
      if (c in r && holdsMasked(r[c])) { delete r[c]; changed = true; }
    }
  }
  return changed ? JSON.stringify(body) : text;
}

// ── R-1821: no question about a masked value ──────────────────────────────────────────────

/** The message a masked role gets for a filter / order / cast on a contact column. */
export function maskedQueryMessage(table: string, column: string, how: "filter" | "sort" | "cast" | "search"): string {
  const what = how === "sort" ? "sort by" : how === "cast" ? "convert" : how === "search" ? "search by" : "filter by";
  return `Your role cannot ${what} a phone number or email (${table}.${column}) — they are hidden for your role. ` +
    "Search by name or company instead, or ask the owner or a manager.";
}

/** Embed path ("", "customer", "customer.group") → the table it reads, from the select tree. */
function scopeTables(table: string, items: SelectItem[], prefix: string, out: Map<string, string>, cat?: EmbedCatalog): void {
  out.set(prefix, table);
  for (const i of items) {
    if (i.kind !== "embed") continue;
    const t = embedTarget(table, i.relation, cat);
    for (const name of [i.alias, i.relation]) {
      if (!name) continue;
      scopeTables(t, i.items, prefix ? `${prefix}.${name}` : name, out, cat);
    }
  }
}

function castOnMasked(table: string, items: SelectItem[], cat?: EmbedCatalog): string | null {
  const masked = maskedColumns(table);
  for (const i of items) {
    if (i.kind === "column" && i.cast !== undefined && masked.includes(i.name)) return maskedQueryMessage(table, i.name, "cast");
    if (i.kind === "embed") {
      const hit = castOnMasked(embedTarget(table, i.relation, cat), i.items, cat);
      if (hit) return hit;
    }
  }
  return null;
}

/** Columns a filter asks about. `is.null` / `not.is.null` only asks "is there one?" — which the
 *  masked value ("—" or "••••3210") already answers — so it stays allowed ("has an email"). */
function filterColumns(f: Filter, out: string[]): string[] {
  if (f.kind === "cond") { if (f.op !== "is") out.push(f.column); }
  else for (const x of f.items) filterColumns(x, out);
  return out;
}

const PHONE_LIKE = /^[+0-9][0-9 ()+-]*$/;

/** A list_leads / lead_counts search text that would match a phone or an email inside SQL. */
export function isContactSearch(search: unknown): boolean {
  if (typeof search !== "string") return false;
  const s = search.trim();
  if (s.includes("@")) return true;
  return PHONE_LIKE.test(s) && s.replace(/\D/g, "").length >= 5;
}

function rpcSearchOf(search: URLSearchParams, body: string | null): unknown {
  let filters: unknown = search.get("p_filters");
  if (body) {
    try {
      const b = JSON.parse(body) as Record<string, unknown> | null;
      if (b && typeof b === "object" && "p_filters" in b) filters = b.p_filters;
    } catch { /* not JSON — the handler answers it */ }
  }
  if (typeof filters === "string") {
    try { filters = JSON.parse(filters); } catch { return undefined; }
  }
  return filters && typeof filters === "object" ? (filters as Record<string, unknown>).search : undefined;
}

/**
 * R-1821: for a role that gets masked contacts — the reason this request is refused (400), or
 * null. Refused: any filter except is.null (top level, embedded, inside or= / and=), order term or cast on a
 * masked column, at any embed depth and for every method (a PATCH / DELETE filter or a HEAD
 * count answers the same question); a list_leads / lead_counts search that looks like a phone
 * number or an email.
 */
export function maskedQueryRefusal(path: string, search: URLSearchParams, body: string | null, cat?: EmbedCatalog): string | null {
  if (path.startsWith("rpc/")) {
    const name = path.slice(4);
    if (RPC_CONTACT_SEARCH.has(name) && isContactSearch(rpcSearchOf(search, body))) {
      return maskedQueryMessage("leads", "contact_phone / contact_email", "search");
    }
    return null;
  }
  let pq: ReturnType<typeof parseQuery>;
  try {
    pq = parseQuery(search);
  } catch {
    return null; // the handler refuses a query it cannot parse
  }
  const cast = castOnMasked(path, pq.select, cat);
  if (cast) return cast;
  const tables = new Map<string, string>();
  scopeTables(path, pq.select, "", tables, cat);
  for (const [scopePath, scope] of pq.scopes) {
    /* An embed path the select does not name: resolve it link by link (the handler refuses it
       anyway, but never let it through on a guess). */
    const table = tables.get(scopePath)
      ?? scopePath.split(".").reduce((t, rel) => embedTarget(t, rel, cat), path);
    const masked = maskedColumns(table);
    if (masked.length === 0) continue;
    for (const f of scope.filters) {
      const hit = filterColumns(f, []).find((c) => masked.includes(c));
      if (hit) return maskedQueryMessage(table, hit, "filter");
    }
    const sorted = scope.order.find((o) => masked.includes(o.column));
    if (sorted) return maskedQueryMessage(table, sorted.column, "sort");
  }
  return null;
}
