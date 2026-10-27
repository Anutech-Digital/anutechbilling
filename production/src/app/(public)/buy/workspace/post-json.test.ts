/** R-1110: the Workspace Trial / Quote / Buy dialogs say something on a network error or an HTML 502. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { postJson } from "./post-json";

afterEach(() => vi.unstubAllGlobals());

describe("R-1110 postJson never throws", () => {
  it("a rejected fetch (offline) is 'not reached'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(postJson("/x", {})).resolves.toEqual({ reached: false });
  });
  it("an HTML 502 from a proxy is 'not reached'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } })));
    await expect(postJson("/x", {})).resolves.toEqual({ reached: false });
  });
  it("our API's JSON error comes back with its message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Pick a state" }, { status: 400 })));
    await expect(postJson<{ error: string }>("/x", {})).resolves.toEqual({ reached: true, ok: false, status: 400, json: { error: "Pick a state" } });
  });
  it("a success passes the JSON and sends the headers", async () => {
    const f = vi.fn().mockResolvedValue(Response.json({ success: true }));
    vi.stubGlobal("fetch", f);
    await expect(postJson("/x", { a: 1 }, { "cf-turnstile-response": "t" })).resolves.toMatchObject({ reached: true, ok: true, json: { success: true } });
    expect(f.mock.calls[0][1].headers).toMatchObject({ "Content-Type": "application/json", "cf-turnstile-response": "t" });
  });
});

describe("R-1110 wiring — trial, quote and pay (inline checkout, R-1971)", () => {
  const src = readFileSync("src/app/(public)/buy/workspace/_parts/submit-order.ts", "utf8");
  it("trial, quote and buy all post through postJson and handle 'not reached' with a retry", () => {
    for (const url of ["/api/public/trial/workspace", "/api/public/enquiry/workspace", "/api/public/checkout/workspace"]) {
      expect(src).toMatch(new RegExp(`postJson<[^>]+>\\("${url.replace(/\//g, "\\/")}"`));
      expect(src).not.toMatch(new RegExp(`fetch\\("${url.replace(/\//g, "\\/")}"`));
    }
    expect((src.match(/if \(!r\.reached\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((src.match(/notReached\(/g) ?? []).length).toBeGreaterThanOrEqual(4); // 1 definition + 3 callers
  });
});
