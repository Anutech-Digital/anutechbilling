/**
 * POST /api/marketing/creatives/image — R-2160 (G-ADS-AI, AI-04): make the ad images for a saved
 * co-pilot plan with the image provider (Gemini Imagen), in the platform sizes, labelled
 * AI-generated, stored in the private ad-creatives bucket. The Pixeo node (R-2161) calls the same
 * library (lib/marketing/creatives); this route is for the review screen's "make images" and for
 * checking the provider on localhost.
 *
 * Body: { planId, prompt, ratios? } — ratios default to both ["1:1", "9:16"].
 * Who: owner and marketing of the plan's company (same as the agent routes and the bucket's
 * read rule). Each image is one AI call against the company's monthly cap (R-1877).
 *
 * 401 no session · 400 bad body · 403 not owner/marketing · 404 plan not in this company ·
 * 429 AI cap used up · 503 no Gemini key · 422 safety filter · 502 provider/storage failed ·
 * 200 { images: [{ aspectRatio, width, height, storagePath, url, aiGenerated, label, … }], failed: [] }
 * (200 when at least one image was made; `failed` lists the others with their reason).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { AD_IMAGE_RATIOS, type AdImageRatio, type ImageFailureCode } from "@/lib/marketing/creatives/image-provider";
import { MAX_IMAGE_PROMPT, generateAdImage, type AdImage } from "@/lib/marketing/creatives/ad-image";
import { resolveImageProvider } from "@/lib/marketing/creatives/imagen-provider";
import { adCreativeStore, signedCreativeUrl } from "@/lib/marketing/creatives/storage";
import {
  AGENT_ROLES, PlanIdSchema, activeRole, agentForbidden, badRequest, planNotFound, planSeed, signIn,
} from "../../agent/agent-io";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;

const Body = z.object({
  planId: PlanIdSchema,
  prompt: z.string().trim().min(1, "Describe the image first.").max(MAX_IMAGE_PROMPT, `Keep the image description under ${MAX_IMAGE_PROMPT} characters.`),
  ratios: z.array(z.enum(AD_IMAGE_RATIOS, { message: "Image size must be 1:1 or 9:16." })).min(1).max(2).optional(),
});

const STATUS: Record<ImageFailureCode | "bad_prompt", number> = { cap: 429, no_key: 503, blocked: 422, failed: 502, bad_prompt: 400 };

export async function POST(req: Request) {
  const session = await getTenantSession();
  if (!session) return signIn();

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest(parsed.error);
  const { planId, prompt } = parsed.data;
  const ratios: AdImageRatio[] = [...new Set(parsed.data.ratios ?? AD_IMAGE_RATIOS)];

  const ctx = await withTenant(session, async (tx) => {
    const role = await activeRole(tx, session.userId);
    if (!role || !AGENT_ROLES.includes(role)) return "forbidden" as const;
    return (await planSeed(tx, session.tenantId, planId)) ? "ok" as const : "missing" as const;
  });
  if (ctx === "forbidden") return agentForbidden();
  if (ctx === "missing") return planNotFound();

  const resolved = await resolveImageProvider(session.tenantId);
  if (!resolved.provider) return NextResponse.json({ error: resolved.message }, { status: 503 });

  const store = adCreativeStore();
  const images: Array<AdImage & { url: string | null }> = [];
  const failed: Array<{ aspectRatio: AdImageRatio; code: string; message: string }> = [];
  for (const aspectRatio of ratios) {
    const r = await generateAdImage({ tenantId: session.tenantId, planId, prompt, aspectRatio, provider: resolved.provider, store });
    if (r.ok) {
      images.push({ ...r.image, url: await signedCreativeUrl(r.image.storagePath) });
    } else {
      failed.push({ aspectRatio, code: r.code, message: r.message });
      /* Cap used up or no key: the next size would fail the same way — do not ask again. */
      if (r.code === "cap" || r.code === "no_key") break;
    }
  }

  if (images.length === 0) {
    const first = failed[0];
    return NextResponse.json({ error: first?.message ?? "No image was made.", failed }, { status: first ? STATUS[first.code as keyof typeof STATUS] ?? 502 : 502 });
  }
  return NextResponse.json({ images, failed }, { status: 200 });
}
