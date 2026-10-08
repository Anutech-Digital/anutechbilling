/**
 * Google Business Profile — the server side: token, four Google APIs, and the sync that
 * writes gbp_locations / gbp_reviews / gbp_metrics_daily (migration 20260927250000).
 *
 * Four separate Google APIs, one scope (business.manage):
 *   Account Management   — which accounts the Google user manages
 *   Business Information — the listings (title, address, phone, website, review link)
 *   My Business v4       — reviews and replies (the only API that still has them)
 *   Performance          — daily impressions / calls / website clicks / directions
 *
 * All four must be ENABLED on the Google Cloud project, and Google gates the Business
 * Profile APIs behind a one-time access request (the project's quota is 0 until then).
 * That is a Console step, not a code one — the status route says so when it sees 403.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { googleOAuthCreds, refreshAccessToken } from "@/lib/google/oauth";
import { resealIfPlain } from "@/lib/google/token-vault";
import { hasGbpScope } from "@/lib/google/scope-union";
import {
  GBP_METRICS, GBP_METRIC_LAG_DAYS, GBP_METRIC_REFRESH_DAYS, GBP_METRIC_BACKFILL_DAYS,
  metricRowsFromPayload, starToNumber, type PerformancePayload,
} from "@/lib/marketing/gbp";
import { istToday, addDaysISO } from "@/lib/dates/ist";

type Admin = SupabaseClient<Database>;

const ACCOUNTS_URL = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
const INFO_URL = "https://mybusinessbusinessinformation.googleapis.com/v1";
const V4_URL = "https://mybusiness.googleapis.com/v4";
const PERF_URL = "https://businessprofileperformance.googleapis.com/v1";

export const GBP_SCOPE_MISSING_MESSAGE =
  "Google ne Business Profile padhne ki permission nahi di, isliye listing sync nahi ho sakti. " +
  "Reconnect kariye aur Google ki screen par \"Manage your business listings\" tick rehne dijiye.";

/** §24: what happened, why, what to do — for the two Google-side setup failures. */
export function explainGoogleError(status: number, body: string): string {
  if (status === 403 && /not been used in project|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(body)) {
    return "Google Cloud project par Business Profile APIs enable nahi hain (Account Management, Business Information, My Business v4, Performance). Console mein enable karke dobara sync karo.";
  }
  if (status === 429 || (status === 403 && /quota/i.test(body))) {
    return "Google ne Business Profile API ka quota 0 rakha hai — ek baar \"Business Profile API access\" form bharna hota hai (Google approve karta hai, 1–2 hafte). Tab tak sync nahi chalega.";
  }
  if (status === 401) return "Google token expire/revoke ho gaya — Reconnect karo.";
  return `Google ne ${status} diya: ${body.slice(0, 200)}`;
}

// ── Token ─────────────────────────────────────────────────────────────────
export async function getFreshGbpAccessToken(admin: Admin, userId: string): Promise<string> {
  const { data: tok } = await admin
    .from("user_google_tokens").select("access_token, refresh_token, token_expiry, scopes").eq("user_id", userId).maybeSingle();
  if (!tok || (!tok.access_token && !tok.refresh_token)) throw new Error("Google Business Profile not connected");
  if (!hasGbpScope(tok.scopes)) throw new Error(GBP_SCOPE_MISSING_MESSAGE);
  const exp = tok.token_expiry ? Date.parse(tok.token_expiry) : 0;
  if (tok.access_token && exp > Date.now() + 60_000) return tok.access_token;
  if (!tok.refresh_token) throw new Error("No refresh token — please reconnect Google Business Profile");
  const creds = googleOAuthCreds();
  if (!creds) throw new Error("Google OAuth not configured");
  const r = await refreshAccessToken(tok.refresh_token, creds);
  const expiry = new Date(Date.now() + (r.expires_in ?? 3600) * 1000).toISOString();
  // A legacy plaintext refresh token is sealed on this write (R-051).
  await admin.from("user_google_tokens").update({ access_token: r.access_token, token_expiry: expiry, ...resealIfPlain(tok.refresh_token) }).eq("user_id", userId);
  return r.access_token;
}

async function gget<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) throw new Error(explainGoogleError(res.status, await res.text().catch(() => "")));
  return (await res.json()) as T;
}

