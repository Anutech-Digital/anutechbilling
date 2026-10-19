/**
 * R-1499 (19 Oct 2026) — which company the public website (quote, enquiry, callback, AI chat,
 * trial, buy page, DMS upgrade request) files its leads and reads its catalogue under.
 *
 * Every one of those routes used to say `BUY_PAGE_TENANT_ID || "fbb976f1-…"` — the LIVE Anutech
 * tenant. On a laptop without the env var that meant a /quote press tried to file a lead under the
 * live company's id (Pawan, 17 Oct: "lead insert failed 23503" locally — and with the old
 * live-domain default in site/lib/config.ts the request itself went to the LIVE app).
 *
 *   BUY_PAGE_TENANT_ID set   → that tenant (every environment);
 *   production build, unset  → the live Anutech tenant, exactly as before (live is unchanged);
 *   anything else, unset     → null. The caller refuses with WEBSITE_TENANT_MISSING_MESSAGE —
 *                              never the live tenant id.
 *
 * Read at call time (not module load) so a test or a restarted dev server sees the current env.
 */

type Env = Record<string, string | undefined>;

/** The live Anutech tenant — the production fallback only. */
export const LIVE_WEBSITE_TENANT_ID = "fbb976f1-9090-4f10-9726-0901bd144e42";

/** §24: what happened, why, what to do — for the developer who hits it on a laptop. */
export const WEBSITE_TENANT_MISSING_MESSAGE =
  "This website form is not connected to a company on this computer, so nothing was saved. " +
  "BUY_PAGE_TENANT_ID is not set, and outside production the app will not fall back to the live company. " +
  "Set BUY_PAGE_TENANT_ID in .env.local to your local workspace's id (select id, name from tenants in the local database), then restart the dev server.";

export function websiteTenantId(env: Env = process.env): string | null {
  const v = (env.BUY_PAGE_TENANT_ID ?? "").trim();
  if (v) return v;
  if (env.NODE_ENV === "production") return LIVE_WEBSITE_TENANT_ID;
  return null;
}

/** JSON body + status for a route that cannot run without the website tenant. */
export function websiteTenantMissingBody(): { ok: false; error: string; code: "WEBSITE_TENANT_MISSING" } {
  return { ok: false, error: WEBSITE_TENANT_MISSING_MESSAGE, code: "WEBSITE_TENANT_MISSING" };
}
