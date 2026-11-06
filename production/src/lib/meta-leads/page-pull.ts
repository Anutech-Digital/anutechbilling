/**
 * R-2521 — pull Facebook / Instagram lead-form leads from the CONNECTED Page (Marketing Hub →
 * Facebook Page), instead of waiting for the webhook (R-117), which needs env setup and a public
 * URL. Page → its lead forms → each form's leads since a day. Pure apart from the injected fetch,
 * so it is tested without Meta.
 *
 * Needs the Page token to carry leads_retrieval + pages_manage_ads (asked for when the Page is
 * connected). A token without them gets HTTP 403 → `needsReconnect`, and the screen says
 * "Reconnect the Page" instead of showing zero leads.
 */
import type { GraphLead } from "./leadgen";

export const LEAD_FIELDS = "id,created_time,field_data,ad_id,ad_name,form_id,campaign_name";
const MAX_PAGES = 20; // 20 × 100 per form is far beyond one run's new leads

export interface PagePullResult {
  forms: number;
  leads: GraphLead[];
  /** The Page token cannot read leads — the Page must be connected again with lead permission. */
  needsReconnect: boolean;
  /** Plain message when Meta refused for another reason. */
  error: string | null;
}

type Fetch = typeof fetch;

async function getAll<T>(firstUrl: string, token: string, fetchImpl: Fetch, graph: string): Promise<{ items: T[]; status: number }> {
  const items: T[] = [];
  let url: string | undefined = firstUrl;
  for (let i = 0; url && i < MAX_PAGES; i++) {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { items, status: res.status };
    const body = (await res.json().catch(() => null)) as { data?: T[]; paging?: { next?: string } } | null;
    items.push(...(body?.data ?? []));
    const next = body?.paging?.next;
    // Only follow Meta's own links — never a URL from somewhere else.
    url = next && next.startsWith(`${graph}/`) ? next : undefined;
  }
  return { items, status: 200 };
}

/** Leads created on or after `since` on every lead form of the Page. */
export async function pullPageLeads(opts: {
  pageId: string; pageToken: string; since: Date; graphVersion?: string; fetchImpl?: Fetch;
}): Promise<PagePullResult> {
  const graph = `https://graph.facebook.com/${opts.graphVersion ?? "v21.0"}`;
  const f = opts.fetchImpl ?? fetch;
  if (!/^\d{1,30}$/.test(opts.pageId)) return { forms: 0, leads: [], needsReconnect: false, error: "The connected Page id is not valid. Connect the Page again." };

  const formsRes = await getAll<{ id?: string; status?: string }>(`${graph}/${opts.pageId}/leadgen_forms?fields=id,status&limit=100`, opts.pageToken, f, graph);
  if (formsRes.status !== 200) return failed(formsRes.status);
  const forms = formsRes.items.filter((x) => x.id && /^\d{1,30}$/.test(x.id));

  const sinceUnix = Math.floor(opts.since.getTime() / 1000);
  const filtering = encodeURIComponent(JSON.stringify([{ field: "time_created", operator: "GREATER_THAN_OR_EQUAL", value: sinceUnix }]));
  const leads: GraphLead[] = [];
  for (const form of forms) {
    const res = await getAll<GraphLead>(`${graph}/${form.id}/leads?fields=${LEAD_FIELDS}&limit=100&filtering=${filtering}`, opts.pageToken, f, graph);
    if (res.status !== 200) return { ...failed(res.status), forms: forms.length, leads };
    leads.push(...res.items.filter((l) => l.id).map((l) => ({ ...l, form_id: l.form_id ?? form.id })));
  }
  return { forms: forms.length, leads, needsReconnect: false, error: null };
}

function failed(status: number): PagePullResult {
  if (status === 400 || status === 401 || status === 403) {
    return { forms: 0, leads: [], needsReconnect: true, error: "Facebook did not allow reading leads for this Page. Connect the Page again and allow lead access." };
  }
  return { forms: 0, leads: [], needsReconnect: false, error: `Facebook did not answer (HTTP ${status}). Try again in a few minutes.` };
}
