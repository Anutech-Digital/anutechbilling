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
 *                          or embedded (customers(...), customer_id(...)), through maskContact().
 *   stripMaskedContactWrites — the request: a masked value in an insert / update body is
 *                          dropped, so editing a lead's name never saves "••••3210" as its phone.
 *   Owner and manager are never masked (the matrix gives them the permission).
 *
 * ══ WHAT IT DOES NOT COVER (said on the card) ═══════════════════════════════════════════════
 *   RPC results other than RPC_CONTACT_KEYS (list_leads), server-rendered pages and API routes
 *   that return contacts, and other tables holding a phone (whatsapp_messages, inbound_emails)
 *   — those are separate paths.
 *   A filter on a contact column (?contact_phone=eq.…) still matches on the real value.
 */
import { can, isMaskedContact, maskContact } from "@/lib/auth/roles";
import { parseSelect, type SelectItem } from "./parse";
import { embedTarget, type EmbedCatalog } from "./gateway-limits";

export { isMaskedContact };

/** Table → its columns that hold a person's phone / email. */
export const CONTACT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  leads: ["contact_email", "contact_phone"],
  customers: ["contact_email", "contact_phone", "contact_mobile"],
  contacts: ["email", "phone", "whatsapp"],
};

/**
 * RPCs the browser calls that hand back lead / customer rows with their contact columns. Their
 * whole JSON result is walked and these keys masked wherever they appear. list_leads is the
 * Leads page itself ({ rows: [to_jsonb(lead)…], next_cursor }). Checked 23 Oct 2026 against
 * every browser .rpc() whose SQL mentions a phone / email: the rest return none of these
 * (find_lead_duplicates, customers_name_only) or another table's phone (today_inbox,
 * list_whatsapp_threads → whatsapp_messages — listed as not covered on the card).
 */
export const RPC_CONTACT_KEYS: Readonly<Record<string, readonly string[]>> = {
  list_leads: CONTACT_COLUMNS.leads,
};

/** True when this role must get masked contacts. Unknown / missing role → masked (fail closed). */
export function mustMaskContacts(role: string | null | undefined): boolean {
  return !can(role, "can_view_contact_details");
}

function maskOne(v: unknown): unknown {
  if (typeof v !== "string" || !v.trim() || isMaskedContact(v)) return v;
  return maskContact(v);
}

type EmbedItem = Extract<SelectItem, { kind: "embed" }>;

function maskRows(table: string, items: SelectItem[], body: unknown, cat?: EmbedCatalog): boolean {
  if (body === null || typeof body !== "object") return false;
  const rows: unknown[] = Array.isArray(body) ? body : [body];
  const cols = CONTACT_COLUMNS[table];
  const star = items.some((i) => i.kind === "star");
  /* Output key → masked? A star selects every column under its own name. */
  const keys = new Set<string>();
  if (cols) {
    if (star) cols.forEach((c) => keys.add(c));
    for (const i of items) if (i.kind === "column" && cols.includes(i.name)) keys.add(i.alias ?? i.name);
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
    for (const e of embeds) {
      const child = r[e.alias ?? e.relation];
      if (maskRows(embedTarget(table, e.relation, cat), e.items, child, cat)) changed = true;
    }
  }
  return changed;
}

function reaches(table: string, items: SelectItem[], cat?: EmbedCatalog): boolean {
  if (CONTACT_COLUMNS[table]) return true;
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

/** Does this request read a contact table — at the top, through an embed, or a listed RPC? */
export function touchesContactTables(path: string, search: URLSearchParams, cat?: EmbedCatalog): boolean {
  if (path.startsWith("rpc/")) return Boolean(RPC_CONTACT_KEYS[path.slice(4)]);
  try {
    return reaches(path, parseSelect(search.get("select")), cat);
  } catch {
    return Boolean(CONTACT_COLUMNS[path]);
  }
}

/**
 * The response body with every contact value masked. Same text back when nothing changed or
 * the body is not JSON.
 */
export function maskContactsInBody(path: string, search: URLSearchParams, text: string, cat?: EmbedCatalog): string {
  if (path.startsWith("rpc/")) {
    const keys = RPC_CONTACT_KEYS[path.slice(4)];
    if (!keys) return text;
    try {
      const body: unknown = JSON.parse(text);
      return maskDeep(body, keys) ? JSON.stringify(body) : text;
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

/** An insert / update body without any masked contact value (so it cannot overwrite the real one). */
export function stripMaskedContactWrites(path: string, text: string | null): string | null {
  const cols = CONTACT_COLUMNS[path];
  if (!cols || !text) return text;
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
  }
  return changed ? JSON.stringify(body) : text;
}
