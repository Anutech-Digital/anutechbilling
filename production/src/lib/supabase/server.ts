/**
 * Supabase SERVER client — for Server Components, Route Handlers, Server Actions.
 *
 * Reads cookies from the Next.js request so session persists across SSR.
 * Uses the modern getAll/setAll cookie API.
 *
 * @example In a Server Component:
 *   const supabase = createClient();
 *   const { data } = await supabase.from("leads").select("*");
 */
// IMPORTANT: side-effect import — initialises Sentry on first server-side
// import in the runtime. Workaround for the Next.js 14.2 standalone +
// Cloud Run bug where instrumentation.ts register() doesn't fire at boot
// (see src/lib/sentry.ts for details). Because every authenticated server
// path goes through this module, this single import guarantees Sentry is
// initialised before any error in the app can be captured.
import "@/lib/sentry";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";
import { createClient as createSupabaseJs } from "@supabase/supabase-js";
import { gatewayEnabled, gatewayFetch } from "@/server/postgrest/fetch";
import { authProvider } from "@/server/auth/authjs";
import { accessTokenForRequest, adminAuth, serverAuth } from "@/server/auth/compat";
import { actorHeaders } from "./admin-actor";

type ServerClient = ReturnType<typeof createServerClient<Database>>;

const noStoreFetch = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, cache: "no-store" });

/* AUTH_PROVIDER=authjs: the session is Auth.js's, not GoTrue's. The supabase-js client is built
   without its own auth module; requests carry a short-lived token minted for the Auth.js user
   (src/server/auth/supabase-jwt.ts), and `client.auth` answers from Auth.js
   (src/server/auth/compat.ts) — so the ~190 existing call sites keep working unchanged. */
function authjsClient(key: string, kind: "user" | "admin", headers: Record<string, string> = {}): ServerClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const client = createSupabaseJs<Database>(url, key, {
    accessToken: kind === "admin" ? async () => key : accessTokenForRequest,
    global: { headers, fetch: gatewayEnabled() ? gatewayFetch(url, { allowService: kind === "admin" }) : noStoreFetch },
  });
  return Object.assign(client, { auth: kind === "admin" ? adminAuth() : serverAuth() }) as unknown as ServerClient;
}

/* Next 15: cookies() returns a Promise. createClient() stays SYNCHRONOUS (≈390 call sites
   use `const supabase = createClient()`), and the await moves into the cookie callbacks —
   @supabase/ssr accepts async getAll/setAll. cookies() is still read inside the same
   request (every query runs within it), so behaviour is unchanged. */
export function createClient(): ServerClient {
  if (authProvider() === "authjs") return authjsClient(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, "user");
  const cookieStore = cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        async getAll() {
          return (await cookieStore).getAll();
        },
        async setAll(cookiesToSet) {
          const store = await cookieStore;
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              store.set(name, value, options),
            );
          } catch {
            // Called from a Server Component — read-only cookies.
            // Middleware refreshes the session, so this is safe to ignore here.
          }
        },
      },
      // DATA_GATEWAY=1: /rest/v1 is answered in-process by the Prisma gateway (src/server/postgrest)
      // instead of the VM's PostgREST. Auth and storage still go to the VM until they move.
      ...(gatewayEnabled()
        ? { global: { fetch: gatewayFetch(process.env.NEXT_PUBLIC_SUPABASE_URL!, { allowService: false }) } }
        : {}),
    },
  );
}

/**
 * Admin client using SERVICE_ROLE_KEY — bypasses RLS.
 * Use ONLY in trusted server code (route handlers, webhooks, migrations).
 * NEVER call from Server Components used in normal request flow.
 */
export function createAdminClient(): ServerClient {
  return adminClient({});
}

/**
 * R-051: the admin client for a write made ON BEHALF OF a signed-in user. Same as
 * createAdminClient(), plus the `x-actor-id` header, so the audit trigger (log_row_change,
 * record_contract_amendment) records that user instead of nobody. Pass only an id the route
 * has already verified (withRoute's `user.id` / auth.getUser()). An invalid id sends no
 * header (= plain createAdminClient()).
 */
export function createAdminClientFor(actorUserId: string): ServerClient {
  return adminClient(actorHeaders(actorUserId));
}

function adminClient(headers: Record<string, string>): ServerClient {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  if (authProvider() === "authjs") return authjsClient(process.env.SUPABASE_SERVICE_ROLE_KEY, "admin", headers);
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() {
          return [];
        },
        setAll() {
          /* no-op — admin client doesn't manage session */
        },
      },
      // Force fresh reads. Next.js App Router caches GET fetch() calls by
      // default, which would serve STALE admin data (e.g. a revoked API key
      // or an out-of-date payment/subscription status on /api/v1). Admin
      // queries must always hit the DB — never cache them.
      global: {
        headers,
        fetch: gatewayEnabled()
          ? gatewayFetch(process.env.NEXT_PUBLIC_SUPABASE_URL!, { allowService: true })
          : noStoreFetch,
      },
    },
  );
}
