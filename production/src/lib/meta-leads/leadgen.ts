/**
 * R-117 — Facebook / Instagram Lead Ads straight into leads. Pure half (parse + map), tested
 * without a network or a database.
 *
 * HOW META DELIVERS A LEAD
 *   The webhook does NOT carry the form answers. It says "lead <leadgen_id> arrived on page P,
 *   form F, ad A" (object "page", field "leadgen"). The answers (name, phone, email, custom
 *   questions) are fetched separately from the Graph API with a Page access token:
 *     GET /<version>/<leadgen_id>?fields=id,created_time,field_data,ad_id,ad_name,form_id,campaign_name
 *   That fetch lives in leadgen.server.ts and runs only when META_LEADS_PAGE_ACCESS_TOKEN is set.
 *
 * SOURCE KEY
 *   Saved as "meta-ads", not a free-text "meta"/"facebook": Marketing → ROAS & CAC joins ad spend
 *   (expenses.channel) to leads.source by exact key (lib/leads/lead-sources.ts). A lead saved
 *   under any other spelling would be spend with no leads and leads with no spend.
 */
import { normPhone } from "@/lib/leads/duplicates";
import { normEmail } from "@/lib/leads/duplicate-check";

export const META_LEAD_SOURCE = "meta-ads";

/** One "a lead arrived" notice from the webhook body. */
export interface LeadgenRef {
  leadgenId: string;
  pageId: string | null;
  formId: string | null;
  adId: string | null;
  createdTime: string | null;
}

/** What the Graph API returns for one lead (only the fields we ask for). */
export interface GraphLead {
  id?: string;
  created_time?: string;
  ad_id?: string;
  ad_name?: string;
  form_id?: string;
  campaign_name?: string;
  field_data?: { name?: string; values?: unknown[] }[];
}

export interface MappedLead {
  contactName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  city: string | null;
  state: string | null;
  /** Every answer that has no column of its own (custom questions), "question: answer". */
  extra: string[];
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Leadgen notices in a webhook body. Anything that is not object "page" / field "leadgen", or
 * has no leadgen_id, is ignored (Meta also sends other page fields to the same app).
 */
export function parseLeadgenWebhook(body: unknown): LeadgenRef[] {
  if (!body || typeof body !== "object") return [];
  const b = body as { object?: unknown; entry?: unknown };
  if (b.object !== "page" || !Array.isArray(b.entry)) return [];
  const out: LeadgenRef[] = [];
  const seen = new Set<string>();
  for (const entry of b.entry) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { id?: unknown; changes?: unknown };
    if (!Array.isArray(e.changes)) continue;
    for (const change of e.changes) {
      if (!change || typeof change !== "object") continue;
      const c = change as { field?: unknown; value?: unknown };
      if (c.field !== "leadgen" || !c.value || typeof c.value !== "object") continue;
      const v = c.value as Record<string, unknown>;
      const leadgenId = str(v.leadgen_id);
      /* Graph ids are digits. Anything else is not a Meta lead id and must never reach a
         URL path or a primary key. */
      if (!leadgenId || !/^\d{1,40}$/.test(leadgenId) || seen.has(leadgenId)) continue;
      seen.add(leadgenId);
      const created = v.created_time;
      out.push({
        leadgenId,
        pageId: str(v.page_id) ?? str(e.id),
        formId: str(v.form_id),
        adId: str(v.ad_id),
        createdTime: typeof created === "number" ? new Date(created * 1000).toISOString() : str(created),
      });
    }
  }
  return out;
}

/* Meta's standard question keys → our columns. Custom questions keep their own name. */
const KEY_ALIASES: Record<string, keyof Omit<MappedLead, "extra"> | "first_name" | "last_name"> = {
  full_name: "contactName", name: "contactName",
  first_name: "first_name", last_name: "last_name",
  email: "email", work_email: "email",
  phone_number: "phone", phone: "phone", work_phone_number: "phone", mobile_number: "phone",
  company_name: "company", company: "company",
  city: "city",
  state: "state", province: "state",
};

