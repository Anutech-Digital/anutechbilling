/**
 * A `fetch` for supabase-js that sends `/rest/v1/...` (and, with STORAGE_BACKEND set,
 * `/storage/v1/...`) to the in-process gateway instead of the
 * VM's PostgREST. Everything else (auth `/auth/v1`, storage `/storage/v1`) still goes over the
 * network as before, until those parts move too.
 *
 * Used by the SERVER clients (src/lib/supabase/server.ts). The identity comes from the
 * Authorization header supabase-js attaches — the user's session token, or the service-role key
 * for createAdminClient — verified exactly as PostgREST verified it.
 */
import "server-only";
import { storageGatewayEnabled } from "@/server/storage/backend";
import { handlePostgrest } from "./handler";
import { handleStorage } from "./storage";
import { identityFromHeaders } from "./identity";
import { PgrstError } from "./parse";

export function gatewayEnabled(): boolean {
  return process.env.DATA_GATEWAY === "1";
}

export function gatewayFetch(base: string, opts: { allowService: boolean }): typeof fetch {
  const restPrefix = base.replace(/\/+$/, "") + "/rest/v1/";
  const storagePrefix = base.replace(/\/+$/, "") + "/storage/v1/";
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // STORAGE_BACKEND set: /storage/v1 is answered in-process too (src/server/postgrest/storage.ts).
    if (storageGatewayEnabled() && href.startsWith(storagePrefix)) {
      const request = new Request(href, { method: init?.method ?? "GET", headers: init?.headers, body: init?.body ?? null, duplex: "half" } as RequestInit);
      try {
        return await handleStorage(request, href.slice(storagePrefix.length).split("?")[0], identityFromHeaders(request.headers, opts));
      } catch (e) {
        const err = e instanceof PgrstError ? e : new PgrstError(500, "PGRST000", (e as Error).message);
        return new Response(JSON.stringify({ statusCode: String(err.status), error: err.code, message: err.message }), {
          status: err.status, headers: { "Content-Type": "application/json" },
        });
      }
    }
    if (!href.startsWith(restPrefix)) return fetch(input, { ...init, cache: "no-store" });
    const url = new URL(href);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    let body: string | null = null;
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body != null) body = await new Response(init.body).text();
    try {
      const identity = identityFromHeaders(headers, opts);
      return await handlePostgrest({
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        path: href.slice(restPrefix.length).split("?")[0],
        search: url.searchParams,
        headers,
        body,
      }, identity);
    } catch (e) {
      const err = e instanceof PgrstError ? e : new PgrstError(500, "PGRST000", (e as Error).message);
      return new Response(JSON.stringify({ code: err.code, details: err.details, hint: err.hint, message: err.message }), {
        status: err.status, headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
  };
}
