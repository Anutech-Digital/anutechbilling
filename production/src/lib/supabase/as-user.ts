/**
 * A Supabase client that runs AS ONE USER, for a server path that has no cookie session — the
 * MCP connector (docs/MCP.md). It mints the same 10-minute HS256 token the app mints for an
 * Auth.js session (server/auth/supabase-jwt.ts), so RLS sees an ordinary signed-in user.
 *
 * ⚠️ Call it only for a user id the caller has already proved (MCP: a verified access token
 * whose connection row is still active). It is never a service-role client, and it reaches the
 * database through the in-process gateway when DATA_GATEWAY is on, like createClient().
 */
import "server-only";
import { createClient as createSupabaseJs, type SupabaseClient } from "@supabase/supabase-js";
import { gatewayEnabled, gatewayFetch } from "@/server/postgrest/fetch";
import { mintSupabaseJwt } from "@/server/auth/supabase-jwt";

const noStoreFetch = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, cache: "no-store" });

export function createClientAsUser(userId: string, email: string, aal: "aal1" | "aal2"): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set");
  let minted: { token: string; expiresAt: number } | null = null;
  return createSupabaseJs(url, anon, {
    accessToken: async () => {
      if (!minted || minted.expiresAt - 60 < Math.floor(Date.now() / 1000)) {
        minted = mintSupabaseJwt({ userId, email, aal });
      }
      return minted.token;
    },
    global: { fetch: gatewayEnabled() ? gatewayFetch(url, { allowService: false }) : noStoreFetch },
  });
}