export function mapFieldData(fieldData: GraphLead["field_data"]): MappedLead {
  const m: MappedLead = { contactName: null, email: null, phone: null, company: null, city: null, state: null, extra: [] };
  let first: string | null = null;
  let last: string | null = null;
  for (const f of fieldData ?? []) {
    const name = (f?.name ?? "").trim();
    const value = (f?.values ?? []).map(str).filter((x): x is string => !!x).join(", ") || null;
    if (!name || !value) continue;
    const key = KEY_ALIASES[name.toLowerCase()];
    if (key === "first_name") first = value;
    else if (key === "last_name") last = value;
    else if (key && m[key] === null) m[key] = value;
    else m.extra.push(`${name.replace(/_/g, " ")}: ${value}`);
  }
  if (!m.contactName && (first || last)) m.contactName = [first, last].filter(Boolean).join(" ");
  if (m.email && !normEmail(m.email)) { m.extra.push(`email (invalid): ${m.email}`); m.email = null; }
  return m;
}

/** Deterministic lead id — a Meta retry of the same lead hits the same primary key. */
export function metaLeadId(tenantId: string, leadgenId: string): string {
  return `L-META-${tenantId.replace(/-/g, "").slice(0, 8).toUpperCase()}-${leadgenId}`;
}

/** Dedupe keys, same normalisers as the Add-lead duplicate check (R-072). */
export function dedupeKeys(m: Pick<MappedLead, "email" | "phone"> | null): { email: string; phone: string } {
  return { email: normEmail(m?.email), phone: normPhone(m?.phone) };
}

export interface MetaLeadRow {
  id: string;
  tenant_id: string;
  company: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  state: string | null;
  source: string;
  stage: "new";
  priority: "medium";
  utm_source: string;
  utm_medium: string;
  utm_campaign: string | null;
  notes: string;
}

/**
 * The leads row. `owner_id` is deliberately absent: the R-111 trigger deals it to the
 * "New leads" pool if an owner opted people in, and leaves it unassigned otherwise.
 * `detailsNote` explains a lead whose answers could not be fetched.
 */
export function buildMetaLeadRow(
  tenantId: string,
  ref: LeadgenRef,
  graph: GraphLead | null,
  detailsNote: string | null,
): MetaLeadRow {
  const m = graph ? mapFieldData(graph.field_data) : null;
  const lines = [
    `Facebook/Instagram lead form (Meta lead ${ref.leadgenId}).`,
    graph?.campaign_name ? `Campaign: ${graph.campaign_name}` : null,
    graph?.ad_name ? `Ad: ${graph.ad_name}` : null,
    `Form ${graph?.form_id ?? ref.formId ?? "—"}, ad ${graph?.ad_id ?? ref.adId ?? "—"}, page ${ref.pageId ?? "—"}.`,
    m?.city ? `City: ${m.city}` : null,
    ...(m?.extra ?? []),
    detailsNote,
  ].filter((x): x is string => !!x);
  return {
    id: metaLeadId(tenantId, ref.leadgenId),
    tenant_id: tenantId,
    /* company is NOT NULL and is what every list shows: best known name, else the phone, else
       a label that says where it came from. */
    company: m?.company ?? m?.contactName ?? m?.phone ?? `Facebook lead ${ref.leadgenId}`,
    contact_name: m?.contactName ?? null,
    contact_email: m?.email ? m.email.toLowerCase() : null,
    contact_phone: m?.phone ?? null,
    state: m?.state ?? null,
    source: META_LEAD_SOURCE,
    stage: "new",
    priority: "medium",
    utm_source: "facebook",
    utm_medium: "paid_social",
    utm_campaign: graph?.campaign_name ?? null,
    notes: lines.join("\n").slice(0, 4000),
  };
}
