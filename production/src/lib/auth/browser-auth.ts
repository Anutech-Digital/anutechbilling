/**
 * The supabase-js `auth` surface for the BROWSER, answered by Auth.js when
 * NEXT_PUBLIC_AUTH_PROVIDER=authjs — so login, sign-up, password reset, two-step and every
 * `supabase.auth.getUser()` in client code keep working without touching each screen.
 *
 * Messages match GoTrue's ("Invalid login credentials", "Email not confirmed") because screens
 * test for them (login/page.tsx:95). The session token for data/Storage requests comes from
 * /api/auth/supabase-token and is kept in memory only, refreshed a minute before it expires.
 */
import { signIn as authjsSignIn, signOut as authjsSignOut } from "next-auth/react";

type Err = { name: string; message: string; status: number; code: string };
interface TokenReply {
  access_token: string | null;
  expires_at?: number;
  user: Record<string, unknown> | null;
  aal?: string;
}

const missing: Err = { name: "AuthSessionMissingError", message: "Auth session missing!", status: 400, code: "session_not_found" };
const err = (message: string, status = 400, code = "unexpected_failure"): Err => ({ name: "AuthApiError", message, status, code });

let cached: TokenReply | null = null;
let inflight: Promise<TokenReply> | null = null;

async function token(force = false): Promise<TokenReply> {
  const now = Math.floor(Date.now() / 1000);
  if (!force && cached && (!cached.access_token || (cached.expires_at ?? 0) - 60 > now)) return cached;
  inflight ??= fetch("/api/auth/supabase-token", { cache: "no-store", credentials: "same-origin" })
    .then((r) => (r.ok ? (r.json() as Promise<TokenReply>) : { access_token: null, user: null }))
    .catch(() => ({ access_token: null, user: null }))
    .finally(() => { inflight = null; });
  cached = await inflight;
  return cached;
}

export function forgetBrowserSession() {
  cached = null;
}

/** For supabase-js `accessToken`: the signed-in user's token, or the anon key. */
export async function browserAccessToken(): Promise<string> {
  const t = await token();
  return t.access_token ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const r = await fetch(url, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, status: r.status, data };
}

const LOGIN_MESSAGES: Record<string, string> = {
  invalid_credentials: "Invalid login credentials",
  email_not_confirmed: "Email not confirmed",
  banned: "User is banned",
};

export function browserAuth() {
  return {
    async getUser() {
      const t = await token();
      return t.user ? { data: { user: t.user }, error: null } : { data: { user: null }, error: missing };
    },
    async getSession() {
      const t = await token();
      if (!t.user || !t.access_token) return { data: { session: null }, error: null };
      return {
        data: {
          session: {
            access_token: t.access_token, token_type: "bearer", expires_at: t.expires_at, refresh_token: "",
            user: t.user, provider_token: null, provider_refresh_token: null, // R-528: Google token stays on the server
          },
        },
        error: null,
      };
    },
    async signInWithPassword(creds: { email: string; password: string }) {
      const res = await authjsSignIn("credentials", { email: creds.email, password: creds.password, redirect: false });
      if (!res || res.error) {
        const code = (res as { code?: string } | undefined)?.code ?? "invalid_credentials";
        return { data: { user: null, session: null }, error: err(LOGIN_MESSAGES[code] ?? LOGIN_MESSAGES.invalid_credentials, 400, code) };
      }
      const t = await token(true);
      return { data: { user: t.user, session: t.access_token ? { access_token: t.access_token, user: t.user } : null }, error: null };
    },
    async signInWithOAuth(args: { provider: string; options?: { redirectTo?: string; scopes?: string; queryParams?: Record<string, string> } }) {
      const params: Record<string, string> = { ...(args.options?.queryParams ?? {}) };
      if (args.options?.scopes) {
        params.scope = `openid email profile ${args.options.scopes}`.trim();
        params.access_type ??= "offline";
        params.prompt ??= "consent";
      }
      forgetBrowserSession();
      await authjsSignIn(args.provider, { redirectTo: args.options?.redirectTo ?? "/callback" }, params);
      return { data: { provider: args.provider, url: null }, error: null };
    },
    async signOut() {
      forgetBrowserSession();
      await authjsSignOut({ redirect: false });
      return { error: null };
    },
    async resetPasswordForEmail(email: string) {
      const r = await postJson("/api/auth/password/forgot", { email });
      return r.ok ? { data: {}, error: null } : { data: null, error: err(String(r.data.error ?? "Could not send the link"), r.status) };
    },
    async updateUser(attrs: { password?: string }) {
      if (attrs.password === undefined) return { data: { user: null }, error: err("Only a password change is supported here", 400, "validation_failed") };
      const r = await postJson("/api/auth/password/update", { password: attrs.password });
      return r.ok ? { data: { user: r.data.user ?? null }, error: null } : { data: { user: null }, error: err(String(r.data.error ?? "Could not change the password"), r.status) };
    },
    onAuthStateChange(cb: (event: string, session: unknown) => void) {
      void this.getSession().then(({ data }) => cb("INITIAL_SESSION", data.session));
      return { data: { subscription: { id: "authjs", unsubscribe() { /* sessions change by page navigation */ } } } };
    },
    mfa: {
      async listFactors() {
        const r = await fetch("/api/auth/mfa/factors", { cache: "no-store", credentials: "same-origin" });
        const data = await r.json().catch(() => null);
        return r.ok ? { data, error: null } : { data: null, error: err(String(data?.error ?? "Could not load factors"), r.status) };
      },
      async getAuthenticatorAssuranceLevel() {
        const r = await fetch("/api/auth/mfa/aal", { cache: "no-store", credentials: "same-origin" });
        const data = await r.json().catch(() => null);
        return r.ok ? { data, error: null } : { data: null, error: err(String(data?.error ?? "Could not read the session level"), r.status) };
      },
      async enroll(args?: { factorType?: string; friendlyName?: string }) {
        const r = await postJson("/api/auth/mfa/enroll", { friendlyName: args?.friendlyName });
        return r.ok ? { data: r.data, error: null } : { data: null, error: err(String(r.data.error ?? "Could not start enrolling"), r.status) };
      },
      async challengeAndVerify(args: { factorId?: string; code: string }) {
        const r = await postJson("/api/auth/mfa/verify", { factorId: args.factorId, code: args.code });
        forgetBrowserSession();
        return r.ok ? { data: r.data, error: null } : { data: null, error: err(String(r.data.error ?? "Invalid TOTP code entered"), r.status, "mfa_verification_failed") };
      },
      async unenroll(args: { factorId: string }) {
        const r = await postJson("/api/auth/mfa/unenroll", { factorId: args.factorId });
        forgetBrowserSession();
        return r.ok ? { data: { id: args.factorId }, error: null } : { data: null, error: err(String(r.data.error ?? "Could not remove it"), r.status) };
      },
    },
    async exchangeCodeForSession() {
      return { data: null, error: err("exchangeCodeForSession is not used with Auth.js", 501, "not_implemented") };
    },
    async verifyOtp() {
      return { data: null, error: err("verifyOtp is not used with Auth.js", 501, "not_implemented") };
    },
  };
}
