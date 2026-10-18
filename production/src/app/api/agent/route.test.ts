/**
 * R-1598 (18 Oct 2026): the website's AI chat bridge hands the conversation to THIS
 * deployment's /api/public/agent/chat handler in-process. It used to fetch the live domain
 * (RESELLEROS_URL defaulted there and no build set it), so staging chat leads landed in live.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const chat = vi.fn();
vi.mock("@/app/api/public/agent/chat/route", () => ({ POST: (r: NextRequest) => chat(r) }));

import { POST } from "./route";

const fetchMock = vi.fn();
beforeEach(() => {
  chat.mockReset(); fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RESELLEROS_FORWARD_URL", "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const STAGING = "https://resellersos-staging-test.example.invalid";
const convo = { messages: [{ role: "user", text: "need 5 Workspace users" }], leadAlreadyCaptured: false };
const req = (b: unknown, origin = STAGING, headers: Record<string, string> = {}) =>
  new NextRequest(`${origin}/api/agent`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });

describe("/api/agent — R-1598: the chat stays on this deployment", () => {
  it("a staging chat is answered by staging's own handler — never the live domain", async () => {
    chat.mockResolvedValue(ok({ reply: "Hello" }));
    const res = await POST(req(convo, STAGING, { referer: "https://anutech.in/?gclid=abc" }));
    expect(await res.json()).toEqual({ reply: "Hello" });
    expect(fetchMock).not.toHaveBeenCalled();
    const [r] = chat.mock.calls[0] as [NextRequest];
    expect(new URL(r.url).origin).toBe(STAGING);
    expect(new URL(r.url).pathname).toBe("/api/public/agent/chat");
    expect(await r.json()).toEqual(convo);
    expect(r.headers.get("referer")).toBe("https://anutech.in/?gclid=abc");
  });

  it("a staging env pointing at live is refused and handled locally", async () => {
    vi.stubEnv("RESELLEROS_FORWARD_URL", "https://reselleros.anutech.in/");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    chat.mockResolvedValue(ok({ reply: "Hi" }));
    await POST(req(convo));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(err.mock.calls.flat().join(" ")).toMatch(/FORWARD REFUSED/);
    err.mockRestore();
  });

  it("a handler failure is a stated 502, not a spinner", async () => {
    chat.mockResolvedValue(new Response("x", { status: 500 }));
    expect((await POST(req(convo))).status).toBe(502);
  });

  it("a malformed body is 400", async () => {
    const bad = new NextRequest(`${STAGING}/api/agent`, { method: "POST", body: "{" });
    expect((await POST(bad)).status).toBe(400);
  });
});
