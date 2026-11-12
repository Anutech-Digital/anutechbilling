/**
 * fetch-wrapper.ts — Fail-fast fetch wrapper for Supabase client & server.
 *
 * In local development with NEXT_PUBLIC_DEMO_MODE=true:
 * 1. Fast-paths /auth/v1/user and /rest/v1/users to return mock owner user immediately (0ms).
 * 2. Enforces a 300ms timeout on connections to local Supabase URL (e.g. 127.0.0.1:54321),
 *    preventing the 20-second Node.js / Browser TCP connection timeout when local DB is stopped.
 * 3. Gracefully falls back to empty responses instead of throwing 500 / 401 when local DB is unreachable.
 */

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
            id: "fbb976f1-9090-4f10-9726-0901bd144e42-user",
            aud: "authenticated",
            role: "authenticated",
            email: "admin@anutech.in",
            email_confirmed_at: "2026-01-01T00:00:00.000Z",
            user_metadata: { full_name: "Admin (Owner)" },
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
          id: "fbb976f1-9090-4f10-9726-0901bd144e42-user",
          tenant_id: "fbb976f1-9090-4f10-9726-0901bd144e42",
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

    const timeoutMs = isDemoMode ? 300 : 10000;
    const timeoutSignal = getTimeoutSignal(timeoutMs);
    const signal = init?.signal
      ? (typeof AbortSignal.any === "function"
          ? AbortSignal.any([init.signal, timeoutSignal])
          : timeoutSignal)
      : timeoutSignal;

    const headers = extraHeaders
      ? { ...init?.headers, ...extraHeaders }
      : init?.headers;

    try {
      return await fetch(input, {
        ...init,
        headers,
        signal,
        cache: "no-store",
      });
    } catch (err) {
      if (isDemoMode) {
        const accept = (init?.headers as Record<string, string> | undefined)?.["Accept"] || "";
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
