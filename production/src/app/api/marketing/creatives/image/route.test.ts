/**
 * R-2160 (G-ADS-AI, AI-04) — POST /api/marketing/creatives/image.
 * DB is a fake behind withTenant; the image provider and the bucket are fakes (no real AI call,
 * no real upload). The bucket's own rules are proven in supabase/tests/r2160_ad_creatives.test.sql.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { ImageResult } from "@/lib/marketing/creatives/image-provider";

const PLAN = "6f1c2a52-6b8e-4b7a-9a59-0f5e8f3f0a11";
const OTHER_PLAN = "7a2d3b63-7c9f-4c8b-8b6a-1a6f9a4a1b22";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  session: null as { userId: string; tenantId: string; aal: string } | null,
  role: "owner" as string | null,
  plans: [] as Array<{ id: string; tenant_id: string; marketing_campaign_id: string | null; prompt: string }>,
  provider: null as null | { id: string; generate: (r: { aspectRatio: string; tenantId: string }) => Promise<ImageResult> },
  providerMessage: "",
  uploads: [] as string[],
  asked: [] as Array<{ aspectRatio: string; tenantId: string }>,
}));

vi.mock("@/server/auth/session", () => ({ getTenantSession: async () => h.session }));
vi.mock("@/server/db", () => ({
  withTenant: async (_s: unknown, fn: (tx: unknown) => unknown) => fn({
    public_users: { findUnique: async () => (h.role ? { role: h.role, is_active: true } : null) },
    ad_plans: {
      findFirst: async ({ where }: { where: { id: string; tenant_id: string } }) =>
        h.plans.find((p) => p.id === where.id && p.tenant_id === where.tenant_id) ?? null,
    },
  }),
}));
/* agent-io (shared role gate) also builds the agent graph; its DB store is not used here. */
vi.mock("@/lib/marketing/agent/prisma-store", () => ({ prismaCheckpointStore: () => { throw new Error("not used"); } }));
vi.mock("@/lib/marketing/creatives/imagen-provider", () => ({
  resolveImageProvider: async () => (h.provider ? { provider: h.provider } : { provider: null, message: h.providerMessage }),
}));
vi.mock("@/lib/marketing/creatives/storage", () => ({
  adCreativeStore: () => ({ upload: async (path: string) => { h.uploads.push(path); return { error: null }; } }),
  signedCreativeUrl: async (path: string) => `/storage/v1/object/sign/ad-creatives/${path}?token=t`,
}));

import { POST } from "./route";

const post = (body: unknown) => POST(new Request("https://example.invalid/api/marketing/creatives/image", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));

const png = (w: number, hgt: number) => sharp({ create: { width: w, height: hgt, channels: 3, background: "#123456" } }).png().toBuffer();

beforeEach(() => {
  h.session = { userId: "aaaaaaaa-0000-4000-8000-000000000001", tenantId: T1, aal: "aal1" };
  h.role = "marketing";
  h.uploads = [];
  h.asked = [];
  h.providerMessage = "";
  h.plans = [
    { id: PLAN, tenant_id: T1, marketing_campaign_id: null, prompt: "Google Workspace in Delhi" },
    { id: OTHER_PLAN, tenant_id: T2, marketing_campaign_id: null, prompt: "Other company's plan" },
  ];
  h.provider = {
    id: "gemini-imagen",
    async generate(r) {
      h.asked.push(r);
      return { ok: true, bytes: await png(r.aspectRatio === "1:1" ? 1024 : 768, r.aspectRatio === "1:1" ? 1024 : 1408), mimeType: "image/png", model: "imagen-4.0-generate-001" };
    },
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("owner's path: one prompt → 1:1 and 9:16 images in the private bucket", () => {
  it("marketing gets both sizes, labelled AI-generated, with a short-lived link", async () => {
    const res = await post({ planId: PLAN, prompt: "Bright office team using Google Workspace, Delhi skyline" });
    expect(res.status).toBe(200);
    const { images, failed } = await res.json();
    expect(failed).toEqual([]);
    expect(images.map((i: { aspectRatio: string }) => i.aspectRatio)).toEqual(["1:1", "9:16"]);
    expect(images[0]).toMatchObject({ width: 1080, height: 1080, aiGenerated: true, label: "AI-generated" });
    expect(images[1]).toMatchObject({ width: 1080, height: 1920, aiGenerated: true, label: "AI-generated" });
    for (const i of images) {
      expect(i.storagePath.startsWith(`${T1}/${PLAN}/`)).toBe(true);
      expect(i.url).toContain(i.storagePath);
    }
    expect(h.uploads).toHaveLength(2);
    expect(h.asked.every((a) => a.tenantId === T1)).toBe(true);
  });

  it("one ratio only when asked", async () => {
    const { images } = await (await post({ planId: PLAN, prompt: "ad", ratios: ["9:16"] })).json();
    expect(images.map((i: { aspectRatio: string }) => i.aspectRatio)).toEqual(["9:16"]);
  });
});

describe("refusals", () => {
  it("401 without a session", async () => {
    h.session = null;
    expect((await post({ planId: PLAN, prompt: "ad" })).status).toBe(401);
  });
  it("403 for manager / sales (owner and marketing only)", async () => {
    for (const role of ["manager", "sales", "personal"]) {
      h.role = role;
      expect((await post({ planId: PLAN, prompt: "ad" })).status).toBe(403);
    }
    expect(h.asked).toEqual([]);
  });
  it("404 for another company's plan or a made-up id — nothing generated", async () => {
    expect((await post({ planId: OTHER_PLAN, prompt: "ad" })).status).toBe(404);
    expect((await post({ planId: "3b1f0c11-1111-4111-8111-999999999999", prompt: "ad" })).status).toBe(404);
    expect(h.asked).toEqual([]);
  });
  it("400 for a bad plan id, empty prompt or unknown ratio", async () => {
    expect((await post({ planId: "abc", prompt: "ad" })).status).toBe(400);
    expect((await post({ planId: PLAN, prompt: "  " })).status).toBe(400);
    expect((await post({ planId: PLAN, prompt: "ad", ratios: ["4:5"] })).status).toBe(400);
  });
  it("429 with the cap sentence when the company's AI limit is used up", async () => {
    h.provider = { id: "gemini-imagen", generate: async () => ({ ok: false, code: "cap", message: "Your company has used this month's AI limit (5 of 5 AI calls)." }) };
    const res = await post({ planId: PLAN, prompt: "ad" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/AI limit/);
    expect(h.uploads).toEqual([]);
  });
  it("503 with a clear sentence when no Gemini key is set up", async () => {
    h.provider = null;
    h.providerMessage = "Image generation needs a Gemini API key.";
    const res = await post({ planId: PLAN, prompt: "ad" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/Gemini API key/);
  });
});
