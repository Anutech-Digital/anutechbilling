/**
 * Raat ka backup — ek-ek tenant karke (S15, 28 Sep 2026).
 *
 * ─── KYUN ───────────────────────────────────────────────────────────────────
 * Purana raasta: `backup_all_tenants()` = ek RPC = EK transaction me har tenant ka 145-table
 * snapshot; phir `export_snapshots_for_offsite()` sabka ek jsonb, jo yahan RAM me ek string
 * banta. 3 tenant par theek, 50 par ek lamba transaction aur 1 GB jsonb seema ki taraf badhta
 * object — aur fail usi din jis din data sabse zyada ho.
 *
 * Naya: har tenant = apna `backup_tenant()` call (apna transaction) → apna export → apna
 * GCS object (`daily/YYYY-MM-DD/<tenant_id>.json`). Ek tenant ka fail hona baaki kisi ko nahi
 * rokta — na unka DB snapshot, na unki off-site copy. Pehle ek bhi tenant fail hota to
 * route 500 lauta deta tha aur off-site upload KISI ka nahi hota tha.
 *
 * Ye file sirf kram aur faisle rakhti hai; network (Supabase, metadata token, GCS) route
 * `deps` me deta hai, taaki poora raasta bina upload ke test ho.
 */
import { runSweepWithRetry, type SweepAttempt } from "./sweep-retry";
import {
  offsiteEnvelope,
  offsiteRefusal,
  offsiteTenantObjectName,
  offsiteTenantMonthlyName,
  offsiteManifestName,
  offsiteObjectName,
  offsiteWindowStart,
  type OffsiteSnapshot,
} from "./offsite";

export interface TenantRow {
  id: string;
  name: string | null;
}

/** `backup_tenant()` ka jawab (jsonb). */
export interface TenantBackupInfo {
  id?: string;
  bytes?: number;
  table_count?: number;
  label?: string;
}

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export interface PerTenantDeps {
  now: Date;
  projectRef: string;
  listTenants(): Promise<Result<TenantRow[]>>;
  backupTenant(tenantId: string): Promise<SweepAttempt<TenantBackupInfo>>;
  exportTenant(tenantId: string, since: Date): Promise<Result<OffsiteSnapshot | null>>;
  /** `null` = upload ho gaya; string = kyun nahi hua. */
  upload(name: string, body: string): Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  /** Ek saath kitne tenant. RAM me itne hi payload ek waqt par. */
  concurrency?: number;
}

export interface TenantOutcome {
  tenant_id: string;
  tenant: string;
  ok: boolean;
  bytes?: number;
  tables?: number;
  error?: string;
  offsite: "ok" | "failed" | "skipped";
  offsite_error?: string;
  /** Kitni baar dobara koshish hui (retry ki wajah log ke liye). */
  retried: string[];
}

export interface PerTenantReport {
  /** Migration 20260928141000 abhi laga nahi — route purane raaste par jaaye. */
  missingFunction: boolean;
  label: string | null;
  backed_up: number;
  failed: number;
  total_bytes: number;
  offsite_ok: number;
  results: TenantOutcome[];
  /** Off-site ki naakamiyan (DB backup hua, bahar copy nahi) + manifest ki. */
  offsite_errors: string[];
}

/* PostgREST "function nahi mili" — PGRST202, ya Postgres 42883. Sirf yahi purane raaste par
   bhejta hai; baaki har galti us tenant ka fail hai. */
const MISSING_FN = /pgrst202|could not find the function|function public\.backup_tenant\b.*does not exist/i;

export function isMissingFunction(message: string): boolean {
  return MISSING_FN.test(message);
}

const DEFAULT_CONCURRENCY = 3;

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

