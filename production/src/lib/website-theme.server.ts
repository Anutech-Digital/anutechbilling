/**
 * Reads the public website's theme (tenants.website_theme on the website tenant) for the
 * `(marketing)` layout. Server-only.
 *
 * Same shape as getPriceBook (catalog-prices.server.ts): a short in-process cache, a read
 * budget so a slow database never holds a page, and the last good answer when a read fails.
 *
 * What a failure falls back to, and why that is not a "plausible wrong value" (AGENTS.md §2):
 * the fallback is CLASSIC — the look the website has always had and the column's own default —
 * and every fallback is logged with its reason. No price, number or text depends on it.
 *
 * Untyped client: website_theme is newer than database.generated.ts (regenerating needs the
 * local docker stack), the same approach as the online-fee columns (lib/queries/online-fee.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import {
  DEFAULT_WEBSITE_THEME,
  isWebsiteThemeColumnMissing,
  parseWebsiteTheme,
  type WebsiteTheme,
} from "@/lib/website-theme";

/** A switch in Settings also revalidates the pages, so this only bounds other instances. */
export const WEBSITE_THEME_TTL_MS = 30_000;
export const WEBSITE_THEME_READ_BUDGET_MS = 3_000;

interface Cached { at: number; theme: WebsiteTheme }
const fresh = new Map<string, Cached>();
const lastGood = new Map<string, Cached>();

export function forgetWebsiteThemeForTests(): void {
  fresh.clear();
  lastGood.clear();
}

/** After the owner switches: this instance answers the new value at once. */
export function rememberWebsiteTheme(tenantId: string, theme: WebsiteTheme, now = Date.now()): void {
  const entry = { at: now, theme };
  fresh.set(tenantId, entry);
  lastGood.set(tenantId, entry);
}

type ReadResult = { theme: WebsiteTheme } | { missingColumn: true };

async function readTheme(tenantId: string): Promise<ReadResult> {
  const admin = createAdminClient() as unknown as SupabaseClient;
  const read = admin.from("tenants").select("website_theme").eq("id", tenantId).maybeSingle();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${WEBSITE_THEME_READ_BUDGET_MS} ms`)), WEBSITE_THEME_READ_BUDGET_MS);
  });
  try {
    const { data, error } = await Promise.race([read, budget]);
    if (isWebsiteThemeColumnMissing(error)) return { missingColumn: true };
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`no tenants row ${tenantId} (BUY_PAGE_TENANT_ID points at a company that does not exist here)`);
    const theme = parseWebsiteTheme((data as { website_theme?: unknown }).website_theme);
    if (!theme) throw new Error(`unknown website_theme value ${JSON.stringify((data as { website_theme?: unknown }).website_theme)}`);
    return { theme };
  } finally {
    clearTimeout(timer);
  }
}

export async function getWebsiteTheme(tenantId: string | null, now = Date.now()): Promise<WebsiteTheme> {
  if (!tenantId) return DEFAULT_WEBSITE_THEME;
  const hit = fresh.get(tenantId);
  if (hit && now - hit.at < WEBSITE_THEME_TTL_MS) return hit.theme;

  try {
    const res = await readTheme(tenantId);
    if ("missingColumn" in res) {
      // Expected until the migration is deployed — not an error, and cached like an answer.
      const entry = { at: now, theme: DEFAULT_WEBSITE_THEME };
      fresh.set(tenantId, entry);
      return DEFAULT_WEBSITE_THEME;
    }
    rememberWebsiteTheme(tenantId, res.theme, now);
    return res.theme;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const kept = lastGood.get(tenantId);
    if (kept) {
      console.warn(`[website-theme] read failed (${msg}) — keeping the ${kept.theme} theme read ${Math.round((now - kept.at) / 1000)} s ago.`);
      return kept.theme;
    }
    console.error(`[website-theme] read failed (${msg}) — showing the ${DEFAULT_WEBSITE_THEME} theme.`);
    return DEFAULT_WEBSITE_THEME;
  }
}
