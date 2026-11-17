/**
 * Reads what a Facebook Page says about the business (about, services, products, recent posts)
 * so the AI can plan from it without the owner typing a brief. Never throws: "" when Meta says nothing.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pageConnection } from "@/lib/marketing/social-pages.server";
import { readFacebookPage } from "@/lib/integrations/facebook-page";
import { businessBrief, profileBrief, type PageProfile } from "@/lib/marketing/social-page-brief";

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION?.trim() || "v21.0"}`;
const FIELDS = "name,about,description,category,website,mission,company_overview,products,general_info";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    return r.ok ? (await r.json()) as T : null;
  } catch { return null; }
}

/** The Page's own words about the business, ready for the AI. */
export async function readPageProfileBrief(pageId: string, pageToken: string): Promise<string> {
  const id = encodeURIComponent(pageId);
  const [profile, posts] = await Promise.all([
    getJson<PageProfile>(`${GRAPH}/${id}?${new URLSearchParams({ fields: FIELDS, access_token: pageToken })}`),
    getJson<{ data?: { message?: string }[] }>(`${GRAPH}/${id}/posts?${new URLSearchParams({ fields: "message", limit: "10", access_token: pageToken })}`),
  ]);
  return profileBrief(profile, (posts?.data ?? []).map((p) => p.message ?? ""));
}

/** The owner's brief plus what the Page says (finds the Page's token itself). */
export async function briefForPage(admin: SupabaseClient, tenantId: string, pageId: string, ownerBrief: string): Promise<string> {
  let c: { pageId: string | null; pageToken: string | null } = await pageConnection(admin, tenantId, pageId).catch(() => ({ pageId: null, pageToken: null }));
  if (!c.pageToken) {
    const main = await readFacebookPage(admin as unknown as Parameters<typeof readFacebookPage>[0], tenantId).catch(() => null);
    if (main?.pageId === pageId && main.pageToken) c = { pageId: main.pageId, pageToken: main.pageToken };
  }
  const fromPage = c.pageId && c.pageToken ? await readPageProfileBrief(c.pageId, c.pageToken) : "";
  return businessBrief(ownerBrief, fromPage);
}
