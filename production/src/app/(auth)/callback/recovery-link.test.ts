/**
 * /callback with a recovery token_hash (5 Oct 2026): an admin-made or {{ .TokenHash }}
 * email link signs the person in and sends them to /reset-password — and nothing else.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const verifyOtp = vi.hoisted(() => vi.fn());
const exchangeCodeForSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { verifyOtp, exchangeCodeForSession } }),
  createAdminClient: () => ({}),
}));

import { GET } from "./route";

const req = (qs: string) => new NextRequest(`https://app.example/callback?${qs}`, { headers: { host: "app.example", "x-forwarded-proto": "https" } });

beforeEach(() => { verifyOtp.mockReset(); exchangeCodeForSession.mockReset(); vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example"); });

describe("recovery token_hash", () => {
  it("verifies the token and goes to /reset-password", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const res = await GET(req("token_hash=abc&type=recovery"));
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "abc", type: "recovery" });
    expect(res.headers.get("location")).toBe("https://app.example/reset-password");
  });
  it("an expired or used link says so on the login page", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "expired" } });
    const res = await GET(req("token_hash=abc&type=recovery"));
    expect(res.headers.get("location")).toBe("https://app.example/login?error=link_expired");
  });
  it("only recovery: any other type is not signed in this way", async () => {
    const res = await GET(req("token_hash=abc&type=magiclink"));
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("https://app.example/login?error=no_code");
  });
  it("cannot be pointed elsewhere: next= is ignored on this path", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const res = await GET(req("token_hash=abc&type=recovery&next=https://evil.example"));
    expect(res.headers.get("location")).toBe("https://app.example/reset-password");
  });
});
