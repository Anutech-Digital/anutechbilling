/**
 * R-2670 — choose which Facebook / Instagram lead forms come into Sales → Leads, from ANY Page the
 * connected Meta Ads login manages (a brand's lead ads often run on a Page other than the one used
 * for posting). No Page token is stored: at list / pull time the Meta Ads login's token
 * (ad_accounts.access_token, sealed) is opened server-side and asked for its Pages' tokens.
 * Chosen forms live in meta_lead_forms (migration 20261112051529).
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { openMetaToken } from "@/lib/meta/meta-token-vault";
import { getAll, pullFormLeads } from "./page-pull";
import { importPulledLeads } from "./leadgen.server";
import type { createAdminClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createAdminClient>;
const VERSION = () => process.env.META_GRAPH_VERSION?.trim() || "v21.0";
const GRAPH = () => `https://graph.facebook.com/${VERSION()}`;
const ID = /^\d{1,30}$/;

export interface LeadFormChoice { id: string; name: string; status: string; leadsCount: number | null }
export interface LeadPageChoice { id: string; name: string; forms: LeadFormChoice[]; error: string | null }
export interface ChosenForm { form_id: string; page_id: string; page_name: string; form_name: string; enabled: boolean; last_pulled_at: string | null; last_result: string | null }

/** meta_lead_forms is newer than the generated Database types — same untyped pattern as social_content. */
export function untyped(admin: Admin): SupabaseClient { return admin as unknown as SupabaseClient; }

/** The Meta Ads login's user token for this company, or null when Meta Ads is not connected. */
export async function metaAdsUserToken(admin: Admin, tenantId: string): Promise<string | null> {
  const { data, error } = await admin.from("ad_accounts").select("access_token, token_expires_at")
    .eq("tenant_id", tenantId).eq("platform", "meta-ads").is("archived_at", null).not("access_token", "is", null)
    .order("created_at", { ascending: false }).limit(10);
  if (error) throw new Error(error.message);
  for (const row of data ?? []) {
    if (row.token_expires_at && Date.parse(row.token_expires_at) < Date.now()) continue;
    const token = openMetaToken(row.access_token);
    if (token) return token;
  }
  return null;
}

/** Page id → Page token for every Page the login manages. */
export async function pageTokens(userToken: string): Promise<Map<string, { name: string; token: string }>> {
  const res = await getAll<{ id?: string; name?: string; access_token?: string }>(`${GRAPH()}/me/accounts?fields=id,name,access_token&limit=100`, userToken, fetch, GRAPH());
  if (res.status !== 200) throw new Error(res.status === 400 || res.status === 401 || res.status === 403
    ? "Facebook did not allow reading your Pages. Reconnect Meta Ads in Paid ads and allow Page and lead access."
    : `Facebook did not answer (HTTP ${res.status}). Try again in a few minutes.`);
  const out = new Map<string, { name: string; token: string }>();
  for (const p of res.items) if (p.id && ID.test(p.id) && p.access_token) out.set(p.id, { name: p.name ?? p.id, token: p.access_token });
  return out;
}

/** Every Page with its lead forms — what the "Choose forms" list shows. */
export async function listLeadForms(userToken: string): Promise<LeadPageChoice[]> {
  const pages = await pageTokens(userToken);
  const out: LeadPageChoice[] = [];
  for (const [id, page] of pages) {
    const res = await getAll<{ id?: string; name?: string; status?: string; leads_count?: number }>(`${GRAPH()}/${id}/leadgen_forms?fields=id,name,status,leads_count&limit=100`, page.token, fetch, GRAPH());
    out.push({
      id, name: page.name,
      forms: res.items.filter((f) => f.id && ID.test(f.id)).map((f) => ({ id: f.id!, name: f.name ?? f.id!, status: f.status ?? "", leadsCount: typeof f.leads_count === "number" ? f.leads_count : null })),
      error: res.status === 200 ? null : "Could not read this Page's lead forms (your Facebook role on it may not allow leads).",
    });
  }
  return out.sort((a, b) => b.forms.length - a.forms.length || a.name.localeCompare(b.name));
}

export async function readChosenForms(admin: Admin, tenantId: string): Promise<ChosenForm[]> {
  const { data, error } = await untyped(admin).from("meta_lead_forms")
    .select("form_id, page_id, page_name, form_name, enabled, last_pulled_at, last_result")
    .eq("tenant_id", tenantId).order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as ChosenForm[];
}

export interface PullSummary { forms: number; found: number; created: number; duplicate: number; already: number; failed: number; problems: string[] }

/** Bring the leads of every chosen form since `since` into Sales → Leads. */
export async function pullChosenForms(admin: Admin, tenantId: string, since: Date): Promise<PullSummary> {
  const sum: PullSummary = { forms: 0, found: 0, created: 0, duplicate: 0, already: 0, failed: 0, problems: [] };
  const chosen = (await readChosenForms(admin, tenantId)).filter((f) => f.enabled);
  if (chosen.length === 0) return sum;
  const userToken = await metaAdsUserToken(admin, tenantId);
  if (!userToken) { sum.problems.push("Meta Ads is not connected. Connect it in Paid ads, then fetch again."); return sum; }
  const tokens = await pageTokens(userToken);
  for (const form of chosen) {
    sum.forms++;
    const page = tokens.get(form.page_id);
    let result: string;
    if (!page) {
      result = `Your Facebook login no longer manages the Page "${form.page_name}".`;
      sum.problems.push(result);
    } else {
      const pulled = await pullFormLeads({ formId: form.form_id, pageToken: page.token, since, graphVersion: VERSION() });
      const saved = await importPulledLeads({ admin, tenantId, pageId: form.page_id, leads: pulled.leads, graphVersion: VERSION() });
      sum.found += pulled.leads.length; sum.created += saved.created; sum.duplicate += saved.duplicate; sum.already += saved.already; sum.failed += saved.failed;
      result = pulled.error ?? `${pulled.leads.length} found, ${saved.created} new`;
      if (pulled.error) sum.problems.push(`${form.form_name}: ${pulled.error}`);
    }
    await untyped(admin).from("meta_lead_forms").update({ last_pulled_at: new Date().toISOString(), last_result: result.slice(0, 500) })
      .eq("tenant_id", tenantId).eq("form_id", form.form_id);
  }
  return sum;
}
