/**
 * Nightly backup cron — one restore point per tenant, every night.
 *
 * Schedule: 00:00 IST via CLOUD SCHEDULER (scripts/setup-cloud-scheduler.sh).
 * NOT vercel.json — the live deployment is Cloud Run, where Vercel crons do not
 * exist and that file is inert. Registering it there would produce a job that
 * looks scheduled in the repo and never runs, which for a backup is the worst
 * possible failure: you find out it was never running on the day you need it.
 *
 * ─── WHY THIS ROUTE EXISTS AT ALL ───────────────────────────────────────────
 * The in-app backup was owner-triggered, plus `auto_backup_if_stale()` (0212)
 * which fires only when somebody OPENS Settings → Backup. So a tenant whose owner
 * does not visit that page had no automatic protection — and that is exactly the
 * tenant that will one day need it. Meanwhile the page already promised restore
 * points are taken "apne aap roz". This makes the promise true.
 *
 * ─── S15 (28 Sep 2026): EK-EK TENANT ────────────────────────────────────────
 * Ab har tenant apna `backup_tenant()` call (apna transaction) aur apna GCS object
 * (`daily/YYYY-MM-DD/<tenant_id>.json` + `_manifest.json`) — lib/backup/per-tenant.ts.
 * Pehle sab tenants ek transaction aur ek jsonb me the; 50 tenant par wo design girta.
 * Migration 20260928141000 abhi na lagi ho (function nahi mila) to PURANA raasta
 * (`backup_all_tenants` + ek combined object) — deploy aur migration kisi bhi kram me hon,
 * raat ka backup nahi rukta.
 *
 * ─── ORDER OF THE GUARDS ────────────────────────────────────────────────────
 * Fail closed on a missing secret (503) BEFORE looking at the header, and use a
 * constant-time compare — the same shape as the other five crons here, on
 * purpose: an endpoint that snapshots every tenant is the last one that should
 * have its own bespoke auth.
 *
 * Local: curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/backup
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { fetchAllRows, errorMessage } from "@/lib/ops/fetch-all";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { runSweepWithRetry } from "@/lib/backup/sweep-retry";
import { runPerTenantBackup, type TenantBackupInfo, type TenantRow } from "@/lib/backup/per-tenant";
import { reportCron } from "@/lib/ops/cron-report";
import { gatedCron } from "@/lib/automation/cron-gate";
import {
  OFFSITE_BUCKET,
  offsiteObjectName,
  offsiteMonthlyName,
  offsiteWindowStart,
  offsiteEnvelope,
  offsiteRefusal,
  type OffsiteSnapshot,
} from "@/lib/backup/offsite";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Admin = ReturnType<typeof createAdminClient>;

function projectRef(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^https?:\/\//, "").split(".")[0] || "unknown";
}

/**
 * GCS uploader — token metadata server se, EK baar (per-tenant raaste par 50 upload ke liye
 * 50 token nahi). Koi key file, koi env var, koi nayi dependency (CLAUDE.md §17). Local dev
 * me metadata server hota hi nahi, aur wahan ye chalna bhi nahi chahiye.
 */
function makeUploader(): (name: string, body: string) => Promise<string | null> {
  let tokenP: Promise<{ token: string } | { error: string }> | null = null;
  const getToken = () =>
    (tokenP ??= (async () => {
      try {
        const r = await fetch(
          "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
          { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5_000) },
        );
        if (!r.ok) return { error: `metadata token not received: ${r.status}` };
        const t = ((await r.json()) as { access_token?: string }).access_token;
        return t ? { token: t } : { error: "metadata token came back empty" };
      } catch {
        return { error: "could not reach the metadata server — this route only runs on Cloud Run" };
      }
    })());

  return async (name, body) => {
    const tk = await getToken();
    if ("error" in tk) return tk.error;
    const up = await fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${OFFSITE_BUCKET}/o` +
        `?uploadType=media&name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${tk.token}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!up.ok) {
      /* §24: kya hua, kyun, ab kya. 403 ka matlab lagbhag hamesha ek hi cheez hai. */
      const text = (await up.text()).slice(0, 200);
      const hint = up.status === 403
        ? ` — the bucket needs a grant: gcloud storage buckets add-iam-policy-binding gs://${OFFSITE_BUCKET}` +
          ` --member="serviceAccount:1005662057478-compute@developer.gserviceaccount.com" --role="roles/storage.objectAdmin"`
        : "";
      return `upload ${name} ${up.status}: ${text}${hint}`;
    }
    console.log(`[cron/backup] off-site: gs://${OFFSITE_BUCKET}/${name}`);
    return null;
  };
}

