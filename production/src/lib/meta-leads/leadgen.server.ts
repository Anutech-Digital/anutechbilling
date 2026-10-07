/**
 * R-117 — server half of the Meta Lead Ads intake: config from env, Graph fetch, dedupe, insert.
 *
 * CONFIG (env only — names in .env.example, values never logged)
 *   META_LEADS_VERIFY_TOKEN       any random string; the same string goes in Meta's "Verify token".
 *   META_APP_SECRET               the Meta app's App Secret — signs every POST (X-Hub-Signature-256).
 *   META_LEADS_TENANT_ID          the ONE workspace (tenants.id) these leads belong to.
 *   META_LEADS_PAGE_IDS           optional, comma-separated Facebook Page ids; others are ignored.
 *   META_LEADS_PAGE_ACCESS_TOKEN  Page access token with leads_retrieval — fetches the answers.
 *   META_GRAPH_VERSION            optional, default v21.0 (shared with the Ads spend sync).
 *
 * WHY ONE TENANT FROM ENV
 *   A Meta app webhook is app-wide: the body names a Page, not a workspace. Mapping Page →
 *   tenant from data in the payload would let anyone who can subscribe a Page to the app pick
 *   whose CRM a lead lands in. So the tenant is fixed by the operator in env; no tenant set →
 *   nothing is written. Per-tenant pages (multi-reseller) need a stored page→tenant map — a
 *   later card, not a guess.
 */
import "server-only";
import type { createAdminClient } from "@/lib/supabase/server";
import {
  buildMetaLeadRow, dedupeKeys, mapFieldData, metaLeadId,
  type GraphLead, type LeadgenRef,
} from "./leadgen";

type Admin = ReturnType<typeof createAdminClient>;

