/**
 * R-830 (Abhishek, staging, 10 Oct 2026): images in the AI Help chat.
 *  - "no upload button in Ask" → an attach button, paste and drag-drop;
 *  - "only one image at a time" → up to HELP_MAX_IMAGES per message;
 *  - "chat screenshots are not on the AI's bug draft" → the draft carries the chat's images and
 *    they are filed with it, through the same feedback screenshots path as Report a problem.
 *
 * Pure rules only (limits, messages, which images a draft carries), so they are unit-tested;
 * the panel (components/shared/ai-help.tsx) and the route (api/ai/help) both use them.
 */

/** Most images on one message, and on one filed report. */
export const HELP_MAX_IMAGES = 5;
/** Largest image file accepted from the PC (before it is shrunk to a JPEG for sending). */
export const HELP_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const HELP_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** For <input accept>. */
export const HELP_IMAGE_ACCEPT = HELP_IMAGE_TYPES.join(",");

export const HELP_IMAGE_ERRORS = {
  tooMany: `Max ${HELP_MAX_IMAGES} images`,
  tooLarge: "Image too large — max 5 MB",
  wrongType: "Only PNG, JPG or WebP images",
} as const;

export interface ImageFileLike { type: string; size: number; name?: string }

/**
 * Which of the dropped / pasted / chosen files may join the `have` images already waiting.
 * Wrong type and too large are refused one by one; past the limit the rest are refused with
 * one "Max 5 images". Each distinct error is listed once, in the order met.
 */
export function pickHelpImages<T extends ImageFileLike>(have: number, files: readonly T[]): { accepted: T[]; errors: string[] } {
  const accepted: T[] = [];
  const errors = new Set<string>();
  for (const f of files) {
    if (!(HELP_IMAGE_TYPES as readonly string[]).includes(f.type)) { errors.add(HELP_IMAGE_ERRORS.wrongType); continue; }
    if (f.size > HELP_MAX_IMAGE_BYTES) { errors.add(HELP_IMAGE_ERRORS.tooLarge); continue; }
    if (have + accepted.length >= HELP_MAX_IMAGES) { errors.add(HELP_IMAGE_ERRORS.tooMany); continue; }
    accepted.push(f);
  }
  return { accepted, errors: [...errors] };
}

/**
 * The images a bug draft carries: every image the person sent in this chat up to the draft,
 * oldest first, duplicates dropped, at most HELP_MAX_IMAGES (the newest ones win — they are
 * the ones the chat was about when the draft was written).
 */
export function draftImages(messages: readonly { role: string; images?: readonly string[] }[]): string[] {
  const seen = new Set<string>();
  const all: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const img of m.images ?? []) {
      if (!img || seen.has(img)) continue;
      seen.add(img);
      all.push(img);
    }
  }
  return all.slice(-HELP_MAX_IMAGES);
}

/** The screenshots a filed AI-chat report sends to useSubmitFeedback (same shape as Report a problem). */
export function draftScreenshots(images: readonly string[]): { name: string; dataUrl: string }[] {
  return images.slice(0, HELP_MAX_IMAGES).map((dataUrl, n) => ({ name: `ai_help_screen_${n + 1}.jpg`, dataUrl }));
}
