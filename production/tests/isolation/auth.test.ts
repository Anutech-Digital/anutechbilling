/**
 * Login on Auth.js (src/server/auth), against the real local database:
 * GoTrue-made passwords still work, confirmation/ban rules hold, reset links work once,
 * two-step codes are checked server-side and cannot be replayed, the login's database user
 * cannot see app data, and the token minted after an Auth.js sign-in is accepted by both the
 * gateway and the real PostgREST with the right identity.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const sent: { to: string; text: string }[] = [];
vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async (m: { to: string; text: string }) => { sent.push(m); return { status: "sent" }; }),
}));

const { checkPassword, createUser, deleteUser, getUserByEmail, updateUser } = await import("@/server/auth/accounts");
const { sendRecoveryLink, resetWithToken } = await import("@/server/auth/recovery");
const { enroll, verifyCode, hasVerifiedFactor, unenroll, listFactors } = await import("@/server/auth/mfa");
const { codeAt, stepAt } = await import("@/server/auth/totp");
const { mintSupabaseJwt } = await import("@/server/auth/supabase-jwt");
const { identityFromHeaders } = await import("@/server/postgrest/identity");
const { authConfig } = await import("@/server/auth/authjs");
const { disconnectAuthStore } = await import("@/server/db/auth-store");

const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
const made: string[] = [];
const email = (tag: string) => `auth-${tag}-${randomUUID().slice(0, 8)}@example.test`;

beforeAll(async () => { await admin.connect(); });
afterAll(async () => {
  if (made.length) await admin.query(`delete from auth.users where id = any($1::uuid[])`, [made]);
  await admin.end();
  await disconnectAuthStore();
});

async function newUser(tag: string, opts: { confirmed?: boolean; password?: string } = {}) {
  const u = await createUser({ email: email(tag), password: opts.password ?? "correct horse battery", email_confirm: opts.confirmed ?? true });
  made.push(u.id);
  return u;
}

describe("passwords", () => {
  test("a password hashed by GoTrue (bcrypt $2a$) still signs in", async () => {
    const id = randomUUID();
    const e = email("gotrue");
    await admin.query(
      `insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role)
       values ($1, $2, crypt('old-gotrue-password', gen_salt('bf', 10)), now(), 'authenticated', 'authenticated')`, [id, e]);
    made.push(id);
    const hash = (await admin.query(`select encrypted_password from auth.users where id = $1`, [id])).rows[0].encrypted_password;
    expect(hash).toMatch(/^\$2a\$10\$/);
    const r = await checkPassword(e, "old-gotrue-password");
    expect(r.ok && r.user.id).toBe(id);
  });

  test("right password → ok; wrong password, unknown email → the same refusal", async () => {
    const u = await newUser("pw");
    expect((await checkPassword(u.email.toUpperCase(), "correct horse battery")).ok).toBe(true);
    expect(await checkPassword(u.email, "wrong")).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(await checkPassword(email("nobody"), "whatever")).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  test("an unconfirmed signup cannot sign in (R-048 part 1)", async () => {
    const u = await newUser("unconfirmed", { confirmed: false });
    expect(await checkPassword(u.email, "correct horse battery")).toEqual({ ok: false, reason: "email_not_confirmed" });
    await updateUser(u.id, { email_confirm: true });
    expect((await checkPassword(u.email, "correct horse battery")).ok).toBe(true);
  });

  test("a banned account cannot sign in; unbanning restores it", async () => {
    const u = await newUser("banned");
    await updateUser(u.id, { ban_duration: "876000h" });
    expect(await checkPassword(u.email, "correct horse battery")).toEqual({ ok: false, reason: "banned" });
    await updateUser(u.id, { ban_duration: "none" });
    expect((await checkPassword(u.email, "correct horse battery")).ok).toBe(true);
  });

  test("changing the password retires the old one", async () => {
    const u = await newUser("change");
    await updateUser(u.id, { password: "a brand new password" });
    expect((await checkPassword(u.email, "correct horse battery")).ok).toBe(false);
    expect((await checkPassword(u.email, "a brand new password")).ok).toBe(true);
  });

  test("a second account with the same email is refused", async () => {
    const u = await newUser("dupe");
    await expect(createUser({ email: u.email.toUpperCase(), password: "x".repeat(10) })).rejects.toThrow(/already been registered/);
  });

  test("deleting an account removes it", async () => {
    const u = await newUser("delete");
    await deleteUser(u.id);
    expect(await getUserByEmail(u.email)).toBeNull();
  });
});

describe("password reset links", () => {
  const tokenFrom = (text: string) => new URL(/https?:\/\/\S+/.exec(text)![0]).searchParams.get("token")!;

  test("a link works once and signs the new password in", async () => {
    const u = await newUser("reset");
    sent.length = 0;
    await sendRecoveryLink(u.email, "https://app.example.test");
    expect(sent).toHaveLength(1);
    const token = tokenFrom(sent[0].text);
    expect(await resetWithToken(token, "reset to this one")).toBe(u.email);
    expect((await checkPassword(u.email, "reset to this one")).ok).toBe(true);
    expect(await resetWithToken(token, "and again")).toBeNull();
  });

  test("an hour-old link is refused; a made-up token is refused", async () => {
    const u = await newUser("reset-old");
    sent.length = 0;
    await sendRecoveryLink(u.email, "https://app.example.test");
    const token = tokenFrom(sent[0].text);
    await admin.query(`update auth.users set recovery_sent_at = now() - interval '61 minutes' where id = $1`, [u.id]);
    expect(await resetWithToken(token, "too late now")).toBeNull();
    expect(await resetWithToken("x".repeat(43), "nope nope")).toBeNull();
  });

  test("asking for a link for an unknown address sends nothing (and says nothing different)", async () => {
    sent.length = 0;
    await sendRecoveryLink(email("ghost"), "https://app.example.test");
    expect(sent).toHaveLength(0);
  });

  test("the database keeps only a hash of the token", async () => {
    const u = await newUser("reset-hash");
    sent.length = 0;
    await sendRecoveryLink(u.email, "https://app.example.test");
    const token = tokenFrom(sent[0].text);
    const stored = (await admin.query(`select recovery_token from auth.users where id = $1`, [u.id])).rows[0].recovery_token;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(token);
  });
});

describe("two-step codes (R-048 part 2)", () => {
  test("enroll → verify with the current code → verified; the same code cannot be used twice", async () => {
    const u = await newUser("mfa");
    const f = await enroll(u.id, u.email, "phone");
    expect(f.totp.qr_code).toMatch(/^data:image\/svg\+xml/);
    expect(await hasVerifiedFactor(u.id)).toBe(false);
    const code = codeAt(f.totp.secret, stepAt(Date.now()));
    expect(await verifyCode(u.id, "000000" === code ? "111111" : "000000", f.id)).toBe(false);
    expect(await verifyCode(u.id, code, f.id)).toBe(true);
    expect(await hasVerifiedFactor(u.id)).toBe(true);
    expect(await verifyCode(u.id, code)).toBe(false); // replay
  });

  test("a code from another account's factor does not work", async () => {
    const a = await newUser("mfa-a");
    const b = await newUser("mfa-b");
    const fa = await enroll(a.id, a.email);
    await enroll(b.id, b.email);
    expect(await verifyCode(b.id, codeAt(fa.totp.secret, stepAt(Date.now())))).toBe(false);
  });

  test("unenroll removes the factor; someone else cannot remove it", async () => {
    const a = await newUser("mfa-un");
    const b = await newUser("mfa-other");
    const f = await enroll(a.id, a.email);
    expect(await unenroll(b.id, f.id)).toBe(false);
    expect(await listFactors(a.id)).toHaveLength(1);
    expect(await unenroll(a.id, f.id)).toBe(true);
    expect(await listFactors(a.id)).toHaveLength(0);
  });

  test("the session becomes aal2 only when the jwt callback itself checks a right code", async () => {
    const u = await newUser("mfa-jwt");
    const f = await enroll(u.id, u.email);
    await verifyCode(u.id, codeAt(f.totp.secret, stepAt(Date.now()) - 1), f.id);
    const jwt = authConfig.callbacks!.jwt! as unknown as (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
    let token = await jwt({ token: {}, user: { id: u.id, email: u.email }, account: { provider: "credentials", type: "credentials" }, trigger: "signIn" });
    expect(token).toMatchObject({ uid: u.id, aal: "aal1", mfa: true });
    token = await jwt({ token, trigger: "update", session: { aal: "aal2" } }); // a forged claim is ignored
    expect(token.aal).toBe("aal1");
    token = await jwt({ token, trigger: "update", session: { mfaCode: "123456" === codeAt(f.totp.secret, stepAt(Date.now())) ? "654321" : "123456" } });
    expect(token.aal).toBe("aal1");
    token = await jwt({ token, trigger: "update", session: { mfaCode: codeAt(f.totp.secret, stepAt(Date.now())) } });
    expect(token.aal).toBe("aal2");
  });
});

describe("boundaries", () => {
  test("the login's database user cannot read app data", async () => {
    const c = new pg.Client({ connectionString: process.env.AUTH_DATABASE_URL });
    await c.connect();
    await expect(c.query(`select 1 from public.invoices limit 1`)).rejects.toThrow(/permission denied/);
    await expect(c.query(`select 1 from public.users limit 1`)).rejects.toThrow(/permission denied/);
    await c.end();
  });

  test("the token minted after an Auth.js sign-in is the same user to the gateway AND the real PostgREST", async () => {
    const u = await newUser("mint");
    const { token } = mintSupabaseJwt({ userId: u.id, email: u.email, aal: "aal1" });
    expect(identityFromHeaders(new Headers({ authorization: `Bearer ${token}` }), { allowService: false })).toEqual({ mode: "user", userId: u.id });
    const r = await fetch(`${process.env.POSTGREST_URL}/rpc/current_user_id`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
    expect(await r.json()).toBe(u.id);
  });
});