export interface MetaLeadsConfig {
  verifyToken: string | null;
  appSecret: string | null;
  tenantId: string | null;
  pageIds: string[];
  pageAccessToken: string | null;
  graphVersion: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readMetaLeadsConfig(env: NodeJS.ProcessEnv = process.env): MetaLeadsConfig {
  const t = (k: string) => env[k]?.trim() || null;
  const tenant = t("META_LEADS_TENANT_ID");
  return {
    verifyToken: t("META_LEADS_VERIFY_TOKEN"),
    appSecret: t("META_APP_SECRET"),
    tenantId: tenant && UUID.test(tenant) ? tenant : null,
    pageIds: (t("META_LEADS_PAGE_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    pageAccessToken: t("META_LEADS_PAGE_ACCESS_TOKEN"),
    graphVersion: t("META_GRAPH_VERSION") ?? "v21.0",
  };
}

export type FetchResult = { ok: true; lead: GraphLead } | { ok: false; note: string };

/**
 * One lead's answers from the Graph API. The token goes in the Authorization header, never the
 * URL, so it cannot end up in a log line or an error message.
 */
export async function fetchGraphLead(
  leadgenId: string,
  cfg: Pick<MetaLeadsConfig, "pageAccessToken" | "graphVersion">,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchResult> {
  if (!cfg.pageAccessToken) {
    return { ok: false, note: "Details not fetched: META_LEADS_PAGE_ACCESS_TOKEN is not set. Open Meta Leads Center to see the answers." };
  }
  const url = `https://graph.facebook.com/${encodeURIComponent(cfg.graphVersion)}/${leadgenId}` +
    "?fields=id,created_time,field_data,ad_id,ad_name,form_id,campaign_name";
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${cfg.pageAccessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { ok: false, note: `Details not fetched: Graph API answered HTTP ${res.status}. Check the Page token (leads_retrieval) and open Meta Leads Center for the answers.` };
    }
    const json = (await res.json().catch(() => null)) as GraphLead | null;
    if (!json || !Array.isArray(json.field_data)) {
      return { ok: false, note: "Details not fetched: Graph API reply had no field_data." };
    }
    return { ok: true, lead: json };
  } catch (e) {
    return { ok: false, note: `Details not fetched: Graph API unreachable (${e instanceof Error ? e.name : "network error"}).` };
  }
}

export type IngestOutcome =
  | { kind: "created"; leadId: string }
  | { kind: "duplicate"; leadId: string }
  | { kind: "already_imported"; leadId: string }
  | { kind: "failed"; message: string };

/** Escape %, _ and \ so a value is matched literally by ilike. */
function likeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * An existing lead in THIS tenant with the same email or phone (last 10 digits), not junk.
 * Phone is narrowed in SQL by the digits and confirmed with the same normaliser the Add-lead
 * duplicate check uses.
 */
async function findExisting(admin: Admin, tenantId: string, email: string, phone: string): Promise<string | null> {
  if (email) {
    const { data } = await admin.from("leads").select("id")
      .eq("tenant_id", tenantId).eq("is_junk", false)
      .ilike("contact_email", likeLiteral(email))
      .order("created_at", { ascending: true }).limit(1).maybeSingle();
    if (data?.id) return data.id;
  }
  if (phone) {
    const { data } = await admin.from("leads").select("id, contact_phone")
      .eq("tenant_id", tenantId).eq("is_junk", false)
      .ilike("contact_phone", `%${phone}`)
      .order("created_at", { ascending: true }).limit(20);
    const hit = (data ?? []).find((r) => dedupeKeys({ email: null, phone: r.contact_phone }).phone === phone);
    if (hit) return hit.id;
  }
  return null;
}

export async function ingestMetaLead(opts: {
  admin: Admin;
  tenantId: string;
  ref: LeadgenRef;
  cfg: Pick<MetaLeadsConfig, "pageAccessToken" | "graphVersion">;
  fetchImpl?: typeof fetch;
}): Promise<IngestOutcome> {
  const { admin, tenantId, ref } = opts;
  const id = metaLeadId(tenantId, ref.leadgenId);

  /* Meta re-delivers a notice it thinks failed. Same leadgen id → same lead id → nothing new. */
  const { data: already } = await admin.from("leads").select("id")
    .eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (already?.id) return { kind: "already_imported", leadId: id };

  const fetched = await fetchGraphLead(ref.leadgenId, opts.cfg, opts.fetchImpl);
  const graph = fetched.ok ? fetched.lead : null;
  const keys = dedupeKeys(graph ? mapFieldData(graph.field_data) : null);

  const existing = await findExisting(admin, tenantId, keys.email, keys.phone);
  if (existing) {
    /* Same person filled the form again: no second lead — a note on the one they already have,
       once per Meta lead id. */
    const marker = `Meta lead ${ref.leadgenId}`;
    const { data: noted } = await admin.from("lead_activities").select("id")
      .eq("tenant_id", tenantId).eq("lead_id", existing)
      .ilike("detail", `%${likeLiteral(marker)}%`).limit(1).maybeSingle();
    if (!noted) {
      const row = buildMetaLeadRow(tenantId, ref, graph, null);
      const { error } = await admin.from("lead_activities").insert({
        tenant_id: tenantId,
        lead_id: existing,
        kind: "note",
        detail: `Filled a Facebook/Instagram lead form again (${marker}).\n${row.notes}`.slice(0, 4000),
      });
      if (error) console.error(`[webhooks/meta] note on duplicate ${existing} not written: ${error.message}`);
    }
    return { kind: "duplicate", leadId: existing };
  }

  const row = buildMetaLeadRow(tenantId, ref, graph, fetched.ok ? null : fetched.note);
  const { error } = await admin.from("leads").insert(row);
  if (error) {
    /* 23505 = the deterministic id was inserted by a parallel delivery a moment ago. */
    if (error.code === "23505") return { kind: "already_imported", leadId: id };
    return { kind: "failed", message: error.message.slice(0, 300) };
  }
  return { kind: "created", leadId: id };
}
