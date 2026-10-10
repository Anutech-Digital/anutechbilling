/**
 * Auth.js (next-auth v5) — replaces GoTrue on the VM when AUTH_PROVIDER=authjs.
 *
 * Sessions are signed+encrypted JWT cookies (AUTH_SECRET); accounts live in GoTrue's own
 * auth.users (./accounts.ts), so passwords, Google accounts and two-step factors carry over.
 *
 *   email + password  → Credentials provider → ./accounts.checkPassword (bcrypt, GoTrue hashes)
 *                       unconfirmed email is refused (R-048 part 1)
 *   Google            → Google provider → linked to the EXISTING account (R-529: Google identity,
 *                       then the public.users profile for the verified email, then auth.users
 *                       by email) — created only when the address is new. Unverified → refused.
 *                       Its access token stays in the encrypted cookie for Contacts / Reseller
 *                       import and is read on the server only (R-528: never in the session JSON).
 *   two-step (R-048)  → after password, a session with a verified factor is aal1; the /mfa
 *                       page calls update({ mfaCode }) and the code is checked HERE, server-side,
 *                       before the session becomes aal2. Nothing the browser sends is trusted.
 */
import "server-only";
import NextAuth, { CredentialsSignin, type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { checkPassword, ensureOAuthUser, recordSignIn } from "./accounts";
import { hasVerifiedFactor, verifyCode } from "./mfa";
import { publicSession } from "./session-public";

class LoginError extends CredentialsSignin {
  constructor(code: string) {
    super();
    this.code = code;
  }
}

declare module "next-auth" {
  interface Session {
    aal: "aal1" | "aal2";
    mfaEnrolled: boolean;
    user: { id: string; email: string; name?: string | null; image?: string | null };
  }
}

interface Token {
  uid?: string;
  email?: string | null;
  aal?: "aal1" | "aal2";
  mfa?: boolean;
  gat?: string;
  grt?: string;
  gexp?: number;
  /** R-824: the scopes Google granted with gat — so a missing permission is named, not guessed. */
  gscope?: string;
  [k: string]: unknown;
}

const googleId = process.env.AUTH_GOOGLE_ID ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
const googleSecret = process.env.AUTH_GOOGLE_SECRET ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;

export const authConfig: NextAuthConfig = {
  trustHost: true,
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: { signIn: "/login", error: "/login" },
  providers: [
    Credentials({
      id: "credentials",
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const email = typeof raw?.email === "string" ? raw.email : "";
        const password = typeof raw?.password === "string" ? raw.password : "";
        if (!email || !password) throw new LoginError("invalid_credentials");
        const r = await checkPassword(email, password);
        if (!r.ok) throw new LoginError(r.reason);
        await recordSignIn(r.user.id);
        return { id: r.user.id, email: r.user.email, name: (r.user.user_metadata.full_name as string | undefined) ?? null };
      },
    }),
    ...(googleId && googleSecret
      ? [Google({
          clientId: googleId,
          clientSecret: googleSecret,
          authorization: { params: { scope: "openid email profile", access_type: "offline", prompt: "select_account" } },
        })]
      : []),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === "google") {
        // Only an address Google itself has verified may sign in to (or create) an account.
        return profile?.email_verified === true && typeof profile.email === "string";
      }
      return true;
    },
    async jwt({ token, user, account, profile, trigger, session }) {
      const t = token as Token;
      if (account?.provider === "google" && typeof profile?.email === "string") {
        const r = await ensureOAuthUser({
          email: profile.email,
          emailVerified: profile.email_verified === true,
          name: (profile.name as string | undefined) ?? null,
          provider: "google",
          subject: typeof profile.sub === "string" ? profile.sub : account.providerAccountId,
        });
        if (!r.ok) throw new LoginError(r.reason);
        const u = r.user;
        await recordSignIn(u.id);
        t.uid = u.id;
        t.email = u.email;
        t.gat = account.access_token;
        t.grt = account.refresh_token ?? t.grt;
        t.gexp = account.expires_at;
        t.gscope = typeof account.scope === "string" ? account.scope : undefined;
      } else if (user?.id) {
        t.uid = user.id;
        t.email = user.email;
      }
      if (user || account) {
        t.mfa = t.uid ? await hasVerifiedFactor(t.uid) : false;
        t.aal = "aal1";
      }
      if (trigger === "update" && t.uid && session && typeof session === "object") {
        const s = session as { mfaCode?: unknown; factorId?: unknown; refreshMfa?: unknown };
        if (typeof s.mfaCode === "string") {
          const ok = await verifyCode(t.uid, s.mfaCode, typeof s.factorId === "string" ? s.factorId : undefined);
          if (ok) { t.aal = "aal2"; t.mfa = true; }
        }
        if (s.refreshMfa === true) {
          t.mfa = await hasVerifiedFactor(t.uid);
          if (!t.mfa) t.aal = "aal1";
        }
      }
      return t;
    },
    async session({ session, token }) {
      // R-528: an allow-list, never the token — Google tokens (gat/grt) must not reach the browser.
      return publicSession(session, token) as unknown as typeof session;
    },
  },
};

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth(authConfig);

export function authProvider(): "gotrue" | "authjs" {
  return process.env.AUTH_PROVIDER === "authjs" ? "authjs" : "gotrue";
}
