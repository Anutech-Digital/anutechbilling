/**
 * Off-site backup — raat wale snapshot ko database ke BAHAR rakhne ka faisla.
 *
 * ─── YE KYUN HAI ────────────────────────────────────────────────────────────
 * `backup_all_tenants()` roz 00:00 IST par chalta hai aur sach me chalta hai — 29 Aug 2026
 * ko teeno tenant ke us raat ke snapshot maujood mile. Par wo `backup.snapshots` me hain,
 * yaani **usi database ke andar jiska wo backup hain**. Project gaya to backup bhi saath
 * jayega, aur is plan par Supabase ka apna koi backup nahi hai.
 *
 * Database ke bahar ki ekmatra copy laptop par thi, haath se banti thi, aur 29 Aug ko teen
 * din purani nikli. 26 Aug ko data reset ho chuka hai — yaani ab jo bhi banega wo ASLI hai.
 * Abhi tak jo kho sakta tha wo nakli tha; aaj se nahi.
 *
 * Ye file sirf FAISLE rakhti hai — naam kya ho, khidki kya ho, kya galti maani jaye. Network
 * ka kaam route me hai, taaki ye sab bina kisi upload ke test ho sake.
 */
import { IST_OFFSET_MS } from "@/lib/dates/ist";

/** Bucket ek doosre REGION me hai (asia-south2 / Delhi), jabki DB aur app dono Mumbai me. */
export const OFFSITE_BUCKET = "resellsubsos-prod-offsite-backups";

/** Snapshot itni der pehle tak ka chalega. Cron ke turant baad chalta hai, par ek ghanta
 *  patla hai — retry, thoda late scheduler, ya ek dheema sweep aur khidki khaali. */
export const OFFSITE_WINDOW_HOURS = 20;


/**
 * Object ka naam — IST ki tareekh par, UTC par NAHI.
 *
 * Cron 00:00 IST par chalta hai, jo 18:30 UTC hai — PICHHLE din ka. UTC se naam banate to
 * har raat ka backup ek din purani tareekh par chadhta, aur "29 tareekh ka backup kahan hai"
 * ka jawab hamesha ek din khiska hua milta. Ye galti mahine bhar dikhti bhi nahi.
 */
export function offsiteObjectName(now: Date): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  /* Ek din, ek naam. Dobara chalane par purana object OVERWRITE hota hai, ek naya nahi
     banta — aur bucket par versioning on hai, to pichhli copy phir bhi bachi rehti hai.
     Har run par naya naam banate to 400 din me 400 nahi, hazaaron object hote, aur "aaj ka
     backup hai ya nahi" ek listing padhne ka kaam ban jata. */
  return `daily/${y}-${m}-${d}.json`;
}

/**
 * Mahine ki pehli tareekh (IST) ko ek aur copy `monthly/YYYY-MM.json` par — warna `null`.
 *
 * `daily/` 400 din baad lifecycle se mitta hai; GST/Income-tax records 8 saal rakhne hote
 * hain (S4, 27 Sep 2026). Mahine me ek snapshot lambe samay tak rakhna sasta hai, har din ka
 * nahi. Bucket ka lifecycle `monthly/` ko 400-din wale niyam se bahar rakhe — wo niyam bucket
 * par hai, code me nahi (command: repo-root docs/BACKUP.md).
 */
export function offsiteMonthlyName(now: Date): string | null {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  if (ist.getUTCDate() !== 1) return null;
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  return `monthly/${y}-${m}.json`;
}

/* ─── S15 (28 Sep 2026): ek tenant, ek object ─────────────────────────────────
 * Pehle raat ka ek hi object tha — sab tenants ek JSON me, jo Cloud Run ki RAM me ek string
 * banta tha. 50 tenant par wo jsonb ki 1 GB seema aur container ki memory, dono ki taraf
 * jaata. Ab har tenant ka alag object, usi din ke folder me:
 *
 *   daily/2026-08-29/<tenant_id>.json      monthly/2026-10/<tenant_id>.json
 *
 * Naam upar wale `offsiteObjectName` / `offsiteMonthlyName` se hi bante hain — IST wali
 * tareekh ka niyam ek hi jagah rahe. `daily/` aur `monthly/` prefix wahi, to bucket ka
 * lifecycle (400 din / 3000 din) bina badle lagta hai. */

