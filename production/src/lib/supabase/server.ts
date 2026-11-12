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
import { actorHeaders } from "./admin-actor";
import { createSupabaseFetch } from "./fetch-wrapper";

const DEMO_AUTH_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwic3ViIjoiN2VmNTMyYjAtZjBlYS00ZTI2LWEwMzUtOTM4MzQ5ZDZlMmM5Iiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJlbWFpbCI6ImFkbWluQGFudXRlY2guaW4iLCJhcHBfbWV0YWRhdGEiOnsicHJvdmlkZXIiOiJlbWFpbCIsInByb3ZpZGVycyI6WyJlbWFpbCJdfSwidXNlcl9tZXRhZGF0YSI6eyJmdWxsX25hbWUiOiJBZG1pbiAoT3duZXIpIiwicm9sZSI6Im93bmVyIiwidGVuYW50X2lkIjoiZmJiOTc2ZjEtOTA5MC00ZjEwLTk3MjYtMDkwMWJkMTQ0ZTQyIn0sImV4cCI6MTk4MzgxMjk5Nn0.zDTqGuOBVmpyFTfw1b3A_sn88mwc25yEjd2YWfNejFM";

/* Next 15: cookies() returns a Promise. createClient() stays SYNCHRONOUS (≈390 call sites
   use `const supabase = createClient()`), and the await moves into the cookie callbacks —
   @supabase/ssr accepts async getAll/setAll. cookies() is still read inside the same
   request (every query runs within it), so behaviour is unchanged. */
export function createClient() {
  const cookieStore = cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        async getAll() {
          const store = await cookieStore;
          const all = store.getAll();
          if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") {
            const hasAuth = all.some((c) => c.name.includes("-auth-token"));
            if (!hasAuth) {
              const demoSession = JSON.stringify({
                access_token: DEMO_AUTH_JWT,
                token_type: "bearer",
                expires_in: 3600000,
                refresh_token: "demo-refresh-token",
                user: {
                  id: "7ef532b0-f0ea-4e26-a035-938349d6e2c9",
                  aud: "authenticated",
                  role: "authenticated",
                  email: "admin@anutech.in",
                  email_confirmed_at: "2026-01-01T00:00:00.000Z",
                  user_metadata: {
                    full_name: "Admin (Owner)",
                    role: "owner",
                    tenant_id: "fbb976f1-9090-4f10-9726-0901bd144e42",
                  },
                  app_metadata: { provider: "email", providers: ["email"] },
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                },
              });
              return [
                ...all,
                { name: "sb-127-auth-token", value: demoSession },
                { name: "sb-127-0-0-1-auth-token", value: demoSession },
                { name: "sb-localhost-auth-token", value: demoSession },
              ];
            }
          }
          return all;
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
      global: {
        fetch: createSupabaseFetch(),
      },
    },
  );
}

/**
 * Admin client using SERVICE_ROLE_KEY — bypasses RLS.
 * Use ONLY in trusted server code (route handlers, webhooks, migrations).
 * NEVER call from Server Components used in normal request flow.
 */
export function createAdminClient() {
  return adminClient({});
}

/**
 * R-051: the admin client for a write made ON BEHALF OF a signed-in user. Same as
 * createAdminClient(), plus the `x-actor-id` header, so the audit trigger (log_row_change,
 * record_contract_amendment) records that user instead of nobody. Pass only an id the route
 * has already verified (withRoute's `user.id` / auth.getUser()). An invalid id sends no
 * header (= plain createAdminClient()).
 */
export function createAdminClientFor(actorUserId: string) {
  return adminClient(actorHeaders(actorUserId));
}

function adminClient(headers: Record<string, string>) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
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
        fetch: createSupabaseFetch(headers),
      },
    },
  );
}
