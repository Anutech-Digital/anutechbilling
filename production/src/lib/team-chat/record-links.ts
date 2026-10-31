/**
 * R-2302 (G-TEAMCHAT TC-09) — app record links in team chat.
 *
 * A message links an app record by {type, id} ONLY (chat_links_ok, R-2294): never an amount or
 * a name. The preview a reader sees is fetched under the READER's own access:
 *   1. the reader's role must be able to open the record's page — the SAME rule as the menu,
 *      the route guard and Ctrl+K (nav.ts isRouteAllowed with ROUTE_DENY, via paletteMayOpen;
 *      fails closed while the role is unknown). If not: "Invoice — you don't have access" and
 *      NO database read, so no amount can ever arrive;
 *   2. then the row is read with the reader's own session, so RLS decides — a hidden row reads
 *      as "not found or you don't have access".
 *
 * Pure parsing + one small read per preview — no React here (the slot is
 * components/features/team-chat/slots/links.tsx).
 */
import type { ChatLink } from "./types";
import { paletteMayOpen } from "@/components/layout/palette-access";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { subscriptionOpenHref } from "@/app/(app)/subscriptions/open-link";
import { paymentHref, subscriptionStatusLabel } from "@/app/(app)/subscriptions/palette-links";
import { paymentMethodLabel } from "@/lib/payments/method-label";
import { quoteStateLabel } from "@/lib/quotes/state-labels";

export const RECORD_LINK_TYPES = ["quote", "invoice", "customer", "subscription", "lead", "payment"] as const;
export type RecordLinkType = (typeof RECORD_LINK_TYPES)[number];

/** chat_links_ok: at most 20 links, id 1–64 chars. */
export const MAX_CHAT_LINKS = 20;
const MAX_ID = 64;

export const RECORD_LABEL: Record<RecordLinkType, string> = {
  quote: "Quote",
  invoice: "Invoice",
  customer: "Customer",
  subscription: "Subscription",
  lead: "Lead",
  payment: "Payment",
};

/** The page a link to this type opens — what the viewer's role must be allowed (palette-access). */
const RECORD_PAGE: Record<RecordLinkType, string> = {
  quote: "/quotes/x",
  invoice: "/invoices/x",
  customer: "/customers/x",
  subscription: "/subscriptions",
  lead: "/leads",
  payment: "/payments",
};

/** First path segment → type. */
const SEGMENT_TYPE: Record<string, RecordLinkType> = {
  quotes: "quote",
  invoices: "invoice",
  customers: "customer",
  subscriptions: "subscription",
  leads: "lead",
  payments: "payment",
};

/** Second segments that are pages, not record ids. */
const NOT_AN_ID = new Set(["new", "groups", "import", "export"]);

/** Query params the app itself uses to open one record on a list page. */
const OPEN_PARAM: Partial<Record<RecordLinkType, string>> = {
  subscription: "open",
  lead: "lead",
  invoice: "open", // legacy /invoices?open=<id> (invoice-href.ts)
};

export type ParsedChatLink =
  | { kind: "record"; link: ChatLink & { type: RecordLinkType } }
  | { kind: "external"; href: string };

const isRecordType = (t: unknown): t is RecordLinkType =>
  typeof t === "string" && (RECORD_LINK_TYPES as readonly string[]).includes(t);

