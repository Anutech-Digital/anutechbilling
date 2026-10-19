/**
 * R-1549 (19 Oct 2026): the AI chat's lead is filed through this deployment's own enquiry
 * handler — in-process, with the visitor's IP, past the Turnstile check that only a browser
 * form can pass — and a lead that could not be saved is SAID in the reply, never dropped.
 *
 * Before: the route fetched http://127.0.0.1/api/public/enquiry/* with no visitor IP and no
 * Turnstile token. Every chat visitor shared one rate-limit bucket, and the moment
 * TURNSTILE_SECRET_KEY was set every chat lead was refused with nothing but a log line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const general = vi.fn();
const workspace = vi.fn();
const geminiJson = vi.fn();
vi.mock("@/app/api/public/enquiry/general/route", () => ({ POST: (r: NextRequest) => general(r) }));
vi.mock("@/app/api/public/enquiry/workspace/route", () => ({ POST: (r: NextRequest) => workspace(r) }));
vi.mock("@/lib/ai/gemini", () => ({
  resolveGeminiConfig: async () => ({ apiKey: "test-key", model: "test-model" }),
  geminiJson: (...a: unknown[]) => geminiJson(...a),
}));
vi.mock("@/lib/ai/autonomy.server", () => ({ loadAutonomyPolicy: async () => ({}), logAiAction: async () => {} }));
/** A query builder that answers every chain with no rows. */
function emptyQuery(): unknown {
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const k of ["from", "select", "eq", "ilike", "order", "limit"]) q[k] = self;
  q.maybeSingle = async () => ({ data: null });
  q.then = (res: (v: { data: unknown[] }) => unknown) => Promise.resolve({ data: [] }).then(res);
  return q;
}
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => emptyQuery() }));
vi.mock("@/lib/supabase/bare", () => ({ createBareClient: () => emptyQuery() }));

import { POST } from "./route";
import { isTrustedInternalCall } from "@/lib/security/turnstile-guard";
import { resetRateLimiter } from "@/lib/security/rate-limit";
/* R-1499: outside production the website tenant is never implied any more — name it, as a
   deployment does. (The fixture is the same id the routes used to fall back to.) */
process.env.BUY_PAGE_TENANT_ID ||= "fbb976f1-9090-4f10-9726-0901bd144e42";

const fetchMock = vi.fn();
const EMAIL = "asha.rao@example.invalid";
const visitorSays = { role: "user", text: `I am Asha Rao, ${EMAIL}, 9876543210 — need Workspace` };
const modelLead = {
  reply: "Thank you Asha, our team will contact you.",
  lead: { fullName: "Asha Rao", email: EMAIL, phone: "9876543210" },
};
const req = (ip = "203.0.113.7", email = EMAIL) =>
  new NextRequest("https://site.example.invalid/api/public/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ messages: [{ ...visitorSays, text: visitorSays.text.replace(EMAIL, email) }] }),
  });
const answer = (status: number, json: unknown) =>
  new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  resetRateLimiter();
  general.mockReset(); workspace.mockReset(); geminiJson.mockReset(); fetchMock.mockReset();
  geminiJson.mockResolvedValue(modelLead);
  /* What the old loopback hop met once Turnstile was on: a refusal. */
  fetchMock.mockResolvedValue(answer(403, { error: "We could not verify this request." }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret-not-real");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("/api/public/agent/chat — R-1549: the chat lead is really filed", () => {
  it("with Turnstile on, the lead reaches the enquiry handler in-process, as a trusted internal call with the visitor's IP", async () => {
    general.mockResolvedValue(answer(200, { success: true, leadId: "L-1" }));
    const res = await POST(req());
    const json = await res.json();
    expect(json.leadCreated).toEqual({ quoteId: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(general).toHaveBeenCalledTimes(1);
    const [r] = general.mock.calls[0] as [NextRequest];
    expect(isTrustedInternalCall(r)).toBe(true);
    expect(r.headers.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(new URL(r.url).pathname).toBe("/api/public/enquiry/general");
  });

  it("a visitor's own request to the enquiry handler is never trusted", () => {
    expect(isTrustedInternalCall(req())).toBe(false);
  });

  it("a lead the handler refused is SAID in the reply — not dropped silently — and the log has no contact data", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    general.mockResolvedValue(answer(500, { error: "boom" }));
    const json = await (await POST(req())).json();
    expect(json.leadCreated).toBeNull();
    expect(json.leadSaveFailed).toBe(true);
    expect(json.reply).toMatch(/could not save your details/i);
    expect(json.reply).toMatch(/has not received them/i);
    const logged = err.mock.calls.flat().map(String).join(" ");
    expect(logged).toMatch(/lead filing failed/);
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain("9876543210");
  });

  it("the same email filing again and again is limited per email — and told so", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    general.mockResolvedValue(answer(200, { success: true, leadId: "L-1" }));
    for (let i = 0; i < 5; i++) {
      expect((await (await POST(req(`192.0.2.${i + 1}`))).json()).leadCreated).not.toBeNull();
    }
    const json = await (await POST(req("192.0.2.60"))).json();
    expect(json.leadCreated).toBeNull();
    expect(json.reply).toMatch(/could not save your details/i);
    expect(general).toHaveBeenCalledTimes(5);
  });
});
