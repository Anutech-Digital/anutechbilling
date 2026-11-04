/**
 * R-2165 (G-ADS-AI, AI-09) — the one call from the app to public.marketing_metrics_query.
 *
 * Through withTenant (app_runtime → authenticated, app.user_id / app.tenant_id set first), so
 * the function's own role check, current_tenant_id() and every table's RLS see THIS person.
 * Every value is a bound parameter ($queryRaw tagged template) — nothing is spliced into SQL.
 * The database re-checks the allowlists; its refusals come back as NeoError.
 */
import "server-only";
import { withTenant, type TenantSession } from "@/server/db";
import { NeoError } from "./graph";
import type { MetricsResult, MetricsRpcArgs } from "./plan";

/** A database refusal → the reason a person can read (or null for an unexpected failure). */
export function neoDbRefusal(e: unknown): NeoError | null {
  const err = e as { message?: unknown; meta?: unknown; cause?: unknown } | null;
  const text = [err?.message, JSON.stringify(err?.meta ?? null), String(err?.cause ?? "")].map((x) => String(x ?? "")).join(" ");
  if (/42501|only the owner and the marketing team/.test(text)) {
    return new NeoError("Marketing numbers are for the owner and the marketing team.", 403);
  }
  const m = text.match(/marketing_metrics_query: ([^"\\\n]+)/);
  if (m) return new NeoError(`Neo could not ask that: ${m[1].trim()}.`, 400);
  return null;
}

export function neoQueryFor(session: TenantSession) {
  return async (a: MetricsRpcArgs): Promise<MetricsResult> => {
    try {
      const rows = await withTenant(session, (tx) => tx.$queryRaw<Array<{ r: MetricsResult }>>`
        select public.marketing_metrics_query(
          ${a.metrics}::text[], ${a.dimensions}::text[], ${a.from}::date, ${a.to}::date,
          ${a.campaign}::text, ${a.platform}::text, ${a.sort}::text, ${a.sortDesc}::boolean, ${a.limit}::integer
        ) as r`);
      const r = rows[0]?.r;
      if (!r) throw new Error("marketing_metrics_query returned nothing");
      return r;
    } catch (e) {
      throw neoDbRefusal(e) ?? e;
    }
  };
}