function cleanId(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  id = id.trim();
  if (id.length < 1 || id.length > MAX_ID) return null;
  if (/[\s\u0000-\u001f<>"'`\\]/.test(id)) return null;
  return id;
}

function recordFromUrl(u: URL): ParsedChatLink | null {
  const segs = u.pathname.split("/").filter((s, i) => i > 0);
  const type = SEGMENT_TYPE[segs[0] ?? ""];
  if (!type) return null;
  const second = segs[1] ?? "";
  if (second && !NOT_AN_ID.has(second.toLowerCase())) {
    const id = cleanId(second);
    return id ? { kind: "record", link: { type, id } } : null;
  }
  if (second) return null;
  const param = OPEN_PARAM[type];
  const id = param ? cleanId(u.searchParams.get(param)) : null;
  return id ? { kind: "record", link: { type, id } } : null;
}

/**
 * One link as typed or pasted: an app path ("/quotes/Q-1") or a full address of THIS app
 * (`appOrigin`) → a record; any other http(s) address → external; anything else → null.
 */
export function parseChatLink(raw: string, appOrigin?: string | null): ParsedChatLink | null {
  const s = (raw ?? "").trim();
  if (!s || s.length > 2000) return null;
  if (s.startsWith("/")) {
    if (s.startsWith("//") || s.includes("\\") || !/^\/[a-z]/i.test(s)) return null;
    let u: URL;
    try {
      u = new URL(s, "http://app.invalid");
    } catch {
      return null;
    }
    return recordFromUrl(u);
  }
  if (!/^https?:\/\//i.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (appOrigin && u.origin === appOrigin) {
    return recordFromUrl(u) ?? { kind: "external", href: s };
  }
  return { kind: "external", href: s };
}

const TOKEN = /(^|[\s([{"'])((?:https?:\/\/|\/)[^\s<>"'`]+)/gi;
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** Every record a message's text links, each once, in order — at most 20. */
export function recordLinksInText(text: string, appOrigin?: string | null): ChatLink[] {
  const out: ChatLink[] = [];
  const seen = new Set<string>();
  for (const m of (text ?? "").matchAll(TOKEN)) {
    const token = m[2].replace(TRAILING, "");
    const parsed = parseChatLink(token, appOrigin);
    if (parsed?.kind !== "record") continue;
    const key = chatLinkKey(parsed.link);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: parsed.link.type, id: parsed.link.id });
    if (out.length >= MAX_CHAT_LINKS) break;
  }
  return out;
}

export const chatLinkKey = (l: ChatLink) => `${l.type}:${l.id}`;

/** A message's stored links, read defensively: known types, valid ids, {type,id} keys only. */
export function sanitizeChatLinks(links: unknown): (ChatLink & { type: RecordLinkType })[] {
  if (!Array.isArray(links)) return [];
  const out: (ChatLink & { type: RecordLinkType })[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    if (!l || typeof l !== "object") continue;
    const { type, id } = l as { type?: unknown; id?: unknown };
    if (!isRecordType(type) || typeof id !== "string") continue;
    const clean = id.length >= 1 && id.length <= MAX_ID ? id : null;
    if (!clean) continue;
    const link = { type, id: clean };
    if (seen.has(chatLinkKey(link))) continue;
    seen.add(chatLinkKey(link));
    out.push(link);
    if (out.length >= MAX_CHAT_LINKS) break;
  }
  return out;
}

/** The address that opens this record (a payment has no page of its own: the receipts list). */
export function recordHref(link: ChatLink, extra: { customerId?: string | null; domain?: string | null; customerName?: string | null } = {}): string {
  const enc = encodeURIComponent(link.id);
  switch (link.type) {
    case "quote": return `/quotes/${enc}`;
    case "invoice": return invoiceHref(link.id);
    case "customer": return `/customers/${enc}`;
    case "subscription": return subscriptionOpenHref({ id: link.id, domain: extra.domain, customer_name: extra.customerName });
    case "lead": return `/leads?lead=${enc}`;
    case "payment": return paymentHref({ customer_id: extra.customerId ?? null });
    default: return "/";
  }
}

/** May this role open the record's page? Unknown / loading role → false (fail closed). */
export function viewerMayOpen(role: string | null | undefined, type: RecordLinkType): boolean {
  return paletteMayOpen(role, RECORD_PAGE[type]);
}

// ── Preview ──────────────────────────────────────────────────────────────────────────

export type RecordPreview =
  | {
      state: "ok"; type: RecordLinkType; id: string; label: string;
      title: string; subtitle: string | null; amount: number | null; status: string | null; href: string;
    }
  | { state: "no_access" | "not_found" | "error"; type: RecordLinkType; id: string; label: string; message: string };

/** The few read methods a preview uses — the browser client, or a test double. */
interface PreviewQuery {
  eq(column: string, value: string): PreviewQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}
export interface PreviewDb {
  from(table: string): { select(columns: string): PreviewQuery };
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const words = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const w = s.replace(/[_-]+/g, " ").toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/** The /quotes word for a state (state-labels.ts); an unknown one in plain words. */
const quoteStatus = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const known = quoteStateLabel(s);
  return known !== s ? known : words(s);
};

interface PreviewSpec {
  table: string;
  /** Only what the preview shows — never more. */
  columns: string;
  shape: (r: Row, link: ChatLink) => { title: string; subtitle: string | null; amount: number | null; status: string | null; href: string };
}

const SPEC: Record<RecordLinkType, PreviewSpec> = {
  quote: {
    table: "quotes",
    columns: "id, customer_name, amount, status",
    shape: (r, l) => ({
      title: `Quote ${l.id}`, subtitle: str(r.customer_name), amount: num(r.amount),
      status: quoteStatus(r.status),
      href: recordHref(l),
    }),
  },
  invoice: {
    table: "invoices",
    columns: "id, customer_name, amount, status",
    shape: (r, l) => ({ title: `Invoice ${l.id}`, subtitle: str(r.customer_name), amount: num(r.amount), status: words(r.status), href: recordHref(l) }),
  },
  customer: {
    table: "customers",
    columns: "id, name, display_name, city",
    shape: (r, l) => ({ title: str(r.display_name) ?? str(r.name) ?? `Customer ${l.id}`, subtitle: str(r.city), amount: null, status: null, href: recordHref(l) }),
  },
  subscription: {
    table: "subscriptions",
    columns: "id, customer_name, plan, status, domain",
    shape: (r, l) => ({
      title: str(r.plan) ? `Subscription · ${str(r.plan)}` : "Subscription",
      subtitle: [str(r.customer_name), str(r.domain)].filter(Boolean).join(" · ") || null,
      amount: null, status: str(r.status) ? subscriptionStatusLabel(str(r.status)) : null,
      href: recordHref(l, { domain: str(r.domain), customerName: str(r.customer_name) }),
    }),
  },
  lead: {
    table: "leads",
    columns: "id, company, contact_name, stage",
    shape: (r, l) => ({ title: `Lead · ${str(r.company) ?? str(r.contact_name) ?? l.id}`, subtitle: str(r.company) ? str(r.contact_name) : null, amount: null, status: words(r.stage), href: recordHref(l) }),
  },
  payment: {
    table: "payments",
    columns: "id, amount, method, receipt_voucher_no, customer_id",
    shape: (r, l) => ({
      title: str(r.receipt_voucher_no) ? `Payment ${str(r.receipt_voucher_no)}` : "Payment",
      subtitle: null, amount: num(r.amount), status: str(r.method) ? paymentMethodLabel(str(r.method)!) : null,
      href: recordHref(l, { customerId: str(r.customer_id) }),
    }),
  },
};

/**
 * One record's preview for the signed-in VIEWER: role gate first (no read when the role cannot
 * open the page), then one read of the preview's columns under the viewer's own session (RLS).
 */
export async function fetchRecordPreview(db: PreviewDb, link: ChatLink, role: string | null | undefined): Promise<RecordPreview> {
  const type = isRecordType(link.type) ? link.type : null;
  if (!type) return { state: "not_found", type: "quote", id: link.id, label: "Record", message: "Unknown record" };
  const label = RECORD_LABEL[type];
  const base = { type, id: link.id, label };
  if (!viewerMayOpen(role, type)) {
    return { state: "no_access", ...base, message: `${label} — you don't have access` };
  }
  const spec = SPEC[type];
  const { data, error } = await db.from(spec.table).select(spec.columns).eq("id", link.id).maybeSingle();
  if (error) return { state: "error", ...base, message: `${label} — couldn't load` };
  if (!data || typeof data !== "object") {
    return { state: "not_found", ...base, message: `${label} — not found or you don't have access` };
  }
  return { state: "ok", ...base, ...spec.shape(data as Row, link) };
}
