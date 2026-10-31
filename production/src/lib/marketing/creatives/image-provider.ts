/**
 * R-2160 (G-ADS-AI, AI-04) — the image provider interface the marketing agent's Pixeo node uses.
 *
 * Plan snappy-painting-dragonfly §6: image generation sits behind ONE interface so the first
 * provider (Gemini Imagen, imagen-provider.ts) can be joined later by another (e.g. Flux via
 * Replicate) without touching the nodes. A provider only turns a prompt into raw image bytes;
 * sizing to the platform spec, the AI-generated label and storage are done once, in ad-image.ts,
 * so every provider's output ends up the same.
 *
 * Every provider MUST count each image against the company's monthly AI cap before it spends
 * anything (R-1877) and answer `cap` when the cap is used up.
 */

/** The two ad shapes the agent makes (feed square and story/reel). */
export const AD_IMAGE_RATIOS = ["1:1", "9:16"] as const;
export type AdImageRatio = (typeof AD_IMAGE_RATIOS)[number];

export interface ImageRequest {
  /** The company the image is for — its AI cap is charged. */
  tenantId: string;
  /** What to draw (already checked and trimmed by generateAdImage). */
  prompt: string;
  aspectRatio: AdImageRatio;
}

export type ImageFailureCode =
  /** The company's monthly AI cap is used up (route → 429). */
  | "cap"
  /** The provider is not set up (no key) (route → 503). */
  | "no_key"
  /** The provider's safety filter refused the prompt (route → 422). */
  | "blocked"
  /** Anything else — upstream error, timeout, storage (route → 502). */
  | "failed";

export type ImageResult =
  | { ok: true; bytes: Buffer; mimeType: string; model: string }
  | { ok: false; code: ImageFailureCode; message: string };

export interface ImageProvider {
  /** Short id saved with each image, e.g. "gemini-imagen". */
  readonly id: string;
  generate(req: ImageRequest): Promise<ImageResult>;
}
