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
import { backupPlanFor, type BackupPlan, type PersonalBackupPolicy, type TieredPlan } from "./tiering";

export interface TenantRow {
  id: string;
  name: string | null;
  /** R-2140: tenants.workspace_kind — missing/unknown reads 'business' (full backup). */
  workspace_kind?: string | null;
}

/** `backup_tenant()` / `backup_tenant_tiered()` ka jawab (jsonb). */
export interface TenantBackupInfo {
  id?: string;
  bytes?: number;
  table_count?: number;
  label?: string;
  /** R-2140: personal tenant unchanged since its newest snapshot — nothing was written. */
  skipped?: "unchanged";
  snapshot_id?: string;
  tenant_id?: string;
}

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export interface PerTenantDeps {
  now: Date;
  projectRef: string;
  listTenants(): Promise<Result<TenantRow[]>>;
  /** No plan = full `backup_tenant()`; a plan = `backup_tenant_tiered()` (R-2140, personal). */
  backupTenant(tenantId: string, plan?: TieredPlan): Promise<SweepAttempt<TenantBackupInfo>>;
  exportTenant(tenantId: string, since: Date): Promise<Result<OffsiteSnapshot | null>>;
  /** `null` = upload ho gaya; string = kyun nahi hua. */
  upload(name: string, body: string): Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  /** Ek saath kitne tenant. RAM me itne hi payload ek waqt par. */
  concurrency?: number;
  /** R-2140: overrides PERSONAL_BACKUP_POLICY (tests). */
  personalPolicy?: PersonalBackupPolicy;
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
  /** R-2140: personal tenant not snapshotted tonight — 'unchanged' (same data as its newest
      snapshot, `snapshot_id`) or 'policy' (PERSONAL_BACKUP_POLICY = 'skip'). ok stays true. */
  skipped?: "unchanged" | "policy";
  snapshot_id?: string;
}

export interface PerTenantReport {
  /** Migration 20260928141000 abhi laga nahi — route purane raaste par jaaye. */
  missingFunction: boolean;
  label: string | null;
  backed_up: number;
  failed: number;
  /** R-2140: personal tenants not snapshotted tonight (unchanged, or policy 'skip'). */
  skipped_unchanged: number;
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

/* R-2140: business → backup_tenant(); personal → backup_tenant_tiered(). If the tiered function
   is not deployed yet, that tenant gets the normal full backup — "function missing" for the
   NEW function must never send the whole night to the legacy sweep. */
async function takeBackup(t: TenantRow, plan: BackupPlan, deps: PerTenantDeps) {
  const opts = { sleep: deps.sleep };
  if (plan.mode !== "tiered") return runSweepWithRetry(() => deps.backupTenant(t.id), opts);
  const tiered: TieredPlan = { onlyIfChanged: plan.onlyIfChanged, keep: plan.keep };
  const r = await runSweepWithRetry(() => deps.backupTenant(t.id, tiered), opts);
  if (r.result.ok || !isMissingFunction(r.result.message)) return r;
  const full = await runSweepWithRetry(() => deps.backupTenant(t.id), opts);
  return { ...full, retriedBecause: [...r.retriedBecause, ...full.retriedBecause] };
}

async function oneTenant(
  t: TenantRow,
  deps: PerTenantDeps,
  first: SweepAttempt<TenantBackupInfo> | null,
): Promise<TenantOutcome & { label?: string }> {
  const name = t.name ?? t.id;
  const retried: string[] = [];
  const plan = backupPlanFor(t.workspace_kind, deps.personalPolicy);
  /* R-2140: owner chose "no nightly snapshot" for personal tenants — nothing called, not a failure. */
  if (plan.mode === "none") {
    return { tenant_id: t.id, tenant: name, ok: true, skipped: "policy", offsite: "skipped", retried };
  }
  let run: SweepAttempt<TenantBackupInfo>;
  if (first) {
    run = first;
  } else {
    const r = await takeBackup(t, plan, deps);
    run = r.result;
    retried.push(...r.retriedBecause);
  }

  if (!run.ok) {
    return { tenant_id: t.id, tenant: name, ok: false, error: run.message, offsite: "skipped", retried };
  }

  /* R-2140: personal tenant, same data as its newest snapshot — nothing new to copy off-site.
     That newest snapshot's daily object is already in the bucket (daily/ lives 400 days); on
     the 1st (IST) it still gets this month's long-lived copy, so an idle tenant never ages
     out of the bucket. */
  if (run.data.skipped === "unchanged") {
    const out: TenantOutcome & { label?: string } = {
      tenant_id: t.id, tenant: name, ok: true, skipped: "unchanged",
      snapshot_id: run.data.snapshot_id, offsite: "skipped", retried,
    };
    const monthly = offsiteTenantMonthlyName(deps.now, t.id);
    if (monthly) {
      const exp = await deps.exportTenant(t.id, new Date(0));
      if (!exp.ok) {
        out.offsite_error = `monthly: could not read the snapshot: ${exp.message}`;
        return out;
      }
      const env = offsiteEnvelope(deps.now, deps.projectRef, exp.data ? [exp.data] : []);
      const refusal = offsiteRefusal(env, 1);
      if (refusal) {
        out.offsite_error = `monthly: ${refusal}`;
        return out;
      }
      const mErr = await deps.upload(monthly, JSON.stringify(env));
      if (mErr) out.offsite_error = `monthly: ${mErr}`;
    }
    return out;
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
    skipped_unchanged: 0,
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
     wahi galti dohrane ke bajaye seedha purane raaste par. R-2140: the probe is the first
     tenant that is backed up at all (policy 'skip' calls nothing, so it proves nothing). */
  const probeIdx = tenants.findIndex((t) => backupPlanFor(t.workspace_kind, deps.personalPolicy).mode !== "none");
  const probeTenant = probeIdx >= 0 ? tenants[probeIdx] : null;
  const probe = probeTenant
    ? await takeBackup(probeTenant, backupPlanFor(probeTenant.workspace_kind, deps.personalPolicy), deps)
    : null;
  if (probe && !probe.result.ok && isMissingFunction(probe.result.message)) {
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
  if (probeTenant && probe) {
    const firstOutcome = await safeOne(probeTenant, probe.result);
    firstOutcome.retried.unshift(...probe.retriedBecause);
    outcomes.set(probeTenant.id, firstOutcome);
  }

  await pool(tenants.filter((t) => t !== probeTenant), deps.concurrency ?? DEFAULT_CONCURRENCY, async (t) => {
    outcomes.set(t.id, await safeOne(t, null));
  });

  /* Tenants ki list ke kram me — har raat ek jaisa, taaki log padhna aasaan. */
  for (const t of tenants) {
    const o = outcomes.get(t.id)!;
    const { label, ...rest } = o;
    if (o.ok && o.skipped) {
      report.skipped_unchanged++;
    } else if (o.ok) {
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
      .filter((r) => r.offsite !== "ok" && !r.skipped)
      .map((r) => ({ tenant_id: r.tenant_id, tenant: r.tenant, why: r.error ?? r.offsite_error ?? "unknown" })),
    /* R-2140: personal tenants not snapshotted tonight — their newest copy is an earlier day's. */
    unchanged: report.results
      .filter((r) => r.skipped)
      .map((r) => ({ tenant_id: r.tenant_id, tenant: r.tenant, why: r.skipped, snapshot_id: r.snapshot_id ?? null })),
  };
  const mErr = await deps.upload(offsiteManifestName(deps.now), JSON.stringify(manifest));
  if (mErr) report.offsite_errors.push(`manifest: ${mErr}`);

  return report;
}