/* Tenant id path me jaata hai; sirf uuid — `../` ya `/` wala id doosre din ki file par likh
   sakta tha. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertTenantId(tenantId: string): string {
  if (!UUID_RE.test(tenantId)) throw new Error(`offsite: tenant id is not a uuid: ${JSON.stringify(tenantId)}`);
  return tenantId.toLowerCase();
}

/** `daily/YYYY-MM-DD/<tenant_id>.json` — IST ki tareekh. */
export function offsiteTenantObjectName(now: Date, tenantId: string): string {
  return `${offsiteObjectName(now).replace(/\.json$/, "")}/${assertTenantId(tenantId)}.json`;
}

/** 1 tareekh (IST) ko `monthly/YYYY-MM/<tenant_id>.json`, warna `null`. */
export function offsiteTenantMonthlyName(now: Date, tenantId: string): string | null {
  const m = offsiteMonthlyName(now);
  return m ? `${m.replace(/\.json$/, "")}/${assertTenantId(tenantId)}.json` : null;
}

/** Us raat ki suchi — kaun upload hua, kaun reh gaya. `_` se shuru, taaki uuid se na takraye. */
export function offsiteManifestName(now: Date): string {
  return `${offsiteObjectName(now).replace(/\.json$/, "")}/_manifest.json`;
}

/** Kis waqt ke baad ke snapshot lene hain. */
export function offsiteWindowStart(now: Date, hours = OFFSITE_WINDOW_HOURS): Date {
  return new Date(now.getTime() - hours * 3600_000);
}

export interface OffsiteSnapshot {
  tenant_id: string;
  tenant_name: string | null;
  snapshot_id: string;
  created_at: string;
  payload: unknown;
}

export interface OffsiteEnvelope {
  kind: "resellersos-offsite-backup";
  taken_at_utc: string;
  ist_date: string;
  project_ref: string;
  tenant_count: number;
  snapshots: OffsiteSnapshot[];
}

export function offsiteEnvelope(
  now: Date,
  projectRef: string,
  snapshots: OffsiteSnapshot[],
): OffsiteEnvelope {
  return {
    kind: "resellersos-offsite-backup",
    taken_at_utc: now.toISOString(),
    ist_date: offsiteObjectName(now).slice("daily/".length).replace(".json", ""),
    project_ref: projectRef,
    tenant_count: snapshots.length,
    snapshots,
  };
}

/**
 * Kya ye upload karne layak hai — ya khaali hone ki wajah se rok dena chahiye.
 *
 * Khaali envelope upload karna sabse bura nateeja hai: bucket me aaj ka object dikhega,
 * tareekh bhi sahi hogi, aur andar kuch nahi hoga. Us din tak pata nahi chalega jab restore
 * karna pade. Isliye kuch na bhejna behtar hai — aur uski shikayat health digest me jayegi.
 */
export function offsiteRefusal(env: OffsiteEnvelope, expectedTenants: number): string | null {
  if (env.snapshots.length === 0) {
    return "no snapshot found — the sweep did not run, or the time window was too short";
  }
  if (expectedTenants > 0 && env.snapshots.length < expectedTenants) {
    /* Aadha backup poore backup jaisa dikhta hai. Jis tenant ka snapshot nahi gaya wo
       surakshit lagta hai aur hai nahi — theek wahi shakl jisme sweep ki apni per-tenant
       failure chhupti thi. */
    return `${expectedTenants} tenants exist but only ${env.snapshots.length} have a snapshot`;
  }
  const empty = env.snapshots.filter((s) => s.payload === null || s.payload === undefined);
  if (empty.length > 0) {
    return `${empty.length} snapshot(s) without a payload — the upload would work, but restore would not`;
  }
  return null;
}
