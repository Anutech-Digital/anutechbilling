/**
 * S34 — the IndiaMART key screen (/marketing/indiamart): what the owner sees about the saved
 * CRM key and the last pull, kept here so the page and the API share one rulebook and the
 * wording is tested without a browser.
 *
 * ─── THE KEY NEVER COMES BACK ────────────────────────────────────────────────
 * GET /api/leads/indiamart answers "is a key saved, is it encrypted, what are its last 4
 * characters" — never the key. `keyLast4` refuses a value too short for four characters to
 * be a small fraction of it, so a mistyped 6-character "key" is not two-thirds displayed.
 * (The route used to send `maskSecret()`, which shows the FIRST four and last two of a key
 * stored in the clear — more than this screen needs.)
 *
 * ─── WHY pullSummary MATCHES ON THE CRON'S OWN WORDS ─────────────────────────
 * indiamart_sync_state keeps only `last_ok` + a free-text `last_error`. The two failures the
 * owner can act on are told apart by the strings lib/leads/indiamart.server.ts writes
 * ("rate limited: …", "IndiaMART rejected the CRM key …"); the test pins both, so changing
 * that text there fails here instead of quietly downgrading the advice to "kuch galat hua".
 */
import { z } from "zod";
import { formatIstDate, istParts } from "@/lib/dates/ist";
import { RATE_LIMIT_BACKOFF_MINUTES } from "./indiamart";

/** The cron's Cloud Scheduler line (scripts/setup-cloud-scheduler.sh): `*\/15 8-21 * * *`, Asia/Kolkata. */
export const PULL_SCHEDULE_TEXT = "every 15 minutes, 8 am – 9:45 pm IST";

/** Where the owner finds the key — shown on the screen, and what the save error points to. */
export const KEY_SOURCE_TEXT = "IndiaMART Seller panel → Lead Manager → CRM API key";

export const crmKeySchema = z.object({
  crm_key: z.string().trim()
    .min(16, "Doesn't look like a CRM key — copy the full key from Lead Manager")
    .max(200, "Too long — paste only the CRM key"),
});
export type CrmKeyInput = z.infer<typeof crmKeySchema>;

/** Shape of GET /api/leads/indiamart (minus the `ok` envelope). */
export interface IndiamartKeyStatus {
  configured: boolean;
  /** true = sealed with SECRETS_MASTER_KEY; false = an OLD key saved in the clear before R-051
   *  (the route now refuses to save without the master key — it never stores plaintext). */
  encrypted: boolean;
  /** Last 4 characters, or null when not shown (no key, too short, or could not be opened). */
  key_last4: string | null;
  last_run_at: string | null;
  last_ok: boolean | null;
  last_error: string | null;
  /** Leads created by the LAST pull (not a running total). */
  last_imported: number | null;
  /** Every IndiaMART enquiry ever turned into a lead for this company. */
  total_imported: number | null;
}

/**
 * R-399: a key stored in the clear can only be one saved BEFORE R-051 — since then POST
 * refuses (503) without SECRETS_MASTER_KEY instead of storing plaintext. So the status card
 * says how to fix THAT, not "the server has no master key" (it may well have one now).
 */
export const PLAINTEXT_KEY_NOTE =
  "This key was saved before encryption was switched on, so it is stored without encryption. Save the key again to encrypt it.";

export interface SaveKeyFailure {
  title: string;
  description: string;
  /** The server has no SECRETS_MASTER_KEY: retrying will not help until an admin sets it. */
  vaultMissing: boolean;
}

/**
 * R-399: what to tell the owner when saving the key fails. A 503 from POST is the vault
 * refusing (VaultNotConfiguredError → trySealTenantSecrets): its message already names the
 * next step, so it is shown as-is and nothing suggests pasting the key again. There is no
 * "saved, not encrypted" outcome any more — the key is either sealed or not saved.
 */
export function saveKeyFailure(status: number, message: string): SaveKeyFailure {
  if (status === 503) {
    return { title: "Key not saved — encryption is not set up on the server", description: message, vaultMissing: true };
  }
  return { title: message, description: "Couldn't save key. Paste it again; if it keeps failing, refresh the page.", vaultMissing: false };
}

/** Last four characters of a key, only when the key is long enough for that to reveal little. */
export function keyLast4(plain: string | null | undefined): string | null {
  const k = (plain ?? "").trim();
  return k.length >= 16 ? k.slice(-4) : null;
}

/** "29 Sep 2026, 2:15 pm" in IST, whatever the browser's zone. */
export function istDateTime(at: string | Date): string {
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return "—";
  const { hour, minute } = istParts(d);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${formatIstDate(d)}, ${h12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
}

export type PullTone = "neutral" | "success" | "warning" | "danger";
export interface PullSummary { tone: PullTone; title: string; detail: string }

/** One line of "is it working, and do I need to do anything" for the status card. */
export function pullSummary(s: Pick<IndiamartKeyStatus, "configured" | "last_run_at" | "last_ok" | "last_error" | "last_imported">): PullSummary {
  if (!s.configured) {
    return {
      tone: "neutral",
      title: "Not connected",
      detail: `Save the CRM key below. New enquiries are then pulled ${PULL_SCHEDULE_TEXT}.`,
    };
  }
  if (!s.last_run_at) {
    return {
      tone: "neutral",
      title: "Waiting for first pull",
      detail: `The first pull brings the last 24 hours of enquiries. Runs ${PULL_SCHEDULE_TEXT}.`,
    };
  }
  const when = istDateTime(s.last_run_at);
  if (s.last_ok) {
    const n = s.last_imported ?? 0;
    return {
      tone: "success",
      title: `Active — last pull ${when}`,
      detail: n === 0 ? "No new enquiries." : `${n} new ${n === 1 ? "lead" : "leads"}.`,
    };
  }
  const err = s.last_error ?? "";
  if (/^rate limited/i.test(err)) {
    return {
      tone: "warning",
      title: `Rate-limited (${when})`,
      detail: `No action needed — retrying in ${RATE_LIMIT_BACKOFF_MINUTES} minutes.`,
    };
  }
  if (/rejected the CRM key/i.test(err)) {
    return {
      tone: "danger",
      title: `Key rejected (${when})`,
      detail: `Copy a new key from ${KEY_SOURCE_TEXT} and save it below. A new key is checked on the next pull.`,
    };
  }
  return {
    tone: "danger",
    title: `Last pull failed (${when})`,
    detail: `${err || "No reason recorded."} The next pull retries; if it keeps failing, save the key again.`,
  };
}
