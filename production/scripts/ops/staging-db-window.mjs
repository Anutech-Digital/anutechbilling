/**
 * Staging DB step — wait while Cloud SQL is busy. R-2719 (12 Nov 2026).
 *
 * 12 Nov 09:32 IST: the staging deploy-db script failed with HTTP 409 ("operation in progress") because
 * the instance's daily automatic backup was running. Cloud SQL runs one operation at a time, so an
 * import during the backup (or during any other import / backup) is refused.
 *
 * Before the DB step the train now waits — a line every 30 s, at most 30 min — while
 *   - the time is inside the daily backup window, 09:25–10:05 IST, or
 *   - `gcloud sql operations list` shows an operation on the staging instance that is not DONE.
 * It only READS (operations list); it never starts, cancels or changes anything. gcloud missing or not
 * logged in → one warning, and only the clock is checked.
 *
 * Used by scripts/ops/staging-train.mjs (`--db-wait`, and by itself before it prints the DB step).
 * Tests: tests/ops/staging-db-window.test.ts.
 */
import { spawnSync } from "node:child_process";

/** Staging only — the same project/instance as supabase/cloudsql/staging/deploy-db-<date>.sh (P= / I=). */
export const STAGING_SQL_PROJECT = "resellsubsos-prod";
export const STAGING_SQL_INSTANCE = "resellersos-staging-db";

/** Daily automatic backup of the staging instance, with a margin: 09:25 (in) to 10:05 (out) IST. */
export const BACKUP_WINDOW_IST = { fromMin: 9 * 60 + 25, toMin: 10 * 60 + 5 };
export const POLL_MS = 30_000;
export const MAX_WAIT_MS = 30 * 60_000;

const IST_OFFSET_MS = 330 * 60_000;
const pad2 = (n) => String(n).padStart(2, "0");

/** Minutes since IST midnight of an instant. */
export function istMinuteOfDay(at) {
  const d = new Date(new Date(at).getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** "09:32" — IST clock time of an instant. */
export function istClock(at) {
  const m = istMinuteOfDay(at);
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** True from 09:25:00 up to (not including) 10:05:00 IST. */
export function inBackupWindow(at) {
  const m = istMinuteOfDay(at);
  return m >= BACKUP_WINDOW_IST.fromMin && m < BACKUP_WINDOW_IST.toMin;
}

/**
 * `gcloud sql operations list --format=json` text → the operations that are still going
 * (status PENDING / RUNNING — anything but DONE), newest first as gcloud lists them.
 * Throws on text that is not a JSON array (the caller treats that as "could not read").
 */
export function parseRunningOps(text) {
  const s = String(text ?? "").trim();
  if (!s) return [];
  const data = JSON.parse(s);
  if (!Array.isArray(data)) throw new Error("gcloud output is not a JSON array");
  return data
    .filter((o) => o && typeof o === "object" && String(o.status ?? "").toUpperCase() !== "DONE")
    .map((o) => ({ type: String(o.operationType ?? "?"), status: String(o.status ?? "?").toUpperCase(), startTime: String(o.startTime ?? o.insertTime ?? "") }));
}

/** Why the DB step must not start now; [] = free to go. `ops` = parseRunningOps output (or [] when unknown). */
export function busyReasons(at, ops = []) {
  const reasons = [];
  if (inBackupWindow(at)) reasons.push(`abhi ${istClock(at)} IST hai — roz ka Cloud SQL backup 09:25–10:05 IST chalta hai`);
  for (const o of ops) reasons.push(`Cloud SQL operation chal raha hai: ${o.type} (${o.status}${o.startTime ? `, shuru ${o.startTime}` : ""})`);
  return reasons;
}

/** Reads the staging instance's recent operations with gcloud. → { ok, ops, error }. Read-only. */
export function listRunningOps({ project = STAGING_SQL_PROJECT, instance = STAGING_SQL_INSTANCE, run = spawnSync } = {}) {
  const isWin = process.platform === "win32";
  const args = ["sql", "operations", "list", `--instance=${instance}`, `--project=${project}`, "--limit=20", "--format=json"];
  try {
    const r = run(isWin ? "gcloud.cmd" : "gcloud", args, { encoding: "utf8", shell: isWin, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    if (r.error) return { ok: false, ops: [], error: r.error.message };
    if (r.status !== 0) return { ok: false, ops: [], error: String(r.stderr ?? "").trim().split(/\r?\n/)[0] || `gcloud exit ${r.status}` };
    return { ok: true, ops: parseRunningOps(r.stdout), error: "" };
  } catch (e) {
    return { ok: false, ops: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Waits until the DB step may start. Everything with a side effect is injected, so tests run it with a
 * fake clock: now() → Date/ms, listOps() → { ok, ops, error }, sleep(ms), log(line).
 * → { clear, waitedMs, reasons, opsRead } — opsRead false = gcloud could not be read (clock only); clear false = still busy after maxMs (the caller must NOT run the DB step).
 */
export async function waitForDbClear({
  now = () => Date.now(),
  listOps = () => listRunningOps(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (l) => console.log(l),
  pollMs = POLL_MS,
  maxMs = MAX_WAIT_MS,
} = {}) {
  const start = new Date(now()).getTime();
  let warned = false;
  let polls = 0;
  for (;;) {
    const at = new Date(now()).getTime();
    const waitedMs = at - start;
    const res = await listOps();
    if (!res.ok && !warned) {
      warned = true;
      log(`! Cloud SQL operations padh nahi paaye (${res.error || "gcloud"}) — sirf ghadi dekh rahe hain. gcloud login jaancho.`);
    }
    const reasons = busyReasons(at, res.ok ? res.ops : []);
    if (!reasons.length) {
      /* Never say "free" about operations that could not be read. */
      if (!res.ok) log("✓ Backup window (09:25–10:05 IST) nahi hai — DB step chala sakte ho; operations padhe nahi gaye, HTTP 409 aaye to gcloud login ke baad dobara.");
      else log(polls > 0 ? `✓ Cloud SQL khaali (${Math.round(waitedMs / 60_000)} min ruke) — ab DB step chala sakte ho.` : "✓ Cloud SQL khaali (backup window nahi, koi operation nahi chal raha) — DB step chala sakte ho.");
      return { clear: true, waitedMs, reasons: [], opsRead: res.ok };
    }
    if (waitedMs >= maxMs) {
      log(`✗ ${Math.round(maxMs / 60_000)} min ruke, Cloud SQL ab bhi vyast — DB step ABHI MAT chalao (HTTP 409 aayega). Thodi der baad dobara: node scripts/ops/staging-train.mjs --db-wait`);
      for (const r of reasons) log(`    ${r}`);
      return { clear: false, waitedMs, reasons, opsRead: res.ok };
    }
    polls++;
    const left = Math.max(0, Math.round((maxMs - waitedMs) / 60_000));
    log(`⏳ DB step ruka hai — ${reasons.join("; ")}. ${Math.round(pollMs / 1000)} s me dobara dekhenge (${Math.round(waitedMs / 60_000)} min ruke, zyada se zyada ${left} min aur).`);
    await sleep(Math.min(pollMs, Math.max(1, maxMs - waitedMs)));
  }
}
