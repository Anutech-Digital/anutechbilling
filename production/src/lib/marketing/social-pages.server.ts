/**
 * R-2729 (G-SOCIAL): the company's Facebook Pages (each with its own Instagram) for Social growth.
 *
 * - Connecting Facebook saves EVERY Page the login manages (sealed token per Page); the Page picked
 *   as the company's main Page is active. "Manage Pages" turns others on or off.
 * - Each Page has its own brief and AI settings (Abhishek, 13 Nov 2026). Stop all AI stays one
 *   switch for the company (social_content_settings.ai_paused).
 * - The marketing team sees all Pages (Abhishek, 13 Nov 2026).
 *
 * Takes an UNTYPED service-role client: every query filters by tenant_id itself. Tokens never leave
 * the server.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret } from "@/lib/crypto/vault";
import { instagramForPage } from "./social-content";

export interface SocialPage {
  id: string; page_id: string; name: string; instagram_id: string | null; instagram_username: string | null;
  active: boolean; is_main: boolean; brief: string; auto_drafts: boolean; autopilot: boolean; posts_per_week: number;
  picture_urls: string[]; comment_mode: "off" | "ask" | "auto"; last_generated_on: string | null;
  comments_checked_at: string | null; comments_problem: string | null; followers_checked_on: string | null;
}
export interface PageConnection { pageId: string | null; pageToken: string | null; pageName: string | null; instagramId: string | null }

const COLS = "id, page_id, name, instagram_id, instagram_username, active, is_main, brief, auto_drafts, autopilot, posts_per_week, picture_urls, comment_mode, last_generated_on, comments_checked_at, comments_problem, followers_checked_on";
export const PAGE_ID = /^\d{1,30}$/;

export async function listPages(admin: SupabaseClient, tenantId: string, opts: { activeOnly?: boolean } = {}): Promise<SocialPage[]> {
  let q = admin.from("social_pages").select(COLS).eq("tenant_id", tenantId);
  if (opts.activeOnly) q = q.eq("active", true);
  const { data, error } = await q.order("is_main", { ascending: false }).order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []) as SocialPage[];
}

export async function readPage(admin: SupabaseClient, tenantId: string, pageId: string): Promise<SocialPage | null> {
  if (!PAGE_ID.test(pageId)) return null;
  const { data } = await admin.from("social_pages").select(COLS).eq("tenant_id", tenantId).eq("page_id", pageId).maybeSingle();
  return (data as SocialPage | null) ?? null;
}

/** The Page asked for when it is an active Page of this company; else the main Page (else the first active). */
export async function resolvePage(admin: SupabaseClient, tenantId: string, requested?: string | null): Promise<SocialPage | null> {
  const pages = await listPages(admin, tenantId, { activeOnly: true });
  return pages.find((p) => p.page_id === requested) ?? pages.find((p) => p.is_main) ?? pages[0] ?? null;
}

/** The Page's token for Meta calls (server only). */
export async function pageConnection(admin: SupabaseClient, tenantId: string, pageId: string | null | undefined): Promise<PageConnection> {
  const none: PageConnection = { pageId: null, pageToken: null, pageName: null, instagramId: null };
  if (!pageId || !PAGE_ID.test(pageId)) return none;
  const [{ data: tok }, page] = await Promise.all([
    admin.from("social_page_tokens").select("page_token").eq("tenant_id", tenantId).eq("page_id", pageId).maybeSingle(),
    readPage(admin, tenantId, pageId),
  ]);
  const token = decryptSecret((tok as { page_token?: string } | null)?.page_token ?? null);
  if (!token || !page) return none;
  return { pageId, pageToken: token, pageName: page.name, instagramId: page.instagram_id };
}

/**
 * After a Facebook login: save every Page it manages (token sealed) and its Instagram account.
 * The main Page is switched on; Pages seen before keep their on/off choice; new ones start off.
 */
export async function syncPagesFromLogin(admin: SupabaseClient, tenantId: string, pages: readonly { id: string; name: string; access_token: string }[], mainPageId: string): Promise<number> {
  const valid = pages.filter((p) => PAGE_ID.test(p.id) && p.access_token);
  if (!valid.length) return 0;
  const { error: tokErr } = await admin.from("social_page_tokens").upsert(
    valid.map((p) => ({ tenant_id: tenantId, page_id: p.id, page_token: encryptSecret(p.access_token), updated_at: new Date().toISOString() })),
    { onConflict: "tenant_id,page_id" });
  if (tokErr) throw tokErr;
  const known = new Set((await listPages(admin, tenantId)).map((p) => p.page_id));
  const instagram = await Promise.all(valid.map((p) => instagramForPage(p.id, p.access_token).catch(() => null)));
  const rows = valid.map((p, i) => ({
    tenant_id: tenantId, page_id: p.id, name: p.name.slice(0, 200),
    instagram_id: instagram[i]?.id && PAGE_ID.test(instagram[i]!.id) ? instagram[i]!.id : null,
    instagram_username: instagram[i]?.username?.slice(0, 100) ?? null,
    updated_at: new Date().toISOString(),
    ...(known.has(p.id) ? {} : { active: p.id === mainPageId }),
  }));
  const { error } = await admin.from("social_pages").upsert(rows, { onConflict: "tenant_id,page_id" });
  if (error) throw error;
  await admin.from("social_pages").update({ is_main: false }).eq("tenant_id", tenantId).neq("page_id", mainPageId);
  await admin.from("social_pages").update({ is_main: true, active: true }).eq("tenant_id", tenantId).eq("page_id", mainPageId);
  return valid.length;
}

/** The AI settings of one Page that a person may change. */
export type PageSettingsPatch = Partial<Pick<SocialPage, "brief" | "auto_drafts" | "autopilot" | "posts_per_week" | "picture_urls" | "comment_mode" | "active" | "last_generated_on" | "comments_checked_at" | "comments_problem" | "followers_checked_on">>;

export async function updatePage(admin: SupabaseClient, tenantId: string, pageId: string, patch: PageSettingsPatch): Promise<boolean> {
  if (!PAGE_ID.test(pageId)) return false;
  const { data, error } = await admin.from("social_pages").update({ ...patch, updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("page_id", pageId).select("id");
  if (error) throw error;
  return (data ?? []).length === 1;
}
