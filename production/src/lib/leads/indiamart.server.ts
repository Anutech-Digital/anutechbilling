/**
 * S34 — pull IndiaMART enquiries into leads for every company that has saved a CRM key.
 *
 * No key anywhere = nothing to do: the run returns `disabled: true` without a single network
 * call. That is the "cron disabled when no key" rule — the job can be scheduled today and
 * stays silent until a key is saved.
 *
 * The key is part of the URL (IndiaMART's API design, not ours), so the URL is NEVER logged
 * and never goes into an error message.
 *
 * indiamart_* tables and the import function are not in the generated Database type
 * (AGENTS.md L31) — reached through an untyped handle with explicit tenant filters.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { createAdminClient } from "@/lib/supabase/server";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { cronTenantAllowed } from "@/lib/automation/cron-gate";
import {
  indiamartImportArgs, indiamartUrl, parseIndiamartResponse, pullWindow, RATE_LIMIT_BACKOFF_MINUTES,
} from "./indiamart";

/* Schema-less client (see header) — same pattern as lib/contacts/primary.ts. */
type Untyped = Pick<SupabaseClient, "from" | "rpc">;

export interface IndiamartRunResult {
  ok: true;
  disabled: boolean;
  tenants: number;
  imported: number;
  duplicates: number;
  skipped_rows: number;
  rate_limited: number;
  failed: number;
  errors: { tenant_id: string; message: string }[];
}

export async function runIndiamartPull(opts: {
  admin: ReturnType<typeof createAdminClient>;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<IndiamartRunResult> {
  const db = opts.admin as unknown as Untyped;
  const now = opts.now ?? new Date();
  const doFetch = opts.fetchImpl ?? fetch;
  const result: IndiamartRunResult = {
    ok: true, disabled: false, tenants: 0, imported: 0, duplicates: 0, skipped_rows: 0,
    rate_limited: 0, failed: 0, errors: [],
  };

  const { data: keys, error: keyErr } = await db.from("tenant_secrets")
    .select("tenant_id, indiamart_crm_key").not("indiamart_crm_key", "is", null);
  if (keyErr) {
    result.failed++;
    result.errors.push({ tenant_id: "(all)", message: `tenant_secrets read failed: ${keyErr.message}` });
    return result;
  }
  const rows = ((keys ?? []) as { tenant_id: string; indiamart_crm_key: string | null }[])
    .filter((r) => (r.indiamart_crm_key ?? "").trim() !== "");
  if (rows.length === 0) { result.disabled = true; return result; }

  for (const row of rows) {
    /* R-897 */ if (!cronTenantAllowed(row.tenant_id)) continue;
    result.tenants++;
    const tenantId = row.tenant_id;
    try {
      const { data: state } = await db.from("indiamart_sync_state")
        .select("last_end_at, next_allowed_at").eq("tenant_id", tenantId).maybeSingle();
      const st = (state ?? null) as { last_end_at: string | null; next_allowed_at: string | null } | null;
      if (st?.next_allowed_at && new Date(st.next_allowed_at) > now) { result.rate_limited++; continue; }

      const key = decryptTenantSecrets(row)?.indiamart_crm_key?.trim();
      if (!key) continue;
      const { start, end } = pullWindow(st?.last_end_at ? new Date(st.last_end_at) : null, now);

      let status = 0; let json: unknown = null;
      try {
        const res = await doFetch(indiamartUrl(key, start, end), {
          method: "GET", cache: "no-store", signal: AbortSignal.timeout(30_000),
        });
        status = res.status;
        json = await res.json().catch(() => null);
      } catch (e) {
        throw new Error(`IndiaMART unreachable: ${e instanceof Error ? e.name : "network error"}`);
      }

      const parsed = parseIndiamartResponse(json, status);
      if (!parsed.ok) {
        if (parsed.kind === "rate_limited") {
          result.rate_limited++;
          await saveState(db, tenantId, {
            last_run_at: now.toISOString(), last_ok: false, last_error: `rate limited: ${parsed.message}`.slice(0, 500),
            next_allowed_at: new Date(now.getTime() + RATE_LIMIT_BACKOFF_MINUTES * 60_000).toISOString(),
          });
          continue;
        }
        throw new Error(parsed.kind === "auth"
          ? `IndiaMART rejected the CRM key (${parsed.message}). Owner: Marketing Hub → IndiaMART leads (/marketing/indiamart) par key dobara save karo.`
          : `IndiaMART error: ${parsed.message}`);
      }

      result.skipped_rows += parsed.skipped;
      let imported = 0;
      for (const lead of parsed.leads) {
        const { data: leadId, error } = await db.rpc("import_indiamart_lead", indiamartImportArgs(tenantId, lead));
        if (error) {
          result.failed++;
          result.errors.push({ tenant_id: tenantId, message: `query ${lead.queryId}: ${error.message}`.slice(0, 300) });
          continue;
        }
        if (leadId) { imported++; result.imported++; } else { result.duplicates++; }
      }

      /* Window aage tabhi badhao jab poora batch bina error ke gaya — warna agla run wahi
         window dobara maange, aur dedupe jo aa chuka use chhod dega. */
      const clean = !result.errors.some((e) => e.tenant_id === tenantId);
      await saveState(db, tenantId, {
        ...(clean ? { last_end_at: end.toISOString() } : {}),
        last_run_at: now.toISOString(), last_ok: clean,
        last_error: clean ? null : "some enquiries failed to import — see the cron log",
        last_imported: imported, next_allowed_at: null,
      });
    } catch (e) {
      result.failed++;
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push({ tenant_id: tenantId, message: message.slice(0, 300) });
      await saveState(db, tenantId, { last_run_at: now.toISOString(), last_ok: false, last_error: message.slice(0, 500) })
        .catch(() => undefined);
    }
  }
  return result;
}

async function saveState(db: Untyped, tenantId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("indiamart_sync_state")
    .upsert({ tenant_id: tenantId, ...patch }, { onConflict: "tenant_id" });
  if (error) throw new Error(`indiamart_sync_state write failed: ${error.message}`);
}
