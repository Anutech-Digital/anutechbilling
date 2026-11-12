/**
 * fetch-wrapper.ts — Fail-fast fetch wrapper for Supabase client & server.
 *
 * In local development with NEXT_PUBLIC_DEMO_MODE=true:
 * 1. Fast-paths /auth/v1/user and /rest/v1/users to return mock owner user immediately (0ms).
 * 2. Injects authenticated owner JWT for PostgREST (/rest/v1/*) so RLS resolves tenant_id
 *    (fbb976f1-9090-4f10-9726-0901bd144e42, Anutech Digital Pvt Ltd) to show seeded sample data.
 * 3. Enforces a 2500ms timeout on connections to local Supabase URL (e.g. 127.0.0.1:54321),
 *    preventing the 20-second Node.js / Browser TCP connection timeout when local DB is stopped.
 * 4. Gracefully falls back to empty responses instead of throwing 500 / 401 when local DB is unreachable.
 */

const DEMO_OWNER_ID = "7ef532b0-f0ea-4e26-a035-938349d6e2c9";
const DEMO_TENANT_ID = "fbb976f1-9090-4f10-9726-0901bd144e42";
const DEMO_AUTH_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwic3ViIjoiN2VmNTMyYjAtZjBlYS00ZTI2LWEwMzUtOTM4MzQ5ZDZlMmM5Iiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJlbWFpbCI6ImFkbWluQGFudXRlY2guaW4iLCJhcHBfbWV0YWRhdGEiOnsicHJvdmlkZXIiOiJlbWFpbCIsInByb3ZpZGVycyI6WyJlbWFpbCJdfSwidXNlcl9tZXRhZGF0YSI6eyJmdWxsX25hbWUiOiJBZG1pbiAoT3duZXIpIiwicm9sZSI6Im93bmVyIiwidGVuYW50X2lkIjoiZmJiOTc2ZjEtOTA5MC00ZjEwLTk3MjYtMDkwMWJkMTQ0ZTQyIn0sImV4cCI6MTk4MzgxMjk5Nn0.zDTqGuOBVmpyFTfw1b3A_sn88mwc25yEjd2YWfNejFM";

function getTimeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

export function createSupabaseFetch(extraHeaders?: Record<string, string>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const isDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (isDemoMode) {
      if (urlStr.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: DEMO_OWNER_ID,
            aud: "authenticated",
            role: "authenticated",
            email: "admin@anutech.in",
            email_confirmed_at: "2026-01-01T00:00:00.000Z",
            user_metadata: {
              full_name: "Admin (Owner)",
              role: "owner",
              tenant_id: DEMO_TENANT_ID,
            },
            app_metadata: { provider: "email", providers: ["email"] },
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      if (urlStr.includes("/rest/v1/users")) {
        const accept = (init?.headers as Record<string, string> | undefined)?.["Accept"] || "";
        const isSingle = accept.includes("vnd.pgrst.object+json");
        const userData = {
          id: DEMO_OWNER_ID,
          tenant_id: DEMO_TENANT_ID,
          role: "owner",
          full_name: "Admin (Owner)",
          can_view_deals: true,
        };
        return new Response(
          JSON.stringify(isSingle ? userData : [userData]),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "content-range": "0-0/1",
            },
          }
        );
      }
    }

    const timeoutMs = isDemoMode ? 2500 : 10000;
    const timeoutSignal = getTimeoutSignal(timeoutMs);
    const signal = init?.signal
      ? (typeof AbortSignal.any === "function"
          ? AbortSignal.any([init.signal, timeoutSignal])
          : timeoutSignal)
      : timeoutSignal;

    // Build headers and inject authenticated demo JWT if running in demo mode
    const headers = new Headers(init?.headers);
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        headers.set(k, v);
      }
    }

    if (isDemoMode) {
      const auth = headers.get("authorization") || headers.get("Authorization");
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
      if (!auth || (anonKey && auth.includes(anonKey))) {
        headers.set("Authorization", `Bearer ${DEMO_AUTH_JWT}`);
      }
    }

    try {
      return await fetch(input, {
        ...init,
        headers,
        signal,
        cache: "no-store",
      });
    } catch (err) {
      if (isDemoMode) {
        const accept = headers.get("Accept") || headers.get("accept") || "";
        const isSingle = accept.includes("vnd.pgrst.object+json");
        return new Response(isSingle ? "{}" : "[]", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "content-range": "0-0/0",
          },
        });
      }
      throw err;
    }
  };
}
