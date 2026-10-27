/**
 * R-1926: the session that follows a confirmed email link.
 *
 *  - Auth.js (staging / live): the route mints a 60-second HMAC ticket for the confirmed user
 *    and hands it in-process to the "email-link" Credentials provider. Without AUTH_SECRET a
 *    ticket cannot be forged; an old, tampered or foreign ticket signs nobody in, and the user
 *    must still be confirmed, not banned and not deleted at that moment.
 *  - GoTrue (local Supabase): an admin magic link for the address is spent at once on the
 *    server (verifyOtp sets the cookies) — it never reaches a mailbox or the browser.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const st = vi.hoisted(() => ({
  provider: "gotrue" as "gotrue" | "authjs",
  linkCalls: [] as Array<Record<string, unknown>>,
  otpCalls: [] as Array<Record<string, unknown>>,
  signInCalls: [] as Array<{ provider: string; opts: Record<string, unknown> }>,
  linkErr: null as { message: string } | null,
}));

vi.mock("./authjs", () => ({
  authProvider: () => st.provider,
  signIn: async (provider: string, opts: Record<string, unknown>) => { st.signInCalls.push({ provider, opts }); return "/"; },
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    auth: { admin: { generateLink: async (a: Record<string, unknown>) => {
      st.linkCalls.push(a);
      return st.linkErr ? { data: null, error: st.linkErr } : { data: { properties: { hashed_token: "hashed-abc" } }, error: null };
    } } },
  }),
  createClient: () => ({
    auth: { verifyOtp: async (a: Record<string, unknown>) => { st.otpCalls.push(a); return { data: { session: {} }, error: null }; } },
  }),
}));

import { mintEmailLinkTicket, readEmailLinkTicket, authorizeEmailLink, startSessionAfterVerify, EMAIL_LINK_PROVIDER } from "./email-link";

const UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = "s".repeat(40);
const NOW = new Date("2026-10-27T01:30:00Z");

beforeEach(() => {
  st.provider = "gotrue"; st.linkCalls = []; st.otpCalls = []; st.signInCalls = []; st.linkErr = null;
  process.env.AUTH_SECRET = SECRET;
});

describe("email-link ticket (R-1926)", () => {
  it("a fresh ticket names its user; a tampered, foreign or old one names nobody", () => {
    const t = mintEmailLinkTicket(UID, SECRET, NOW);
    expect(readEmailLinkTicket(t, SECRET, NOW)).toBe(UID);
    expect(readEmailLinkTicket(t, "other-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxx", NOW)).toBeNull();
    const [p, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", exp: NOW.getTime() + 60_000 })).toString("base64url");
    expect(readEmailLinkTicket(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
    expect(readEmailLinkTicket(`${p}.${sig}x`, SECRET, NOW)).toBeNull();
    expect(readEmailLinkTicket(t, SECRET, new Date(NOW.getTime() + 61_000))).toBeNull();
    expect(readEmailLinkTicket("", SECRET, NOW)).toBeNull();
    expect(readEmailLinkTicket("junk", SECRET, NOW)).toBeNull();
    expect(() => mintEmailLinkTicket(UID, "", NOW)).toThrow();
  });

  it("authorize signs in only a confirmed, active account", async () => {
    const t = mintEmailLinkTicket(UID, SECRET, NOW);
    const user = { id: UID, email: "asha@rao-traders.in", email_confirmed_at: "2026-10-27T01:29:59Z", banned_until: null, deleted_at: null, user_metadata: { full_name: "Asha Rao" } };
    const ok = await authorizeEmailLink(t, { secret: SECRET, now: NOW, getUser: async () => user });
    expect(ok).toEqual({ id: UID, email: "asha@rao-traders.in", name: "Asha Rao" });

    expect(await authorizeEmailLink(t, { secret: SECRET, now: NOW, getUser: async () => ({ ...user, email_confirmed_at: null }) })).toBeNull();
    expect(await authorizeEmailLink(t, { secret: SECRET, now: NOW, getUser: async () => ({ ...user, banned_until: "2099-01-01T00:00:00Z" }) })).toBeNull();
    expect(await authorizeEmailLink(t, { secret: SECRET, now: NOW, getUser: async () => null })).toBeNull();
    expect(await authorizeEmailLink("nope", { secret: SECRET, now: NOW, getUser: async () => user })).toBeNull();
  });
});

describe("startSessionAfterVerify (R-1926)", () => {
  it("GoTrue: an admin magic link is spent on the server at once — cookies set, nothing mailed", async () => {
    expect(await startSessionAfterVerify({ userId: UID, email: "asha@rao-traders.in" })).toBe(true);
    expect(st.linkCalls).toEqual([{ type: "magiclink", email: "asha@rao-traders.in" }]);
    expect(st.otpCalls).toEqual([{ token_hash: "hashed-abc", type: "magiclink" }]);
    expect(st.signInCalls).toEqual([]);
  });

  it("GoTrue: a failed link means no session (and no throw)", async () => {
    st.linkErr = { message: "boom" };
    expect(await startSessionAfterVerify({ userId: UID, email: "asha@rao-traders.in" })).toBe(false);
    expect(st.otpCalls).toEqual([]);
  });

  it("Auth.js: the email-link provider gets a ticket for THIS user, no redirect", async () => {
    st.provider = "authjs";
    expect(await startSessionAfterVerify({ userId: UID, email: "asha@rao-traders.in" })).toBe(true);
    expect(st.linkCalls).toEqual([]);
    expect(st.signInCalls).toHaveLength(1);
    expect(st.signInCalls[0].provider).toBe(EMAIL_LINK_PROVIDER);
    expect(st.signInCalls[0].opts.redirect).toBe(false);
    expect(readEmailLinkTicket(String(st.signInCalls[0].opts.ticket), SECRET, new Date())).toBe(UID);
  });

  it("Auth.js without AUTH_SECRET: no session", async () => {
    st.provider = "authjs";
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    expect(await startSessionAfterVerify({ userId: UID, email: "asha@rao-traders.in" })).toBe(false);
    expect(st.signInCalls).toEqual([]);
  });
});
