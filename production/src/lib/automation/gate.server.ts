/**
 * R-897: the server side of the automation gate — reads and stamps public.automation_jobs.
 *
 * Every read FAILS CLOSED. "Could not find out whether this job may run" is answered "off":
 * the whole point of the gate is the moment somebody wants things stopped, and a database
 * blip is no reason to start emailing customers.
 *
 * Service role, through a bare no-store client (CLAUDE.md §17: a cached "is it on?" is the
 * worst thing to cache). automation_jobs is not in the generated Database type (adding a
 * table regenerates a 14k-line file other workers touch every day), so the tenant filter on
 * each query below is written out — `tenantId` always comes from a verified session or from
 * automation_cron_tenants(), never from a request body.
 */
import "server-only";
import { createBareClient } from "@/lib/supabase/bare";
import { stateOf, type AutomationState, type AutomationSwitch } from "./jobs";

export interface AutomationJobRow {
  job: string;
  enabled: boolean;
  dry_run: boolean;
  last_run_at: string | null;
  last_result: string | null;
  changed_by: string | null;
  changed_at: string | null;
}

function bare() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

/** All of one company's rows, for the /automation page. Null = could not read. */
export async function readTenantJobs(tenantId: string): Promise<AutomationJobRow[] | null> {
  const db = bare();
  if (!db) return null;
  const { data, error } = await db
    .from("automation_jobs")
    .select("job, enabled, dry_run, last_run_at, last_result, changed_by, changed_at")
    .eq("tenant_id", tenantId);          // <- the only tenant boundary on this read
  if (error) {
    console.error("[automation] could not read automation_jobs:", error.message);
    return null;
  }
  return (data ?? []) as AutomationJobRow[];
}

/** One switch for one company. Kill switch and missing row = "off"; any failure = "off". */
export async function automationState(tenantId: string, job: AutomationSwitch): Promise<AutomationState> {
  const db = bare();
  if (!db) return "off";
  const { data, error } = await db.rpc("automation_state", { p_job: job, p_tenant: tenantId });
  if (error) {
    console.error(`[automation] state read failed for ${job} — treating as OFF:`, error.message);
    return "off";
  }
  return data === "on" || data === "dry_run" ? data : "off";
}

/** Companies where a cron job is ON or in dry run (kill switch respected). Null = could not read. */
export async function cronTenants(job: string): Promise<{ on: string[]; dry: string[] } | null> {
  const db = bare();
  if (!db) return null;
  const { data, error } = await db.rpc("automation_cron_tenants", { p_job: job });
  if (error) {
    console.error(`[automation] could not read where ${job} is on — treating as OFF:`, error.message);
    return null;
  }
  const on: string[] = [];
  const dry: string[] = [];
  for (const r of (data ?? []) as { tenant_id: string; dry_run: boolean }[]) {
    (stateOf({ enabled: true, dry_run: r.dry_run }) === "dry_run" ? dry : on).push(r.tenant_id);
  }
  return { on, dry };
}

/** Stamps last_run_at / last_result. Never throws — a failed stamp must not fail the job. */
export async function recordRun(job: string, tenantIds: readonly string[], result: string): Promise<void> {
  const ids = [...new Set(tenantIds)].filter(Boolean);
  if (ids.length === 0) return;
  const db = bare();
  if (!db) return;
  try {
    const { error } = await db.rpc("automation_record_run", {
      p_job: job, p_tenants: ids, p_result: result.slice(0, 500),
    });
    if (error) console.error(`[automation] could not record the ${job} run:`, error.message);
  } catch (e) {
    console.error(`[automation] recording the ${job} run crashed:`, (e as Error).message);
  }
}

/** One company's row for one job. null = no row; undefined = could not read. */
export async function readJobRow(tenantId: string, job: string): Promise<AutomationJobRow | null | undefined> {
  const db = bare();
  if (!db) return undefined;
  const { data, error } = await db
    .from("automation_jobs")
    .select("job, enabled, dry_run, last_run_at, last_result, changed_by, changed_at")
    .eq("tenant_id", tenantId)          // <- the only tenant boundary on this read
    .eq("job", job)
    .maybeSingle();
  if (error) {
    console.error(`[automation] could not read the ${job} switch:`, error.message);
    return undefined;
  }
  return (data ?? null) as AutomationJobRow | null;
}

/**
 * A default-ON safety job with no row gets an explicit ON row before its first run is stamped —
 * otherwise automation_record_run() would create the row as enabled = false and the next run
 * would read "off". Only for SAFETY_JOBS_DEFAULT_ON (the caller checks). Never throws.
 */
export async function ensureDefaultOnRow(tenantId: string, job: string): Promise<void> {
  const db = bare();
  if (!db) return;
  try {
    const { error } = await db
      .from("automation_jobs")
      .upsert({ tenant_id: tenantId, job, enabled: true }, { onConflict: "tenant_id,job", ignoreDuplicates: true });
    if (error) console.error(`[automation] could not write the default-on row for ${job}:`, error.message);
  } catch (e) {
    console.error(`[automation] default-on row for ${job} crashed:`, (e as Error).message);
  }
}
