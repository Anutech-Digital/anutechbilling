/**
 * R-2160 (G-ADS-AI, AI-04) — the private `ad-creatives` bucket, server side.
 *
 * Writes go through the service key ONLY: the bucket has no upload rule for signed-in users
 * (migration 20261030110738_r2160_ad_creatives), so a generated image is stored after the
 * route's own checks (owner/marketing, plan of this company, AI cap). Links are short-lived
 * signed URLs — the bucket is never public.
 */
import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import { AD_CREATIVES_BUCKET, type CreativeStore } from "./ad-image";

/** How long a preview link works (seconds). */
export const CREATIVE_LINK_TTL = 15 * 60;

export function adCreativeStore(): CreativeStore {
  return {
    async upload(path, bytes, contentType) {
      const { error } = await createAdminClient().storage.from(AD_CREATIVES_BUCKET)
        .upload(path, bytes, { contentType, upsert: false, cacheControl: "private, max-age=0" });
      return { error: error ? error.message : null };
    },
  };
}

/** A signed link to one creative, or null when it cannot be made. Caller checks the person first. */
export async function signedCreativeUrl(path: string, ttl: number = CREATIVE_LINK_TTL): Promise<string | null> {
  const { data, error } = await createAdminClient().storage.from(AD_CREATIVES_BUCKET).createSignedUrl(path, ttl);
  if (error || !data?.signedUrl) {
    console.error(`[marketing/creatives] could not sign ${path}:`, error?.message ?? "no url");
    return null;
  }
  return data.signedUrl;
}
