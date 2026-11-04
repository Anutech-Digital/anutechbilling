/**
 * R-2160 (G-ADS-AI, AI-04) — the first image provider: Google Imagen on the Gemini API key.
 *
 * Key: the company's own Gemini key (Settings → Integrations → AI) wins over the server's
 * GEMINI_API_KEY (resolveGeminiConfig, read with the signed-in session's client). When the text
 * AI runs on Claude the Gemini key is still used here — Claude makes no images.
 * Model: env IMAGEN_MODEL, else DEFAULT_IMAGEN_MODEL. The call itself is lib/ai/gemini.ts
 * geminiImagenImage — the one Gemini door (AI cap before the call, timeout, breaker, readable
 * failures).
 */
import "server-only";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_IMAGEN_MODEL, geminiImagenImage, resolveGeminiConfig } from "@/lib/ai/gemini";
import type { ImageProvider } from "./image-provider";

/** The AI-cap feature name an ad image is counted under (Settings → AI usage). */
export const AD_IMAGE_FEATURE = "marketing/ad-image";

export function imagenModel(): string {
  return process.env.IMAGEN_MODEL?.trim() || DEFAULT_IMAGEN_MODEL;
}

export function imagenProvider(apiKey: string, model: string = imagenModel()): ImageProvider {
  return {
    id: "gemini-imagen",
    generate: (req) => geminiImagenImage({
      apiKey, model, prompt: req.prompt, aspectRatio: req.aspectRatio, tenantId: req.tenantId, label: AD_IMAGE_FEATURE,
    }),
  };
}

/** The provider for this company, or a sentence saying what to set up. */
export async function resolveImageProvider(
  tenantId: string,
): Promise<{ provider: ImageProvider } | { provider: null; message: string }> {
  const cfg = await resolveGeminiConfig(createClient(), tenantId);
  if (!cfg.geminiKey) {
    return {
      provider: null,
      message: "Image generation needs a Gemini API key with billing on. Add it in Settings → Integrations → AI, or ask Anutech support.",
    };
  }
  return { provider: imagenProvider(cfg.geminiKey) };
}
