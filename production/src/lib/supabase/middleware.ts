/**
 * Supabase MIDDLEWARE client — runs on every request to refresh sessions.
 *
 * Called from the root middleware.ts. Returns a Response that includes
 * refreshed cookies AND a Supabase client for the protection check.
 *
 * Uses the MODERN getAll/setAll cookie API (recommended by @supabase/ssr).
 * The legacy get/set/remove API has issues with chunked auth tokens when
 * the app is fronted by a proxy like Firebase Hosting → Cloud Run, because
 * the proxy may not forward all chunks together.
 */
import { createServerClient } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "./database.types";
import { gatewayEnabled, gatewayFetch } from "@/server/postgrest/fetch";
import { isUnreachableError, resilientFetch } from "./resilient-fetch";

/* R-710: the middleware runs on every request, so it gets a short leash — 4 s per attempt,
   one retry — instead of undici's 10 s connect timeout. auth-js does not retry getUser(). */
const middlewareFetch = resilientFetch({ label: "supabase-middleware", timeoutMs: 4000, retries: 1 });

export interface SessionResult {
  response: NextResponse;
  user: User | null;
  role: string | null;
  canViewDeals: boolean;
  needsMfa: boolean;
  /** R-710: the auth server could not be reached — "signed out" is NOT known, only "unknown". */
  authUnreachable: boolean;
}

export async function updateSession(request: NextRequest): Promise<SessionResult> {
  let response = NextResponse.next({
    request,
  });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Mirror cookies onto the request so any downstream reads in this
          // same middleware pass see the refreshed values…
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          // …and rebuild the response so the browser actually receives them.
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
      // DATA_GATEWAY=1: the role lookup below goes to the in-process gateway, not the VM.
      // Otherwise R-710's resilient fetch (4 s budget, 1 retry) to the VM.
      global: {
        fetch: gatewayEnabled()
          ? gatewayFetch(process.env.NEXT_PUBLIC_SUPABASE_URL!, { allowService: false })
          : middlewareFetch,
      },
    },
  );

  // IMPORTANT: getUser() validates the JWT against Supabase; getSession()
  // only decodes locally and is spoofable. Always use getUser() in middleware.
  /* R-710 (9 Oct 2026, 12:03–12:06 IST): when api.anutech.in did not answer, this call threw
     (AuthRetryableFetchError / TypeError fetch failed) and every page answered 5xx. Now a
     failure here is reported as authUnreachable; the root middleware decides what that means
     for the page asked for (public pages render signed-out, app pages get a retry page). */
  let user: User | null = null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error && isUnreachableError(error)) {
      console.error(`[middleware] auth unreachable: ${error.name}: ${error.message}`);
      return { response, user: null, role: null, canViewDeals: false, needsMfa: false, authUnreachable: true };
    }
    user = data?.user ?? null;
  } catch (e) {
    console.error(`[middleware] auth unreachable (thrown): ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return { response, user: null, role: null, canViewDeals: false, needsMfa: false, authUnreachable: true };
  }

  // Look up the app-level role (owner / manager / sales) + per-user
  // extension flags (can_view_deals) for route gating. Single-row PK
  // lookup; cost ≈ 1 ms. Cached at the Supabase edge anyway.
  let role: string | null = null;
  let canViewDeals = false;
  /* R-048 part 2: this session signed in with a password but has not passed the account's
     authenticator code yet (verified TOTP factor → nextLevel aal2, session still aal1).
     Read from the session JWT + the user's factors; no extra network call. */
  let needsMfa = false;
  if (user) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    needsMfa = aal?.nextLevel === "aal2" && aal?.currentLevel !== "aal2";
    const { data: me, error: meErr } = await supabase
      .from("users")
      .select("role, can_view_deals")
      .eq("id", user.id)
      .maybeSingle();
    /* R-710: an unknown role must not read as "no role" — the role guard below skips a null
       role, so a sales login would see every page during a blip. Report it as unreachable. */
    if (meErr && isUnreachableError(meErr)) {
      console.error(`[middleware] role lookup unreachable: ${meErr.message}`);
      return { response, user, role: null, canViewDeals: false, needsMfa, authUnreachable: true };
    }
    role = (me?.role as string | null) ?? null;
    canViewDeals = Boolean(me?.can_view_deals);
    /* Apprentice Academy (R-149): an apprentice is not a staff (public.users) row — they are
       academy_apprentices.user_id. RLS lets them read only their own row. */
    if (!me) {
      const { data: appr } = await supabase
        .from("academy_apprentices")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (appr) role = "apprentice";
    }
  }

  return { response, user, role, canViewDeals, needsMfa, authUnreachable: false };
}