/**
 * PURANA raasta (S15 se pehle ka) — sirf tab jab `backup_tenant` function abhi DB me nahi.
 * Snapshot ko database ke BAHAR rakho — Cloud Storage par, doosre region me.
 *
 * `backup.snapshots` usi database ke andar hai jiska wo backup hai. Wo backup ek galat DELETE
 * se bachata hai, project khone se nahi. Ye function doosri wali soorat sambhalta hai.
 *
 * Wapas `null` (sab theek) ya wajah (jo stderr par ja kar agli subah digest me dikhegi).
 * Chahe kuch bhi ho, poore cron ko fail NAHI karta: DB ka backup ho chuka hota hai, aur 500
 * lautane par Scheduler poora sweep dobara chalata — off-site ki naakami ka ilaaj us DB
 * backup ko dobara lena nahi hai.
 */
async function putOffsiteCombined(admin: Admin, upload: ReturnType<typeof makeUploader>): Promise<string | null> {
  const now = new Date();

  const { data, error } = await admin.rpc("export_snapshots_for_offsite", {
    p_since: offsiteWindowStart(now).toISOString(),
  });
  if (error) return `could not read snapshots: ${error.message}`;

  /* Ginti DB se, taaki "kitne tenant hone chahiye" ek hardcoded number na ho jo naye tenant
     par chup-chaap galat ho jaye. Ginti na mile to us wajah se backup rokna galat hoga —
     `offsiteRefusal` 0 ko "ginti nahi pata" maanta hai, "koi tenant nahi" nahi. */
  const { count } = await admin.from("tenants").select("id", { count: "exact", head: true });

  const env = offsiteEnvelope(now, projectRef(), (data ?? []) as OffsiteSnapshot[]);

  const refusal = offsiteRefusal(env, count ?? 0);
  if (refusal) return refusal;

  const body = JSON.stringify(env);
  const dailyError = await upload(offsiteObjectName(now), body);
  if (dailyError) return dailyError;

  /* Mahine ki 1 tareekh: lambi retention wali copy (S4). Daily ho chuka hai, to iski naakami
     alag se report hoti hai — raat ka backup phir bhi bacha hai. */
  const monthly = offsiteMonthlyName(now);
  return monthly ? upload(monthly, body) : null;
}

/** S15 se pehle ka poora sweep — function-missing fallback. Vyavhaar badla nahi. */
async function legacySweep(admin: Admin, upload: ReturnType<typeof makeUploader>) {
  /* Retried, because on 21 Aug 2026 this exact call answered "JWT issued at future"
   * once and the night's backup was simply never taken — the Cloud Scheduler job has
   * no retryCount, so nothing tried again until the next midnight. Only failures a
   * second attempt could survive are retried; see lib/backup/sweep-retry.ts, which
   * refuses to retry a bad grant or an unapplied migration on purpose. */
  const run = await runSweepWithRetry(async () => {
    const { data, error } = await admin.rpc("backup_all_tenants", { p_label: null });
    return error ? { ok: false as const, message: error.message } : { ok: true as const, data };
  });

  if (run.retriedBecause.length > 0) {
    console.warn(
      `[cron/backup] retried ${run.retriedBecause.length}x — ${run.retriedBecause.join(" | ")}`,
    );
  }

  if (!run.result.ok) {
    /* Keeps the "[cron/backup] sweep failed" prefix the 21 Aug incident was found by. */
    console.error(
      `[cron/backup] sweep failed after ${run.attemptsMade} attempt(s):`,
      run.result.message,
    );
    return NextResponse.json(
      { ok: false, error: run.result.message, attempts: run.attemptsMade },
      { status: 500 },
    );
  }

  const result = run.result.data;
  /* The function's `ok` is a COUNT of tenants; the response's `ok` is a boolean. */
  const body = {
    mode:       "legacy" as const,
    label:      result.label,
    backed_up:  result.ok,
    failed:     result.failed,
    total_bytes: result.total_bytes,
    results:    result.results,
  };

  if (result.failed > 0) {
    const broken = result.results.filter((r) => !r.ok).map((r) => `${r.tenant}: ${r.error}`);
    console.error("[cron/backup] some tenants failed:", broken.join(" | "));
    return NextResponse.json({ ok: false, ...body }, { status: 500 });
  }

  console.log(`[cron/backup] ${result.label} — ${result.ok} tenants, ${result.total_bytes} bytes`);
  const offsiteError = await putOffsiteCombined(admin, upload);

  return NextResponse.json(reportCron("backup", {
    ok: true,
    ...body,
    offsite: offsiteError ? "failed" : "ok",
    errors: offsiteError ? [`off-site copy: ${offsiteError}`] : [],
  }));
}

