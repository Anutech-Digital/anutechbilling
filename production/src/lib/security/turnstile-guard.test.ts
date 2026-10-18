import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { turnstileRefusal } from "./turnstile-guard";

const ENV = process.env.TURNSTILE_SECRET_KEY;
afterEach(() => { if (ENV === undefined) delete process.env.TURNSTILE_SECRET_KEY; else process.env.TURNSTILE_SECRET_KEY = ENV; });
const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");

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
      expect(s, p).toMatch(/turnstileRefusal\(request\.headers, body\)/);
      expect(s.indexOf("turnstileRefusal(request"), p).toBeLessThan(s.indexOf(p.includes("signup") ? "const { password" : "enquirySchema.safeParse(body)"));
    }
  });

  it("every form that posts to them sends the widget token", () => {
    for (const p of ["app/(auth)/signup/page.tsx", "app/(public)/enquiry/enquiry-client.tsx", "app/(public)/buy/workspace/buy-workspace-client.tsx",
      "site/components/quote/QuoteBuilder.tsx", "site/components/trial/TrialForm.tsx"]) {
      expect(src(p), p).toMatch(/\.\.\.ts\.headers/);
    }
    /* R-1598: /api/enquiry hands the visitor's headers to the in-process handler — the token among them. */
    expect(src("app/api/enquiry/route.ts")).toMatch(/deliverToApp\(/);
    expect(src("site/lib/app-forward.ts")).toMatch(/"x-turnstile-token"/);
  });

  it("quote accept records the signer IP with the shared clientIp, not the spoofable first XFF entry", () => {
    const s = src("app/api/public/quote/[id]/accept/route.ts");
    expect(s).toMatch(/signer_ip: clientIp\(request\.headers\)/);
    expect(s).not.toMatch(/split\(","\)\[0\]/);
  });
});
