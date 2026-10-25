/**
 * R-1875 (epic R-1874, campaign co-pilot phase A) — each ad platform's copy limits and
 * objective names, in ONE place (UI rule 1: one fact, one place). The AI copy writer (R-1876)
 * writes inside these limits, the wizard shows counters from them, and the publisher (R-1886+)
 * maps objectives with them.
 *
 * Pardeep (epic, 24 Oct): Google Ads + Meta first; LinkedIn / TikTok / Snapchat get added
 * with their own adapter cards after their API approvals.
 *
 * ─── RULE: ONLY OFFICIAL NUMBERS ────────────────────────────────────────────
 * Every number below was read on 25 Oct 2026 from the page in its `source` — Google's own
 * help / developer pages and Meta's own Ads Guide / developer pages. Never from memory and
 * never from a marketing blog. When a platform publishes only a RECOMMENDED length (Meta),
 * `max` stays null — the much-quoted "125 / 40 / 25" Meta numbers come from third-party sites,
 * not from Meta's Ads Guide, so they are NOT here.
 * To change a number: open the source page, then change it here and in channel-specs.test.ts.
 *
 * Platform keys match ad_accounts.platform ('google-ads' | 'meta-ads',
 * supabase/migrations/20260927260000_ad_platforms.sql).
 */

export type AdPlatform = "google-ads" | "meta-ads";
export const PLATFORMS: readonly AdPlatform[] = ["google-ads", "meta-ads"];

/** What the business owner picks in the wizard (step 1). */
export type CopilotObjective = "awareness" | "traffic" | "engagement" | "lead_gen" | "sales";
export const COPILOT_OBJECTIVES: readonly CopilotObjective[] = ["awareness", "traffic", "engagement", "lead_gen", "sales"];

export interface CopyField {
  key: string;
  label: string;
  /** Hard maximum in characters, as the platform states it. null = the platform publishes none. */
  max: number | null;
  /** The platform's recommended length (upper end), when it gives one. */
  recommended: number | null;
  /** Lower end of a recommended range, when the platform gives a range (Meta primary text 50–150). */
  recommendedMin?: number;
  /** How many of this field one ad takes (e.g. 3–15 headlines). */
  minCount: number;
  maxCount: number;
  /** The official page the numbers were read from. */
  source: string;
}

export interface AdFormat {
  key: string;
  label: string;
  fields: readonly CopyField[];
}

export interface ChannelSpec {
  platform: AdPlatform;
  label: string;
  formats: readonly AdFormat[];
  /** Can an audience be built "like my customers" (lookalike / similar)? */
  lookalike: boolean;
  lookalikeSource: string;
}

const G_RSA = "https://support.google.com/google-ads/answer/7684791";             // About responsive search ads
const G_LIMITS = "https://developers.google.com/google-ads/api/docs/best-practices/system-limits";
const G_PMAX = "https://support.google.com/google-ads/answer/14528373";            // Text assets for Performance Max
const G_CHANNEL = "https://developers.google.com/google-ads/api/reference/rpc/latest/AdvertisingChannelTypeEnum.AdvertisingChannelType";
const G_SIMILAR = "https://ads-developers.googleblog.com/2022/11/announcing-deprecation-and-sunset-of.html";
const M_FEED = "https://www.facebook.com/business/ads-guide/update/image/facebook-feed/traffic";
const M_OBJECTIVE = "https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/";
const M_LOOKALIKE = "https://developers.facebook.com/docs/marketing-api/audiences/guides/lookalike-audiences/";

