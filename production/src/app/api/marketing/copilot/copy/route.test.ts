/**
 * R-1876 — POST /api/marketing/copilot/copy. The AI is MOCKED (geminiJson); no real AI call.
 * Done-when: Google 15 headlines ≤30 + 4 descriptions ≤90, Meta primary text inside Meta's
 * recommended length; over-limit copy is never returned as valid; no key → stub; cap → 429.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: { userId: "u1", tenantId: "t1", aal: "aal1" } as { userId: string; tenantId: string; aal: string } | null,
  role: "marketing" as string | null,
  plan: null as null | { tone: string | null; language: string; objective: string; platforms: string[]; item_id: string | null },
  item: null as null | { name: string },
  apiKey: "sk-ant-test-key-1234567890" as string | null,
  gemini: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ getTenantSession: async () => h.session }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({}) }));
vi.mock("@/server/db", () => ({
  withTenant: async (_s: unknown, fn: (tx: unknown) => unknown) => fn({
    public_users: { findUnique: async () => (h.role ? { role: h.role, is_active: true } : null) },
    tenants: { findUnique: async () => ({ name: "Anutech Digital" }) },
    ad_plans: { findFirst: async () => h.plan },
    items: { findFirst: async () => h.item },
  }),
}));
vi.mock("@/lib/ai/gemini", () => ({
  resolveGeminiConfig: async (_c: unknown, tenantId: string) => ({ apiKey: h.apiKey, model: "claude-test", tenantId }),
  geminiJson: h.gemini,
}));

import { POST } from "./route";

const call = (body: Record<string, unknown>) =>
  POST(new Request("https://example.invalid/api/marketing/copilot/copy", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

const BASE = { objective: "lead_gen", platforms: ["google-ads", "meta-ads"], brief: "Diwali offer for Delhi SMEs", product: "Google Workspace" };

const headlines = [
  ...Array.from({ length: 14 }, (_, i) => `Workspace headline ${i + 1}`),          // ≤ 30
  "Move your whole office email to Google Workspace today",                         // 54 → shorten
  "workspace HEADLINE 1",                                                            // duplicate
];
const aiCopy = {
  "google-ads": {
    search: {
      headline: headlines,
      description: [
        "Google Workspace set up by our own team, with migration and local support.",
        "Tell us your team size and we suggest the right Workspace plan for you.",
        "Diwali offer for Delhi SMEs — talk to us about moving email to Workspace.",
        "Simple onboarding, clear billing and a team that answers when you call us.",
      ],
      path: ["workspace", "diwali"],
    },
  },
  "meta-ads": {
    feed_image: {
      primary_text: ["This Diwali, move your office email to Google Workspace. Setup, migration and support by our own Delhi team — message us."],
      headline: ["Workspace for Diwali"],
    },
  },
};

beforeEach(() => {
  h.session = { userId: "u1", tenantId: "t1", aal: "aal1" };
  h.role = "marketing";
  h.plan = null;
  h.item = null;
  h.apiKey = "sk-ant-test-key-1234567890";
  h.gemini.mockReset();
});

function field(body: { fields: Array<{ platform: string; field: string; lines: Array<{ text: string; length: number; ok: boolean; limit: number | null }>; dropped: Array<{ text: string; reason: string }> }> }, platform: string, f: string) {
  const r = body.fields.find((x) => x.platform === platform && x.field === f);
  if (!r) throw new Error(`no ${platform}.${f}`);
  return r;
}

describe("POST /api/marketing/copilot/copy — who", () => {
  it("401 without a company session (fail-closed)", async () => {
    h.session = null;
    expect((await call(BASE)).status).toBe(401);
    expect(h.gemini).not.toHaveBeenCalled();
  });

  it("403 for sales — marketing, owner and manager only", async () => {
    h.role = "sales";
    const r = await call(BASE);
    expect(r.status).toBe(403);
    expect(h.gemini).not.toHaveBeenCalled();
  });

  it("403 when the login has no user row", async () => {
    h.role = null;
    expect((await call(BASE)).status).toBe(403);
  });

  it("400 without platforms", async () => {
    expect((await call({ ...BASE, platforms: [] })).status).toBe(400);
  });

  it("404 for a plan that is not this company's", async () => {
    expect((await call({ ...BASE, planId: "6f1c1d1e-0000-4000-8000-000000000001" })).status).toBe(404);
  });
});

describe("POST /api/marketing/copilot/copy — copy inside the limits", () => {
  it("Google: 15 unique headlines ≤30, 4 descriptions ≤90; Meta primary inside 150; one shorten retry", async () => {
    h.gemini
      .mockResolvedValueOnce(aiCopy)
      .mockResolvedValueOnce({ items: [{ id: "google-ads.search.headline#14", text: "Office email on Workspace" }] });
    const r = await call(BASE);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.mode).toBe("ai");

    const hl = field(body, "google-ads", "headline");
    expect(hl.lines).toHaveLength(15);
    expect(hl.lines.every((l) => l.ok && l.length <= 30)).toBe(true);
    expect(new Set(hl.lines.map((l) => l.text.toLowerCase())).size).toBe(15);
    expect(hl.lines.map((l) => l.text)).toContain("Office email on Workspace");

    const d = field(body, "google-ads", "description");
    expect(d.lines).toHaveLength(4);
    expect(d.lines.every((l) => l.ok && l.length <= 90)).toBe(true);

    const p = field(body, "meta-ads", "primary_text");
    expect(p.lines[0].ok).toBe(true);
    expect(p.lines[0].length).toBeLessThanOrEqual(150);

    // Both AI calls counted against THIS company's cap (tenantId reaches geminiJson).
    expect(h.gemini).toHaveBeenCalledTimes(2);
    for (const [args] of h.gemini.mock.calls) {
      expect(args.tenantId).toBe("t1");
      expect(args.label).toBe("marketing/copilot-copy");
    }
    expect(h.gemini.mock.calls[1][0].user).toContain("Move your whole office email to Google Workspace today");
  });

  it("still over the limit after the retry → dropped with the reason, never in lines", async () => {
    h.gemini
      .mockResolvedValueOnce(aiCopy)
      .mockResolvedValueOnce({ items: [{ id: "google-ads.search.headline#14", text: "Still much too long for a Google headline" }] });
    const body = await (await call(BASE)).json();
    const hl = field(body, "google-ads", "headline");
    expect(hl.lines).toHaveLength(14);
    expect(hl.lines.every((l) => l.length <= 30)).toBe(true);
    expect(hl.dropped).toEqual([{ text: "Still much too long for a Google headline", reason: "Longer than 30 characters" }]);
  });

  it("a ₹ figure the person did not type is dropped", async () => {
    const copy = structuredClone(aiCopy);
    copy["google-ads"].search.headline[0] = "Workspace at ₹99 a month";
    h.gemini.mockResolvedValueOnce(copy).mockResolvedValueOnce({ items: [] });
    const body = await (await call(BASE)).json();
    const hl = field(body, "google-ads", "headline");
    expect(hl.lines.map((l) => l.text)).not.toContain("Workspace at ₹99 a month");
    expect(hl.dropped[0].reason).toMatch(/price you did not give/);
  });

  it("brand voice: the plan's tone and language, its product, the company name as brand", async () => {
    h.plan = { tone: "bold and witty", language: "hinglish", objective: "traffic", platforms: ["meta-ads"], item_id: "gw-starter" };
    h.item = { name: "Workspace Business Starter" };
    h.gemini.mockResolvedValueOnce({ "meta-ads": { feed_image: { primary_text: ["Office email ab Workspace par."], headline: ["Workspace lo"] } } });
    const r = await call({ planId: "6f1c1d1e-0000-4000-8000-000000000001", brief: "" });
    expect(r.status).toBe(200);
    const user: string = h.gemini.mock.calls[0][0].user;
    expect(user).toContain("bold and witty");
    expect(user).toMatch(/Hinglish/);
    expect(user).toContain("Workspace Business Starter");
    expect(user).toContain("Anutech Digital");
    expect(h.gemini).toHaveBeenCalledTimes(1); // nothing over a limit → no shorten call
  });

  it("the request's tone wins over the plan's", async () => {
    h.plan = { tone: "bold and witty", language: "en", objective: "traffic", platforms: ["meta-ads"], item_id: null };
    h.gemini.mockResolvedValueOnce({});
    await call({ planId: "6f1c1d1e-0000-4000-8000-000000000001", tone: "calm and premium" });
    expect(h.gemini.mock.calls[0][0].user).toContain("calm and premium");
  });
});

describe("POST /api/marketing/copilot/copy — no AI", () => {
  it("no key → stub copy, all inside the limits, the AI is never called", async () => {
    h.apiKey = null;
    const r = await call(BASE);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.mode).toBe("stub");
    expect(h.gemini).not.toHaveBeenCalled();
    for (const f of body.fields as Array<{ max: number | null; lines: Array<{ ok: boolean; length: number }>; dropped: unknown[] }>) {
      expect(f.dropped).toEqual([]);
      for (const l of f.lines) {
        expect(l.ok).toBe(true);
        if (f.max != null) expect(l.length).toBeLessThanOrEqual(f.max);
      }
    }
  });

  it("monthly AI cap used up → 429 with the reason (no stub posing as AI)", async () => {
    h.gemini.mockImplementationOnce(async (args: { onCapReached?: (m: string) => void }) => {
      args.onCapReached?.("Your company has used this month's AI limit (1000 of 1000 AI calls).");
      return null;
    });
    const r = await call(BASE);
    expect(r.status).toBe(429);
    const body = await r.json();
    expect(body.code).toBe("ai_cap_reached");
    expect(body.error).toContain("1000 of 1000");
  });

  it("AI answered nothing usable → stub, said so", async () => {
    h.gemini.mockResolvedValueOnce(null);
    const body = await (await call(BASE)).json();
    expect(body.mode).toBe("stub");
    expect(body.note).toMatch(/AI did not answer/i);
  });
});

describe("R-1897 — one full set per platform and audience (Step 3 'Write copy with AI')", () => {
  it("Meta: 3 primary texts, 3 headlines, a description and a CTA from Meta's list; audience in the brief", async () => {
    h.gemini.mockResolvedValueOnce({
      "meta-ads": {
        feed_image: {
          primary_text: [
            "This Diwali, move your office email to Google Workspace with our own Delhi team.",
            "Delhi SMEs: get Google Workspace set up, migrated and supported by people you can call.",
            "Your team's email, calendar and files in one place. Talk to us about Google Workspace.",
          ],
          headline: ["Workspace for Diwali", "Email that just works", "Talk to our team"],
          description: ["Setup and migration included"],
          cta: ["Get quote"],
        },
      },
    });
    const r = await call({ ...BASE, platforms: ["meta-ads"], audience: "lookalike" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(field(body, "meta-ads", "primary_text").lines).toHaveLength(3);
    expect(field(body, "meta-ads", "primary_text").lines.every((l) => l.ok && l.length <= 150)).toBe(true);
    expect(field(body, "meta-ads", "headline").lines).toHaveLength(3);
    expect(field(body, "meta-ads", "headline").lines.every((l) => l.ok && l.length <= 27)).toBe(true);
    expect(field(body, "meta-ads", "description").lines).toHaveLength(1);
    expect(field(body, "meta-ads", "cta").lines.map((l) => l.text)).toEqual(["GET_QUOTE"]);
    expect(h.gemini.mock.calls[0][0].user).toMatch(/Who sees the ads: people similar to the business's existing customers/);
  });

  it("a CTA that is not on Meta's list falls back to the objective's default", async () => {
    h.gemini.mockResolvedValueOnce({ "meta-ads": { feed_image: { primary_text: ["Get Google Workspace for your Delhi office this Diwali."], headline: ["Workspace for Diwali"], cta: ["BUY A CAR"] } } });
    const body = await (await call({ ...BASE, platforms: ["meta-ads"] })).json();
    expect(field(body, "meta-ads", "cta").lines.map((l) => l.text)).toEqual(["GET_QUOTE"]);
  });

  it("Google: the full 15 headlines ≤30 and 4 descriptions ≤90 come back as one set", async () => {
    h.gemini.mockResolvedValueOnce({
      "google-ads": { search: {
        headline: Array.from({ length: 15 }, (_, i) => `Workspace headline ${i + 1}`),
        description: Array.from({ length: 4 }, (_, i) => `Google Workspace set up by our own Delhi team, option ${i + 1}.`),
        path: ["workspace", "diwali"],
      } },
    });
    const body = await (await call({ ...BASE, platforms: ["google-ads"] })).json();
    expect(field(body, "google-ads", "headline").lines).toHaveLength(15);
    expect(field(body, "google-ads", "headline").lines.every((l) => l.ok && l.length <= 30)).toBe(true);
    expect(field(body, "google-ads", "description").lines).toHaveLength(4);
    expect(field(body, "google-ads", "description").lines.every((l) => l.ok && l.length <= 90)).toBe(true);
  });
});
