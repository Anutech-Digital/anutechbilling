/**
 * R-2697 (G-SOCIAL): the AI makes one picture for a post and keeps it as a hidden photo on the
 * company's Facebook Page. Used by "Make picture with AI" and by Plan this week.
 *
 * - Picture: a Gemini image model on the company's Gemini key (lib/ai/gemini geminiImagenImage — AI cap first,
 *   timeout, breaker). Square 1:1, works for Facebook and Instagram feed posts.
 * - Kept on the Page unpublished (never shown on the Page); the post stores pagePhotoRef(<id>).
 */
import "server-only";
import { geminiImagenImage, resolveGeminiConfig } from "@/lib/ai/gemini";
import { readFacebookPage } from "@/lib/integrations/facebook-page";
import { picturePrompt } from "./social-autopilot";
import { pagePhotoLinks, uploadPagePhoto } from "./social-content";
import type { createAdminClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * R-2697: the picture model — env SOCIAL_IMAGE_MODEL, else Gemini's own image model, which keys
 * without Imagen still have (measured 12 Nov 2026: the local key lists no imagen-* model at all).
 */
export function socialImageModel(): string {
  return process.env.SOCIAL_IMAGE_MODEL?.trim() || "gemini-2.5-flash-image";
}

/** The AI-cap feature name a post picture is counted under (Settings → AI usage). */
export const SOCIAL_PICTURE_FEATURE = "marketing/social-picture";

export type PictureResult =
  | { ok: true; mediaUrl: string; previewUrl: string | null }
  | { ok: false; message: string; status: number };

/** R-2729: `page` = the Page the post goes out on (its photos keep the picture); the main Page when omitted. */
export async function makePostPicture(admin: Admin, tenantId: string, post: { topic: string; caption: string }, page?: { pageId: string | null; pageToken: string | null }): Promise<PictureResult> {
  if (!post.topic.trim() && !post.caption.trim()) return { ok: false, message: "Write the post (or its topic) first, then make the picture.", status: 400 };
  const connection = page?.pageToken ? page : await readFacebookPage(admin, tenantId);
  if (!connection.pageId || !connection.pageToken) return { ok: false, message: "Connect your Facebook Page first (Marketing Hub → Facebook Page). The picture is kept in its photos.", status: 409 };
  const ai = await resolveGeminiConfig(admin, tenantId);
  const image = await geminiImagenImage({
    apiKey: ai.geminiKey, model: socialImageModel(), prompt: picturePrompt(post.topic, post.caption), aspectRatio: "1:1",
    tenantId, label: SOCIAL_PICTURE_FEATURE,
  });
  if (!image.ok) return { ok: false, message: image.message, status: image.code === "cap" ? 429 : image.code === "no_key" ? 409 : image.code === "blocked" ? 422 : 502 };
  let mediaUrl: string;
  try {
    mediaUrl = await uploadPagePhoto(connection.pageId, connection.pageToken, image.bytes, image.mimeType);
  } catch (e) {
    console.error("[social-picture] page upload failed", e instanceof Error ? e.message : "unknown");
    return { ok: false, message: `The picture was made but Facebook did not keep it: ${e instanceof Error ? e.message : "unknown error"}. Reconnect the Facebook Page and try again.`, status: 502 };
  }
  const previewUrl = (await pagePhotoLinks([mediaUrl], connection.pageToken)).get(mediaUrl) ?? null;
  return { ok: true, mediaUrl, previewUrl };
}