export const CHANNEL_SPECS: Record<AdPlatform, ChannelSpec> = {
  "google-ads": {
    platform: "google-ads",
    label: "Google Ads",
    formats: [
      {
        key: "search",
        label: "Search (responsive search ad)",
        fields: [
          // "minimum of 3 headlines, but you can enter up to 15" · "up to 30 characters" (G_RSA); 30 = LINE_TOO_WIDE (G_LIMITS)
          { key: "headline", label: "Headline", max: 30, recommended: null, minCount: 3, maxCount: 15, source: G_RSA },
          // "minimum of 2 descriptions, but you can enter up to 4" · "up to 90 characters each"
          { key: "description", label: "Description", max: 90, recommended: null, minCount: 2, maxCount: 4, source: G_RSA },
          // "the path fields support up to 15 each" (path1, path2 — optional)
          { key: "path", label: "Display path", max: 15, recommended: null, minCount: 0, maxCount: 2, source: G_LIMITS },
        ],
      },
      {
        key: "performance_max",
        label: "Performance Max",
        fields: [
          // 30 max, at least one 15 or less; 3–15 (11+ recommended)
          { key: "headline", label: "Headline", max: 30, recommended: null, minCount: 3, maxCount: 15, source: G_PMAX },
          // 90 max; 1–5
          { key: "long_headline", label: "Long headline", max: 90, recommended: null, minCount: 1, maxCount: 5, source: G_PMAX },
          // 90 max; 2–5
          { key: "description", label: "Description", max: 90, recommended: null, minCount: 2, maxCount: 5, source: G_PMAX },
          // 25 max; must match the domain or verified legal business name
          { key: "business_name", label: "Business name", max: 25, recommended: null, minCount: 1, maxCount: 1, source: G_PMAX },
        ],
      },
    ],
    lookalike: false, // Similar Audiences deprecated and sunset (Google Ads Developer Blog, 3 Nov 2022)
    lookalikeSource: G_SIMILAR,
  },
  "meta-ads": {
    platform: "meta-ads",
    label: "Meta (Facebook / Instagram)",
    formats: [
      {
        key: "feed_image",
        label: "Feed image ad",
        fields: [
          // Ads Guide "Text Recommendations": "Primary Text: 50-150 characters" — a recommendation, no max published
          { key: "primary_text", label: "Primary text", max: null, recommended: 150, recommendedMin: 50, minCount: 1, maxCount: 1, source: M_FEED },
          // "Headline: 27 characters" — a recommendation
          { key: "headline", label: "Headline", max: null, recommended: 27, minCount: 1, maxCount: 1, source: M_FEED },
        ],
      },
    ],
    lookalike: true, // "Target people most like your established customers" — /act_{id}/customaudiences
    lookalikeSource: M_LOOKALIKE,
  },
};

export function fieldSpec(platform: AdPlatform, format: string, field: string): CopyField | null {
  return CHANNEL_SPECS[platform].formats.find((f) => f.key === format)?.fields.find((x) => x.key === field) ?? null;
}

export interface FitResult {
  ok: boolean;
  length: number;
  /** Characters over the limit (0 when it fits). */
  over: number;
  limit: number | null;
  /** Which number was checked: the hard maximum, or (Meta) the recommended length. */
  kind: "max" | "recommended" | "none";
}

/**
 * Does this text fit the field? Counts characters as a person sees them (₹ and an emoji are
 * one each), after trimming the ends. Checks the hard max; when the platform gives none, the
 * recommended length — and says which, so the UI can word a recommendation as one.
 */
export function fitCheck(text: string, field: CopyField): FitResult {
  const length = [...text.trim()].length;
  const limit = field.max ?? field.recommended;
  const kind: FitResult["kind"] = field.max != null ? "max" : field.recommended != null ? "recommended" : "none";
  if (limit == null) return { ok: true, length, over: 0, limit: null, kind };
  const over = Math.max(0, length - limit);
  return { ok: over === 0, length, over, limit, kind };
}

export interface PlatformObjective {
  /** The platform's own value: Google AdvertisingChannelType, Meta campaign `objective`. */
  value: string;
  /** Which of our formats (CHANNEL_SPECS) the copy is written for. */
  format: string;
  source: string;
}

/*
 * The VALUES are the platforms' own (Google AdvertisingChannelType enum; Meta's six
 * OUTCOME_* campaign objectives — both read 25 Oct 2026, sources above). WHICH value each of
 * our objectives maps to is our default choice, not a platform rule.
 * Google awareness / engagement need Display, Video or Demand Gen copy specs we do not have
 * yet → null (the wizard does not offer Google for them) until a card adds those formats.
 */
const OBJECTIVES: Record<AdPlatform, Record<CopilotObjective, PlatformObjective | null>> = {
  "google-ads": {
    awareness: null,
    traffic: { value: "SEARCH", format: "search", source: G_CHANNEL },
    engagement: null,
    lead_gen: { value: "SEARCH", format: "search", source: G_CHANNEL },
    sales: { value: "PERFORMANCE_MAX", format: "performance_max", source: G_CHANNEL },
  },
  "meta-ads": {
    awareness: { value: "OUTCOME_AWARENESS", format: "feed_image", source: M_OBJECTIVE },
    traffic: { value: "OUTCOME_TRAFFIC", format: "feed_image", source: M_OBJECTIVE },
    engagement: { value: "OUTCOME_ENGAGEMENT", format: "feed_image", source: M_OBJECTIVE },
    lead_gen: { value: "OUTCOME_LEADS", format: "feed_image", source: M_OBJECTIVE },
    sales: { value: "OUTCOME_SALES", format: "feed_image", source: M_OBJECTIVE },
  },
};

export function objectiveFor(platform: AdPlatform, objective: CopilotObjective): PlatformObjective | null {
  return OBJECTIVES[platform][objective];
}
