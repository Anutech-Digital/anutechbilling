import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { turnstileRefusal, turnstileRefusalFor, markTrustedInternalCall, isTrustedInternalCall } from "./turnstile-guard";

const ENV = process.env.TURNSTILE_SECRET_KEY;
afterEach(() => { if (ENV === undefined) delete process.env.TURNSTILE_SECRET_KEY; else process.env.TURNSTILE_SECRET_KEY = ENV; });
const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
const BUY = "app/(public)/buy/workspace/buy-workspace-client.tsx";
const POST_JSON = "app/(public)/buy/workspace/post-json.ts";

describe("R-020 — bot check on public forms", () => {
  it("no secret configured → nothing is refused (ships before the keys exist)", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(await turnstileRefusal(new Headers(), {})).toBeNull();
  });

  it("secret configured, no token → 403 with a plain sentence, before anything is written", async () => {
    process.env.TURNSTILE_SECRET_KEY = "0x_aitest_secret";
    const res = await turnstileRefusal(new Headers(), { email: "bot@example.invalid" });
    expect(res?.status).toBe(403);
    expect((await res!.json()).error).toMatch(/could not verify/i);
  });

  it("enquiry (general + workspace) and signup call the guard before reading the form", () => {
    for (const p of ["app/api/public/enquiry/general/route.ts", "app/api/public/enquiry/workspace/route.ts", "app/api/auth/signup/route.ts"]) {
      const s = src(p);
      /* R-1549: the enquiry handlers use turnstileRefusalFor(request, body) — same check, plus the
         chat's own in-process lead call (marked by the server, never from the network). */
      expect(s, p).toMatch(/turnstileRefusal(?:For\(request, body\)|\(request\.headers, body\))/);
      expect(s.indexOf("turnstileRefusal"), p).toBeGreaterThan(-1);
      expect(s.search(/turnstileRefusal(For)?\(request/), p).toBeLessThan(s.indexOf(p.includes("signup") ? "const { password" : "enquirySchema.safeParse(body)"));
    }
  });

  it("R-1549: only a request object the server marked is let past — a forged header is not", async () => {
    process.env.TURNSTILE_SECRET_KEY = "0x_aitest_secret";
    const forged = new Request("https://x.example.invalid/api/public/enquiry/general", {
      method: "POST", headers: { "x-internal-call": "1", "x-trusted": "true" },
    });
    expect((await turnstileRefusalFor(forged, {}))?.status).toBe(403);
    const ours = markTrustedInternalCall(new Request("https://x.example.invalid/api/public/enquiry/general", { method: "POST" }));
    expect(isTrustedInternalCall(ours)).toBe(true);
    expect(await turnstileRefusalFor(ours, {})).toBeNull();
  });

  it("every form that posts to them sends the widget token", () => {
    for (const p of ["app/(auth)/signup/page.tsx", "app/(public)/enquiry/enquiry-client.tsx",
      "site/components/quote/QuoteBuilder.tsx", "site/components/trial/TrialForm.tsx"]) {
      expect(src(p), p).toMatch(/\.\.\.ts\.headers/);
    }
    /* R-1800: since R-1110 the Workspace buy page posts through postJson(url, body, ts.headers),
       which spreads the headers into fetch itself — checked call by call in the R-737 test below. */
    expect(src(BUY), BUY).toMatch(/postJson<[^>]*>\("\/api\/public\/enquiry\/workspace",[^\n]*,\s*ts\.headers\)/);
    /* R-1598: /api/enquiry hands the visitor's headers to the in-process handler — the token among them. */
    expect(src("app/api/enquiry/route.ts")).toMatch(/deliverToApp\(/);
    expect(src("site/lib/app-forward.ts")).toMatch(/"x-turnstile-token"/);
  });

  it("R-737: the refusal says what happened, why, and what to do (§24)", async () => {
    process.env.TURNSTILE_SECRET_KEY = "0x_aitest_secret";
    const msg = (await (await turnstileRefusal(new Headers(), {}))!.json()).error as string;
    expect(msg).toMatch(/could not verify/i);          // what
    expect(msg).toMatch(/security check/i);            // why
    expect(msg).toMatch(/reload the page/i);           // next step
    expect(msg).toMatch(/WhatsApp|call us/i);          // a way out if it keeps failing
  });

  it("R-737: trial, checkout and the website chat call the guard before reading the body", () => {
    const cases: Array<[string, string]> = [
      ["app/api/public/trial/workspace/route.ts", "trialSchema.safeParse(body)"],
      ["app/api/public/checkout/workspace/route.ts", "checkoutSchema.safeParse(body)"],
      ["app/api/public/agent/chat/route.ts", "sanitizeMessages("],
    ];
    for (const [p, firstUse] of cases) {
      const s = src(p);
      const at = s.search(/turnstileRefusalFor\(request, body\)/);
      expect(at, p).toBeGreaterThan(-1);
      expect(at, p).toBeLessThan(s.indexOf(firstUse));
    }
  });

  it("R-737: the trial, checkout and chat forms send the widget token", () => {
    const buy = src(BUY);
    /* R-1800: R-1110 (dc3fe33b) moved these two calls from `fetch(url, { headers: { ...ts.headers } })`
       to `postJson(url, body, ts.headers)`. Either shape carries the token; the helper must then
       put those headers on the request — a postJson that dropped them would ship no token. */
    for (const api of ["/api/public/trial/workspace", "/api/public/checkout/workspace"]) {
      const viaFetch = buy.indexOf(`fetch("${api}"`);
      const viaPost = buy.search(new RegExp(`postJson<[^>]*>\\("${api.replace(/\//g, "\\/")}"`));
      const at = viaFetch > -1 ? viaFetch : viaPost;
      expect(at, api).toBeGreaterThan(-1);
      const call = buy.slice(at, at + 200);
      expect(call, api).toMatch(viaFetch > -1 ? /\.\.\.ts\.headers/ : /^postJson<[^>]*>\([^\n]*,\s*ts\.headers\)/);
    }
    expect(src(POST_JSON)).toMatch(/headers:\s*\{\s*"Content-Type":\s*"application\/json",\s*\.\.\.headers\s*\}/);
    expect(src("site/components/agent/AgentChat.tsx")).toMatch(/\.\.\.ts\.headers/);
    expect(src("site/components/agent/AgentChat.tsx")).toMatch(/ts\.widget/);
  });

  it("quote accept records the signer IP with the shared clientIp, not the spoofable first XFF entry", () => {
    const s = src("app/api/public/quote/[id]/accept/route.ts");
    expect(s).toMatch(/signer_ip: clientIp\(request\.headers\)/);
    expect(s).not.toMatch(/split\(","\)\[0\]/);
  });
});
