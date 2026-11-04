/**
 * R-2160 (G-ADS-AI, AI-04) — one finished ad image: provider → exact platform size → AI label →
 * private `ad-creatives` bucket (migration 20261030122442_r2160_ad_creatives).
 *
 *  - Size: 1:1 = 1080x1080, 9:16 = 1080x1920 (plan §6, Meta/Google feed + story specs). Imagen
 *    returns 1024x1024 and 768x1408 (not exactly 9:16), so the image is cover-cropped to the
 *    exact size here — every provider's output ends up the same.
 *  - Label: every image says it is AI-made, in the file itself — XMP
 *    Iptc4xmpExt:DigitalSourceType = trainedAlgorithmicMedia, the IPTC field Meta and Google read
 *    for their "AI info" disclosure — and on the result (`aiGenerated`, `label`) for the review
 *    screen. The file name starts with "ai-" too.
 *  - Path: {tenantId}/{planId}/ai-{uuid}-{1x1|9x16}.png. Folder 1 = the company; the bucket's
 *    read rule (owner/marketing of that company) depends on it. Only uuids go into the path.
 *  - Re-encoding through sharp also drops anything else the provider put in the bytes; input
 *    that is not a png/jpeg/webp raster is refused.
 */
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { AdImageRatio, ImageFailureCode, ImageProvider } from "./image-provider";

export const AD_IMAGE_SPECS: Record<AdImageRatio, { width: number; height: number; suffix: string }> = {
  "1:1": { width: 1080, height: 1080, suffix: "1x1" },
  "9:16": { width: 1080, height: 1920, suffix: "9x16" },
};

export const AI_GENERATED_LABEL = "AI-generated";
export const AI_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
export const AD_CREATIVES_BUCKET = "ad-creatives";
export const MAX_IMAGE_PROMPT = 2000;

const AI_XMP =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" ' +
  `Iptc4xmpExt:DigitalSourceType="${AI_SOURCE_TYPE}"/>` +
  "</rdf:RDF></x:xmpmeta>";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RASTER = new Set(["png", "jpeg", "webp"]);

export interface FinishedImage {
  bytes: Buffer;
  width: number;
  height: number;
  mimeType: "image/png";
}

/** Exact platform size, PNG, AI label in XMP. Throws "not an image" for anything else. */
export async function finishAdImage(input: Buffer, ratio: AdImageRatio): Promise<FinishedImage> {
  const spec = AD_IMAGE_SPECS[ratio];
  let format: string | undefined;
  try {
    format = (await sharp(input, { limitInputPixels: 40_000_000 }).metadata()).format;
  } catch {
    format = undefined;
  }
  if (!format || !RASTER.has(format)) throw new Error("The provider's answer is not an image (png, jpeg or webp).");

  const bytes = await sharp(input, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(spec.width, spec.height, { fit: "cover", position: "attention" })
    .withXmp(AI_XMP)
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { bytes, width: spec.width, height: spec.height, mimeType: "image/png" };
}

/** {tenant}/{plan}/ai-{id}-{1x1|9x16}.png — only uuids, so nothing can climb out of the folder. */
export function adCreativePath(tenantId: string, planId: string, ratio: AdImageRatio, id: string = randomUUID()): string {
  for (const v of [tenantId, planId, id]) {
    if (!UUID.test(v)) throw new Error("adCreativePath: tenant, plan and image id must be uuids.");
  }
  return `${tenantId}/${planId}/ai-${id.toLowerCase()}-${AD_IMAGE_SPECS[ratio].suffix}.png`;
}

/** Where the finished bytes go (the real one is the private bucket, storage.ts). */
export interface CreativeStore {
  upload(path: string, bytes: Buffer, contentType: string): Promise<{ error: string | null }>;
}

export interface AdImage {
  storagePath: string;
  aspectRatio: AdImageRatio;
  width: number;
  height: number;
  mimeType: "image/png";
  sizeBytes: number;
  aiGenerated: true;
  label: typeof AI_GENERATED_LABEL;
  provider: string;
  model: string;
}

export type AdImageResult =
  | { ok: true; image: AdImage }
  | { ok: false; code: ImageFailureCode | "bad_prompt"; message: string };

/**
 * Make one ad image for a plan and store it. Never throws: every failure is a code + a sentence.
 * The caller has already checked the person (owner/marketing) and that the plan is theirs.
 */
export async function generateAdImage(args: {
  tenantId: string;
  planId: string;
  prompt: string;
  aspectRatio: AdImageRatio;
  provider: ImageProvider;
  store: CreativeStore;
}): Promise<AdImageResult> {
  const prompt = args.prompt.trim();
  if (!prompt) return { ok: false, code: "bad_prompt", message: "Describe the image first." };
  if (prompt.length > MAX_IMAGE_PROMPT) {
    return { ok: false, code: "bad_prompt", message: `Keep the image description under ${MAX_IMAGE_PROMPT} characters.` };
  }
  let path: string;
  try {
    path = adCreativePath(args.tenantId, args.planId, args.aspectRatio);
  } catch (e) {
    return { ok: false, code: "failed", message: (e as Error).message };
  }

  const made = await args.provider.generate({ tenantId: args.tenantId, prompt, aspectRatio: args.aspectRatio });
  if (!made.ok) return { ok: false, code: made.code, message: made.message };

  let finished: FinishedImage;
  try {
    finished = await finishAdImage(made.bytes, args.aspectRatio);
  } catch (e) {
    return { ok: false, code: "failed", message: (e as Error).message };
  }

  const up = await args.store.upload(path, finished.bytes, finished.mimeType).catch((e: Error) => ({ error: e?.message ?? "upload failed" }));
  if (up.error) {
    console.error(`[marketing/ad-image] could not store ${path}:`, up.error);
    return { ok: false, code: "failed", message: "The image was made but could not be saved. Try again." };
  }

  return {
    ok: true,
    image: {
      storagePath: path,
      aspectRatio: args.aspectRatio,
      width: finished.width,
      height: finished.height,
      mimeType: finished.mimeType,
      sizeBytes: finished.bytes.length,
      aiGenerated: true,
      label: AI_GENERATED_LABEL,
      provider: args.provider.id,
      model: made.model,
    },
  };
}
