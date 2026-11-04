/**
 * R-2160 (G-ADS-AI, AI-04) — geminiImagenImage: the Imagen call goes through the one Gemini door.
 * fetch and the AI cap are mocked; no real AI call is ever made here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reserveMock, tokensMock } = vi.hoisted(() => ({ reserveMock: vi.fn(), tokensMock: vi.fn() }));
vi.mock("./usage-cap", () => ({ reserveAiCall: reserveMock, recordAiTokens: tokensMock }));

import { geminiImagenImage, __resetGeminiBreaker, __resetImagenBreaker } from "./gemini";

const SERVER_KEY = "AQ.server-" + "g".repeat(20);
const OWN_KEY = "AQ.own-" + "o".repeat(20);
const T1 = "11111111-1111-4111-8111-111111111111";
const OPEN = { allowed: true, used: 3, cap: 100, month: "2026-10-01" };
const CAPPED = { allowed: false, used: 100, cap: 100, month: "2026-10-01", message: "Your company has used this month's AI limit (100 of 100 AI calls)." };
const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const httpErr = (status: number, message: string) =>
  ({ ok: false, status, json: async () => ({}), text: async () => JSON.stringify({ error: { message } }) }) as unknown as Response;

const fetchMock = vi.fn();
const call = (over: Partial<Parameters<typeof geminiImagenImage>[0]> = {}) => geminiImagenImage({
  apiKey: SERVER_KEY, model: "imagen-4.0-generate-001", prompt: "A laptop on a desk, Delhi office", aspectRatio: "9:16",
  tenantId: T1, label: "marketing/ad-image", ...over,
});

beforeEach(() => {
  __resetGeminiBreaker();
  __resetImagenBreaker();
  reserveMock.mockReset();
  reserveMock.mockResolvedValue(OPEN);
  tokensMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GEMINI_API_KEY", SERVER_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("geminiImagenImage", () => {
  it("asks Imagen :predict for one image in the asked ratio, key in a header (never the URL)", async () => {
    fetchMock.mockResolvedValue(ok({ predictions: [{ bytesBase64Encoded: PNG_B64, mimeType: "image/png" }] }));
    const r = await call();
    expect(r).toMatchObject({ ok: true, mimeType: "image/png", model: "imagen-4.0-generate-001" });
    if (r.ok) expect(r.bytes.toString()).toBe("fake-png-bytes");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict");
    expect(String(url)).not.toContain(SERVER_KEY);
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(SERVER_KEY);
    const body = JSON.parse(init.body);
    expect(body.instances).toEqual([{ prompt: "A laptop on a desk, Delhi office" }]);
    expect(body.parameters).toMatchObject({ sampleCount: 1, aspectRatio: "9:16" });
  });

  it("counts the image against the company's monthly AI cap BEFORE calling (server key → enforced)", async () => {
    fetchMock.mockResolvedValue(ok({ predictions: [{ bytesBase64Encoded: PNG_B64, mimeType: "image/png" }] }));
    await call({ aspectRatio: "1:1" });
    expect(reserveMock).toHaveBeenCalledWith(T1, "marketing/ad-image", true);
    expect(reserveMock.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });

  it("a company's own Gemini key is counted but not refused", async () => {
    fetchMock.mockResolvedValue(ok({ predictions: [{ bytesBase64Encoded: PNG_B64, mimeType: "image/png" }] }));
    await call({ apiKey: OWN_KEY });
    expect(reserveMock).toHaveBeenCalledWith(T1, "marketing/ad-image", false);
  });

  it("cap used up → refused with the cap sentence, Imagen is never called", async () => {
    reserveMock.mockResolvedValue(CAPPED);
    const r = await call();
    expect(r).toEqual({ ok: false, code: "cap", message: CAPPED.message });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Google's safety filter → 'blocked' with a sentence a person can act on", async () => {
    fetchMock.mockResolvedValue(ok({ predictions: [{ raiFilteredReason: "The prompt could not be submitted." }] }));
    const r = await call();
    expect(r).toMatchObject({ ok: false, code: "blocked" });
    if (!r.ok) expect(r.message).toMatch(/safety filter/i);
  });

  it("403 (billing off on the project) → readable reason, not a bare null", async () => {
    fetchMock.mockResolvedValue(httpErr(403, "Imagen API is only accessible to billed users at this time."));
    const r = await call();
    expect(r).toMatchObject({ ok: false, code: "failed" });
    if (!r.ok) expect(r.message).toMatch(/billing/i);
  });

  it("an image failure does not trip the text breaker (its own breaker)", async () => {
    fetchMock.mockResolvedValue(httpErr(403, "denied"));
    for (let i = 0; i < 4; i++) await call();
    const r = await call();
    expect(r).toMatchObject({ ok: false, code: "failed" });
    if (!r.ok) expect(r.message).toMatch(/paused/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("no key → no_key, nothing counted or called", async () => {
    const r = await call({ apiKey: "" });
    expect(r).toMatchObject({ ok: false, code: "no_key" });
    expect(reserveMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
