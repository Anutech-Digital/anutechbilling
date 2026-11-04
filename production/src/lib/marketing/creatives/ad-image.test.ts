/**
 * R-2160 (G-ADS-AI, AI-04) — the finished ad image: exact platform size, PNG, AI-generated label,
 * stored at {tenant}/{plan}/… in the private ad-creatives bucket. Provider and store are fakes.
 */
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  AD_IMAGE_SPECS, AI_GENERATED_LABEL, AI_SOURCE_TYPE, adCreativePath, finishAdImage, generateAdImage,
} from "./ad-image";
import type { ImageProvider, ImageResult } from "./image-provider";

const T1 = "11111111-1111-4111-8111-111111111111";
const PLAN = "6f1c2a52-6b8e-4b7a-9a59-0f5e8f3f0a11";

/** What Imagen really returns at 1K: 1:1 = 1024x1024, 9:16 = 768x1408 (not exactly 9:16). */
const raw = (width: number, height: number, format: "png" | "jpeg" = "png") =>
  sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 200 } } })[format]().toBuffer();

const fakeProvider = (result: (ratio: string) => Promise<ImageResult>): ImageProvider & { calls: string[] } => {
  const calls: string[] = [];
  return {
    id: "fake", calls,
    async generate(req) { calls.push(req.aspectRatio); return result(req.aspectRatio); },
  };
};
const fakeStore = () => {
  const saved: Array<{ path: string; bytes: Buffer; contentType: string }> = [];
  return { saved, upload: vi.fn(async (path: string, bytes: Buffer, contentType: string) => { saved.push({ path, bytes, contentType }); return { error: null }; }) };
};

describe("platform sizes", () => {
  it("1:1 is 1080x1080 and 9:16 is 1080x1920", () => {
    expect(AD_IMAGE_SPECS["1:1"]).toMatchObject({ width: 1080, height: 1080 });
    expect(AD_IMAGE_SPECS["9:16"]).toMatchObject({ width: 1080, height: 1920 });
  });
});

describe("finishAdImage", () => {
  it("9:16 from Imagen's 768x1408 → exactly 1080x1920 PNG with the AI label in its XMP", async () => {
    const out = await finishAdImage(await raw(768, 1408), "9:16");
    const m = await sharp(out.bytes).metadata();
    expect([m.width, m.height, m.format]).toEqual([1080, 1920, "png"]);
    expect(out).toMatchObject({ width: 1080, height: 1920, mimeType: "image/png" });
    expect(String(m.xmp)).toContain(AI_SOURCE_TYPE);
    expect(AI_SOURCE_TYPE).toBe("http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia");
  });

  it("1:1 from a 1024 JPEG → exactly 1080x1080 PNG", async () => {
    const out = await finishAdImage(await raw(1024, 1024, "jpeg"), "1:1");
    const m = await sharp(out.bytes).metadata();
    expect([m.width, m.height, m.format]).toEqual([1080, 1080, "png"]);
  });

  it("bytes that are not an image are refused", async () => {
    await expect(finishAdImage(Buffer.from("<svg onload=alert(1)>"), "1:1")).rejects.toThrow(/not an image/i);
  });
});

describe("adCreativePath", () => {
  it("{tenant}/{plan}/ai-{id}-{ratio}.png — folder 1 is the company (bucket RLS)", () => {
    const p = adCreativePath(T1, PLAN, "9:16", "abcd1234-0000-4000-8000-000000000001");
    expect(p).toBe(`${T1}/${PLAN}/ai-abcd1234-0000-4000-8000-000000000001-9x16.png`);
  });
  it("refuses anything that is not a uuid (no ../ into another folder)", () => {
    expect(() => adCreativePath("../x", PLAN, "1:1")).toThrow();
    expect(() => adCreativePath(T1, `${PLAN}/../..`, "1:1")).toThrow();
  });
});

describe("generateAdImage", () => {
  it("provider → exact size → label → stored under the company's folder; returns what Pixeo needs", async () => {
    const provider = fakeProvider(async () => ({ ok: true, bytes: await raw(768, 1408), mimeType: "image/png", model: "imagen-test" }));
    const store = fakeStore();
    const r = await generateAdImage({ tenantId: T1, planId: PLAN, prompt: "  Google Workspace for Delhi offices  ", aspectRatio: "9:16", provider, store });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.image).toMatchObject({
      aspectRatio: "9:16", width: 1080, height: 1920, mimeType: "image/png",
      aiGenerated: true, label: AI_GENERATED_LABEL, provider: "fake", model: "imagen-test",
    });
    expect(r.image.storagePath.startsWith(`${T1}/${PLAN}/ai-`)).toBe(true);
    expect(r.image.storagePath.endsWith("-9x16.png")).toBe(true);
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toMatchObject({ path: r.image.storagePath, contentType: "image/png" });
    expect(r.image.sizeBytes).toBe(store.saved[0].bytes.length);
    expect(AI_GENERATED_LABEL).toBe("AI-generated");
  });

  it("the provider's refusal (e.g. AI cap) is passed on and nothing is stored", async () => {
    const provider = fakeProvider(async () => ({ ok: false, code: "cap", message: "Your company has used this month's AI limit." }));
    const store = fakeStore();
    const r = await generateAdImage({ tenantId: T1, planId: PLAN, prompt: "x ad", aspectRatio: "1:1", provider, store });
    expect(r).toEqual({ ok: false, code: "cap", message: "Your company has used this month's AI limit." });
    expect(store.upload).not.toHaveBeenCalled();
  });

  it("an empty or huge prompt never reaches the provider", async () => {
    const provider = fakeProvider(async () => { throw new Error("must not be called"); });
    const store = fakeStore();
    expect(await generateAdImage({ tenantId: T1, planId: PLAN, prompt: "   ", aspectRatio: "1:1", provider, store })).toMatchObject({ ok: false, code: "bad_prompt" });
    expect(await generateAdImage({ tenantId: T1, planId: PLAN, prompt: "x".repeat(2001), aspectRatio: "1:1", provider, store })).toMatchObject({ ok: false, code: "bad_prompt" });
    expect(provider.calls).toEqual([]);
  });

  it("a storage failure is reported, not swallowed", async () => {
    const provider = fakeProvider(async () => ({ ok: true, bytes: await raw(1024, 1024), mimeType: "image/png", model: "m" }));
    const store = { upload: vi.fn(async () => ({ error: "bucket not found" })) };
    const r = await generateAdImage({ tenantId: T1, planId: PLAN, prompt: "ad", aspectRatio: "1:1", provider, store });
    expect(r).toMatchObject({ ok: false, code: "failed" });
  });
});