async function oneTenant(
  t: TenantRow,
  deps: PerTenantDeps,
  first: SweepAttempt<TenantBackupInfo> | null,
): Promise<TenantOutcome & { label?: string }> {
  const name = t.name ?? t.id;
  const retried: string[] = [];
  let run: SweepAttempt<TenantBackupInfo>;
  if (first) {
    run = first;
  } else {
    const r = await runSweepWithRetry(() => deps.backupTenant(t.id), { sleep: deps.sleep });
    run = r.result;
    retried.push(...r.retriedBecause);
  }

  if (!run.ok) {
    return { tenant_id: t.id, tenant: name, ok: false, error: run.message, offsite: "skipped", retried };
  }

  const out: TenantOutcome & { label?: string } = {
    tenant_id: t.id,
    tenant: name,
    ok: true,
    bytes: run.data.bytes,
    tables: run.data.table_count,
    label: run.data.label,
    offsite: "failed",
    retried,
  };

  /* DB snapshot ho chuka. Ab bahar ki copy — iski naakami tenant ko "failed" nahi banati
     (snapshot bacha hai), par offsite_errors me jaakar subah ki digest me dikhti hai. */
  const exp = await deps.exportTenant(t.id, offsiteWindowStart(deps.now));
  if (!exp.ok) {
    out.offsite_error = `could not read the snapshot: ${exp.message}`;
    return out;
  }
  const env = offsiteEnvelope(deps.now, deps.projectRef, exp.data ? [exp.data] : []);
  const refusal = offsiteRefusal(env, 1);
  if (refusal) {
    out.offsite_error = refusal;
    return out;
  }

  const body = JSON.stringify(env);
  const dailyErr = await deps.upload(offsiteTenantObjectName(deps.now, t.id), body);
  if (dailyErr) {
    out.offsite_error = dailyErr;
    return out;
  }
  out.offsite = "ok";

  /* Mahine ki 1 tareekh: lambi retention wali copy (S4). Daily ho chuka, to iski naakami
     alag se report hoti hai. */
  const monthly = offsiteTenantMonthlyName(deps.now, t.id);
  if (monthly) {
    const mErr = await deps.upload(monthly, body);
    if (mErr) out.offsite_error = `monthly: ${mErr}`;
  }
  return out;
}

export async function runPerTenantBackup(deps: PerTenantDeps): Promise<PerTenantReport> {
  const report: PerTenantReport = {
    missingFunction: false,
    label: null,
    backed_up: 0,
    failed: 0,
    total_bytes: 0,
    offsite_ok: 0,
    results: [],
    offsite_errors: [],
  };

  const list = await deps.listTenants();
  if (!list.ok) throw new Error(`could not read tenants: ${list.message}`);
  const tenants = list.data;
  if (tenants.length === 0) return report;

  /* Pehla tenant akela: agar function hi nahi bana (migration nahi chali) to baaki 49 par
     wahi galti dohrane ke bajaye seedha purane raaste par. */
  const probe = await runSweepWithRetry(() => deps.backupTenant(tenants[0].id), { sleep: deps.sleep });
  if (!probe.result.ok && isMissingFunction(probe.result.message)) {
    return { ...report, missingFunction: true };
  }

  /* Ek tenant ka anhona throw (network, ajeeb id) baaki sweep na gira de. */
  const safeOne = async (t: TenantRow, first: SweepAttempt<TenantBackupInfo> | null) => {
    try {
      return await oneTenant(t, deps, first);
    } catch (err) {
      const o: TenantOutcome & { label?: string } = {
        tenant_id: t.id, tenant: t.name ?? t.id, ok: false,
        error: err instanceof Error ? err.message : String(err), offsite: "skipped", retried: [],
      };
      return o;
    }
  };

  const outcomes = new Map<string, TenantOutcome & { label?: string }>();
  const firstOutcome = await safeOne(tenants[0], probe.result);
  firstOutcome.retried.unshift(...probe.retriedBecause);
  outcomes.set(tenants[0].id, firstOutcome);

  await pool(tenants.slice(1), deps.concurrency ?? DEFAULT_CONCURRENCY, async (t) => {
    outcomes.set(t.id, await safeOne(t, null));
  });

  /* Tenants ki list ke kram me — har raat ek jaisa, taaki log padhna aasaan. */
  for (const t of tenants) {
    const o = outcomes.get(t.id)!;
    const { label, ...rest } = o;
    if (o.ok) {
      report.backed_up++;
      report.total_bytes += o.bytes ?? 0;
      report.label ??= label ?? null;
    } else {
      report.failed++;
    }
    if (o.offsite === "ok") report.offsite_ok++;
    if (o.offsite_error) report.offsite_errors.push(`${o.tenant}: ${o.offsite_error}`);
    report.results.push(rest);
  }

  /* Us raat ki suchi. "Aaj ka backup poora hai?" = ek chhota object padhna, poora folder
     list karna nahi. Payload nahi — sirf kaun gaya, kaun nahi. */
  const manifest = {
    kind: "resellersos-offsite-manifest" as const,
    taken_at_utc: deps.now.toISOString(),
    ist_date: offsiteObjectName(deps.now).slice("daily/".length).replace(".json", ""),
    project_ref: deps.projectRef,
    tenant_count: tenants.length,
    uploaded: report.results.filter((r) => r.offsite === "ok").map((r) => r.tenant_id),
    missing: report.results
      .filter((r) => r.offsite !== "ok")
      .map((r) => ({ tenant_id: r.tenant_id, tenant: r.tenant, why: r.error ?? r.offsite_error ?? "unknown" })),
  };
  const mErr = await deps.upload(offsiteManifestName(deps.now), JSON.stringify(manifest));
  if (mErr) report.offsite_errors.push(`manifest: ${mErr}`);

  return report;
}