// ── Accounts & locations ──────────────────────────────────────────────────
export interface GAccount { name: string; accountName?: string; type?: string; verificationState?: string }
export async function listAccounts(token: string): Promise<GAccount[]> {
  const out: GAccount[] = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(ACCOUNTS_URL);
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const r = await gget<{ accounts?: GAccount[]; nextPageToken?: string }>(u.toString(), token);
    out.push(...(r.accounts ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

export interface GLocation {
  name: string; title?: string;
  storefrontAddress?: { addressLines?: string[]; locality?: string; administrativeArea?: string; postalCode?: string };
  phoneNumbers?: { primaryPhone?: string };
  websiteUri?: string;
  categories?: { primaryCategory?: { displayName?: string } };
  metadata?: { mapsUri?: string; newReviewUri?: string; placeId?: string; hasVoiceOfMerchant?: boolean };
}
const READ_MASK = "name,title,storefrontAddress,phoneNumbers,websiteUri,categories,metadata";
export async function listLocations(token: string, account: string): Promise<GLocation[]> {
  const out: GLocation[] = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(`${INFO_URL}/${account}/locations`);
    u.searchParams.set("readMask", READ_MASK);
    u.searchParams.set("pageSize", "100");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const r = await gget<{ locations?: GLocation[]; nextPageToken?: string }>(u.toString(), token);
    out.push(...(r.locations ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

export function formatAddress(a: GLocation["storefrontAddress"]): string | null {
  if (!a) return null;
  const parts = [...(a.addressLines ?? []), a.locality, a.administrativeArea, a.postalCode].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

// ── Reviews (My Business v4) ──────────────────────────────────────────────
export interface GReview {
  name: string; reviewId?: string;
  reviewer?: { displayName?: string; profilePhotoUrl?: string; isAnonymous?: boolean };
  starRating?: string; comment?: string; createTime?: string; updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string };
}
/** `parent` = "accounts/{a}/locations/{l}". Pulls every page; Google returns newest first. */
export async function listReviews(token: string, parent: string): Promise<{ reviews: GReview[]; averageRating: number | null; totalReviewCount: number }> {
  const reviews: GReview[] = [];
  let averageRating: number | null = null, totalReviewCount = 0;
  let pageToken: string | undefined;
  do {
    const u = new URL(`${V4_URL}/${parent}/reviews`);
    u.searchParams.set("pageSize", "50");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const r = await gget<{ reviews?: GReview[]; averageRating?: number; totalReviewCount?: number; nextPageToken?: string }>(u.toString(), token);
    reviews.push(...(r.reviews ?? []));
    if (r.averageRating !== undefined) averageRating = r.averageRating;
    if (r.totalReviewCount !== undefined) totalReviewCount = r.totalReviewCount;
    pageToken = r.nextPageToken;
  } while (pageToken);
  return { reviews, averageRating, totalReviewCount };
}

export async function replyToReview(token: string, reviewName: string, comment: string): Promise<{ comment: string; updateTime: string }> {
  const res = await fetch(`${V4_URL}/${reviewName}/reply`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ comment }),
  });
  if (!res.ok) throw new Error(explainGoogleError(res.status, await res.text().catch(() => "")));
  return (await res.json()) as { comment: string; updateTime: string };
}

// ── Performance ───────────────────────────────────────────────────────────
function ymd(iso: string): { year: number; month: number; day: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { year: y, month: m, day: d };
}
function addDays(iso: string, n: number): string {
  return addDaysISO(iso, n);
}

/** `location` = "locations/{id}". Google caps one call at 18 months, so the caller chunks. */
export async function fetchDailyMetrics(token: string, location: string, from: string, to: string): Promise<PerformancePayload> {
  const u = new URL(`${PERF_URL}/${location}:fetchMultiDailyMetricsTimeSeries`);
  for (const m of GBP_METRICS) u.searchParams.append("dailyMetrics", m);
  const f = ymd(from), t = ymd(to);
  u.searchParams.set("dailyRange.startDate.year", String(f.year));
  u.searchParams.set("dailyRange.startDate.month", String(f.month));
  u.searchParams.set("dailyRange.startDate.day", String(f.day));
  u.searchParams.set("dailyRange.endDate.year", String(t.year));
  u.searchParams.set("dailyRange.endDate.month", String(t.month));
  u.searchParams.set("dailyRange.endDate.day", String(t.day));
  return gget<PerformancePayload>(u.toString(), token);
}

// ── Sync ──────────────────────────────────────────────────────────────────
export interface GbpSyncResult { locations: number; reviews: number; metricRows: number; errors: string[] }

/**
 * One tenant, one Google user. Locations are upserted, reviews upserted by their Google
 * name (so an edited review or a new reply updates in place), metrics upserted per
 * (location, day, metric). The last 30 days are always re-fetched because Google
 * back-fills; the first run pulls the full 18 months so the history starts complete.
 */
export async function syncTenantGbp(admin: Admin, userId: string, tenantId: string, trigger: "manual" | "cron" | "connect"): Promise<GbpSyncResult> {
  const { data: run } = await admin.from("gbp_sync_runs").insert({ tenant_id: tenantId, trigger }).select("id").single();
  const result: GbpSyncResult = { locations: 0, reviews: 0, metricRows: 0, errors: [] };
  const today = istToday();   // IST calendar day
  try {
    const token = await getFreshGbpAccessToken(admin, userId);
    const accounts = await listAccounts(token);
    if (accounts.length === 0) throw new Error("Is Google account ke paas koi Business Profile nahi hai. business.google.com par jis email se listing manage hoti hai, usi se connect karo.");

    for (const acc of accounts) {
      const locations = await listLocations(token, acc.name);
      for (const loc of locations) {
        const parent = `${acc.name}/${loc.name}`;
        // Reviews first: the average rating and count on the location row come from here.
        let rev: Awaited<ReturnType<typeof listReviews>> = { reviews: [], averageRating: null, totalReviewCount: 0 };
        try { rev = await listReviews(token, parent); } catch (e) { result.errors.push(`${loc.title ?? loc.name}: reviews — ${(e as Error).message}`); }

        const { data: row, error: locErr } = await admin.from("gbp_locations").upsert({
          tenant_id: tenantId, connected_user_id: userId, account_name: acc.name, location_name: loc.name,
          title: loc.title ?? loc.name, primary_category: loc.categories?.primaryCategory?.displayName ?? null,
          address: formatAddress(loc.storefrontAddress), phone: loc.phoneNumbers?.primaryPhone ?? null,
          website_uri: loc.websiteUri ?? null, maps_uri: loc.metadata?.mapsUri ?? null, new_review_uri: loc.metadata?.newReviewUri ?? null,
          place_id: loc.metadata?.placeId ?? null, average_rating: rev.averageRating, total_reviews: rev.totalReviewCount || rev.reviews.length,
          is_verified: loc.metadata?.hasVoiceOfMerchant ?? null, last_synced_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,location_name" }).select("id").single();
        if (locErr || !row) { result.errors.push(`${loc.title ?? loc.name}: ${locErr?.message ?? "no row"}`); continue; }
        result.locations++;

        if (rev.reviews.length) {
          const rows = rev.reviews.flatMap((r) => {
            const star = starToNumber(r.starRating);
            if (!star || !r.createTime) return [];
            return [{
              tenant_id: tenantId, location_id: row.id, review_name: r.name,
              reviewer_name: r.reviewer?.displayName ?? null, reviewer_photo_uri: r.reviewer?.profilePhotoUrl ?? null,
              is_anonymous: r.reviewer?.isAnonymous ?? false, star_rating: star, comment: r.comment ?? null,
              reply_comment: r.reviewReply?.comment ?? null, replied_at: r.reviewReply?.updateTime ?? null,
              reviewed_at: r.createTime, updated_at_google: r.updateTime ?? null, updated_at: new Date().toISOString(),
            }];
          });
          const { error } = await admin.from("gbp_reviews").upsert(rows, { onConflict: "tenant_id,review_name" });
          if (error) result.errors.push(`${loc.title}: reviews save — ${error.message}`); else result.reviews += rows.length;
        }

        // Metrics: full back-fill when we have nothing for this location, else the refresh window.
        const { count } = await admin.from("gbp_metrics_daily").select("day", { count: "exact", head: true }).eq("location_id", row.id);
        const to = addDays(today, -GBP_METRIC_LAG_DAYS);
        const from = addDays(to, -((count ? GBP_METRIC_REFRESH_DAYS : GBP_METRIC_BACKFILL_DAYS) - 1));
        try {
          const payload = await fetchDailyMetrics(token, loc.name, from, to);
          const mrows = metricRowsFromPayload(payload).map((m) => ({ tenant_id: tenantId, location_id: row.id, day: m.day, metric: m.metric, value: m.value }));
          for (let i = 0; i < mrows.length; i += 1000) {
            const { error } = await admin.from("gbp_metrics_daily").upsert(mrows.slice(i, i + 1000), { onConflict: "location_id,day,metric" });
            if (error) throw new Error(error.message);
          }
          result.metricRows += mrows.length;
        } catch (e) {
          const why = (e as Error).message;
          result.errors.push(`${loc.title ?? loc.name}: performance — ${why}`);
          await admin.from("gbp_locations").update({ last_error: why }).eq("id", row.id);
        }
      }
    }

    // World-class touch: Google gives us the "write a review" link — save it where the
    // review-request flow reads it, if the owner never pasted one by hand.
    const { data: firstLoc } = await admin.from("gbp_locations").select("new_review_uri").eq("tenant_id", tenantId).not("new_review_uri", "is", null).limit(1).maybeSingle();
    if (firstLoc?.new_review_uri) {
      // marketing_tools ab generated types me hai (S21) — typed client; tenant filter wahi.
      const { data: tool } = await admin.from("marketing_tools").select("review_link").eq("tenant_id", tenantId).eq("tool_key", "google-business").maybeSingle();
      if (!tool?.review_link) {
        await admin.from("marketing_tools").upsert(
          { tenant_id: tenantId, tool_key: "google-business", name: "Google Business Profile", status: "active", review_link: firstLoc.new_review_uri, updated_at: new Date().toISOString() },
          { onConflict: "tenant_id,tool_key" },
        );
      }
    }

    if (run?.id) await admin.from("gbp_sync_runs").update({ finished_at: new Date().toISOString(), ok: result.errors.length === 0, locations: result.locations, reviews: result.reviews, metric_rows: result.metricRows, error: result.errors.join(" | ") || null }).eq("id", run.id);
    await admin.from("user_google_tokens").update({ last_error: result.errors.length ? result.errors.join(" | ").slice(0, 900) : null }).eq("user_id", userId);
    return result;
  } catch (e) {
    const why = (e as Error).message;
    if (run?.id) await admin.from("gbp_sync_runs").update({ finished_at: new Date().toISOString(), ok: false, error: why }).eq("id", run.id);
    await admin.from("user_google_tokens").update({ last_error: why }).eq("user_id", userId);
    throw e;
  }
}
