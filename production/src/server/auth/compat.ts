/**
 * The supabase-js `auth` surface the app already calls, answered by Auth.js — so ~190
 * `supabase.auth.getUser()` and the admin calls keep working with AUTH_PROVIDER=authjs and no
 * change at the call site. Only the methods this codebase uses are implemented (measured
 * 5 Oct 2026); anything else returns an error naming the method instead of misbehaving.
 */
import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { getToken } from "next-auth/jwt";
import { auth, signOut as authSignOut } from "./authjs";
import {
  AuthError, createUser, deleteUser, getUserById, listUsers, updateUser,
  type AuthUser, type CreateUserInput, type UpdateUserInput,
} from "./accounts";
import { hasVerifiedFactor, listFactors } from "./mfa";
import { mintSupabaseJwt } from "./supabase-jwt";

type Err = { name: string; message: string; status: number; code: string };
const sessionMissing: Err = { name: "AuthSessionMissingError", message: "Auth session missing!", status: 400, code: "session_not_found" };
const asErr = (e: unknown): Err => e instanceof AuthError
  ? { name: e.name, message: e.message, status: e.status, code: e.code }
  : { name: "AuthUnknownError", message: (e as Error)?.message ?? "unknown error", status: 500, code: "unexpected_failure" };
const unsupported = (method: string) => async () => ({
  data: null,
  error: { name: "AuthUnsupported", message: `supabase.auth.${method} is not available with AUTH_PROVIDER=authjs`, status: 501, code: "not_implemented" } as Err,
});

/** The signed-in Auth.js user as a supabase-js User — once per request. */
export const currentAuthUser = cache(async (): Promise<{ user: AuthUser; aal: "aal1" | "aal2"; mfaEnrolled: boolean } | null> => {
  const s = await auth();
  if (!s?.user?.id) return null;
  const user = await getUserById(s.user.id);
  if (!user) return null;
  return { user, aal: s.aal, mfaEnrolled: s.mfaEnrolled };
});

/**
 * R-528: the Google access token, read SERVER-SIDE from the encrypted Auth.js cookie — it is
 * never in the session object (GET /api/auth/session reaches the browser). Only for the user the
 * session belongs to, and only while Google says it is still valid.
 */
export const currentProviderToken = cache(async (userId: string): Promise<string | undefined> => {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) return undefined;
  const cookie = (await cookies()).toString();
  if (!cookie) return undefined;
  // Cookie name differs on https (__Secure-) and http; only the cookie header is passed, so a
  // Bearer header can never be decoded here.
  for (const secureCookie of [true, false]) {
    const t = await getToken({ req: { headers: { cookie } }, secret, secureCookie }).catch(() => null);
    if (!t) continue;
    if (t.uid !== userId || typeof t.gat !== "string") return undefined;
    if (typeof t.gexp === "number" && t.gexp * 1000 <= Date.now()) return undefined;
    return t.gat;
  }
  return undefined;
});

/** Access token for supabase-js requests (gateway, Storage): minted for the session user, or the anon key. */
export async function accessTokenForRequest(): Promise<string> {
  const me = await currentAuthUser();
  if (!me) return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  return mintSupabaseJwt({ userId: me.user.id, email: me.user.email, aal: me.aal }).token;
}

export function serverAuth() {
  return {
    async getUser() {
      const me = await currentAuthUser();
      return me ? { data: { user: me.user }, error: null } : { data: { user: null }, error: sessionMissing };
    },
    async getSession() {
      const me = await currentAuthUser();
      if (!me) return { data: { session: null }, error: null };
      const { token, expiresAt } = mintSupabaseJwt({ userId: me.user.id, email: me.user.email, aal: me.aal });
      return {
        data: {
          session: {
            access_token: token, token_type: "bearer", expires_at: expiresAt, expires_in: expiresAt - Math.floor(Date.now() / 1000),
            refresh_token: "", user: me.user, provider_token: (await currentProviderToken(me.user.id)) ?? null, provider_refresh_token: null,
          },
        },
        error: null,
      };
    },
    async signOut() {
      await authSignOut({ redirect: false });
      return { error: null };
    },
    mfa: {
      async getAuthenticatorAssuranceLevel() {
        const me = await currentAuthUser();
        if (!me) return { data: null, error: sessionMissing };
        const nextLevel = (me.mfaEnrolled || (await hasVerifiedFactor(me.user.id))) ? "aal2" : "aal1";
        return { data: { currentLevel: me.aal, nextLevel, currentAuthenticationMethods: [] }, error: null };
      },
      async listFactors() {
        const me = await currentAuthUser();
        if (!me) return { data: null, error: sessionMissing };
        const all = await listFactors(me.user.id);
        return { data: { all, totp: all.filter((f) => f.status === "verified"), phone: [] }, error: null };
      },
    },
    exchangeCodeForSession: unsupported("exchangeCodeForSession"),
    verifyOtp: unsupported("verifyOtp"),
    signInWithPassword: unsupported("signInWithPassword"),
    signInWithOAuth: unsupported("signInWithOAuth"),
  };
}

/** The admin client's `.auth` — `admin.*` against auth.users directly. */
export function adminAuth() {
  const wrap = <A extends unknown[], T>(fn: (...a: A) => Promise<T>) => async (...a: A) => {
    try {
      return { data: await fn(...a), error: null };
    } catch (e) {
      return { data: null, error: asErr(e) };
    }
  };
  return {
    ...serverAuth(),
    admin: {
      createUser: wrap(async (input: CreateUserInput) => ({ user: await createUser(input) })),
      updateUserById: wrap(async (id: string, input: UpdateUserInput) => ({ user: await updateUser(id, input) })),
      deleteUser: wrap(async (id: string) => { await deleteUser(id); return { user: null }; }),
      getUserById: wrap(async (id: string) => {
        const user = await getUserById(id);
        if (!user) throw new AuthError("User not found", "user_not_found", 404);
        return { user };
      }),
      listUsers: wrap(async (params?: { page?: number; perPage?: number }) => {
        const r = await listUsers(params?.page ?? 1, params?.perPage ?? 50);
        return { users: r.users, aud: "authenticated", total: r.total, nextPage: null, lastPage: 1 };
      }),
    },
  };
}