async function runCron(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 503 });

  const header = req.headers.get("authorization") ?? "";
  const match  = /^Bearer\s+(.+)$/i.exec(header);
  if (!timingSafeEqualStr(match?.[1] ?? "", secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const upload = makeUploader();

  let report;
  try {
    report = await runPerTenantBackup({
      now: new Date(),
      projectRef: projectRef(),
      listTenants: async () => {
        /* WC-scale: paged — tenant 1001 was silently never backed up. */
        try {
          const data = await fetchAllRows((from, to) => admin
            .from("tenants").select("id, name, workspace_kind").order("created_at").order("id").range(from, to));
          /* tenants.workspace_kind (R-2110) is not in database.generated.ts yet — the shape is TenantRow. */
          return { ok: true, data: data as unknown as TenantRow[] };
        } catch (e) {
          /* R-2140: a database without tenants.workspace_kind (GP-01 not applied yet) must not
             stop the night's backup — read without it; every tenant then gets the full backup. */
          if (!/workspace_kind/i.test(errorMessage(e))) return { ok: false, message: errorMessage(e) };
          try {
            const data = await fetchAllRows((from, to) => admin
              .from("tenants").select("id, name").order("created_at").order("id").range(from, to));
            return { ok: true, data };
          } catch (e2) {
            return { ok: false, message: errorMessage(e2) };
          }
        }
      },
      backupTenant: async (tenantId, plan) => {
        /* R-2140: personal tenant → tiered (skip when unchanged, fewer kept); see lib/backup/tiering.ts. */
        const { data, error } = plan
          ? await admin.rpc("backup_tenant_tiered", {
              p_tenant: tenantId,
              p_keep: plan.keep,
              p_only_if_changed: plan.onlyIfChanged,
            })
          : await admin.rpc("backup_tenant", { p_tenant: tenantId, p_label: null });
        return error
          ? { ok: false, message: error.message }
          : { ok: true, data: (data ?? {}) as TenantBackupInfo };
      },
      exportTenant: async (tenantId, since) => {
        const { data, error } = await admin.rpc("export_tenant_snapshot_for_offsite", {
          p_tenant: tenantId,
          p_since: since.toISOString(),
        });
        return error
          ? { ok: false, message: error.message }
          : { ok: true, data: (data ?? null) as OffsiteSnapshot | null };
      },
      upload,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/backup] sweep failed after 1 attempt(s):", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  if (report.missingFunction) {
    console.warn("[cron/backup] backup_tenant() not found — apply migration 20260928141000; using the old sweep today");
    return legacySweep(admin, upload);
  }

  const retried = report.results.flatMap((r) => r.retried.map((m) => `${r.tenant}: ${m}`));
  if (retried.length > 0) {
    console.warn(`[cron/backup] retried ${retried.length}x — ${retried.join(" | ")}`);
  }

  /* R-2140: one line per run, so "the second run skipped the unchanged personal tenant" is
     visible in the log (and in the scheduler's response body as skipped_unchanged). */
  const skipped = report.results.filter((r) => r.ok && r.skipped);
  if (skipped.length > 0) {
    console.log(
      `[cron/backup] personal tenants skipped (${skipped.length}): ` +
        skipped.map((r) => `${r.tenant} — ${r.skipped === "unchanged" ? `unchanged since snapshot ${r.snapshot_id ?? "?"}` : "policy: skip"}`).join(" | "),
    );
  }

  const body = {
    mode:        "per-tenant" as const,
    label:       report.label,
    backed_up:   report.backed_up,
    skipped_unchanged: report.skipped_unchanged,
    failed:      report.failed,
    total_bytes: report.total_bytes,
    offsite_ok:  report.offsite_ok,
    results:     report.results.map(({ retried: _r, ...rest }) => rest),
  };

  /* A partial failure is reported, not swallowed. One tenant without tonight's
   * backup means the scheduler must see a non-2xx, or the run shows up green
   * with a note nobody reads. Baaki tenants ka DB snapshot AUR off-site copy
   * (S15 se) dono ho chuke hain — ek kharab tenant kisi aur ko nahi rokta. */
  if (report.failed > 0) {
    const broken = report.results.filter((r) => !r.ok).map((r) => `${r.tenant}: ${r.error}`);
    console.error("[cron/backup] some tenants failed:", broken.join(" | "));
    return NextResponse.json(
      { ok: false, ...body, errors: report.offsite_errors.map((e) => `off-site copy: ${e}`) },
      { status: 500 },
    );
  }

  console.log(`[cron/backup] ${report.label} — ${report.backed_up} tenants, ${report.total_bytes} bytes`);

  /* Off-site ki naakami 500 nahi banati (DB backup ho chuka; 500 par Scheduler sab dobara
     leta), par chup bhi nahi rehti: `errors` → reportCron → stderr → 08:30 health digest. */
  return NextResponse.json(reportCron("backup", {
    ok: true,
    ...body,
    offsite: report.offsite_errors.length ? "failed" : "ok",
    errors: report.offsite_errors.map((e) => `off-site copy: ${e}`),
  }));
}

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or sent. */
export const GET = gatedCron("backup", runCron);
