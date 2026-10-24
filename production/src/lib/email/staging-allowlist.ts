/**
 * R-1403 (19 Oct 2026) — staging may only message the team.
 *
 * ─── WHY ─────────────────────────────────────────────────────────────────────
 * Staging runs on copies of real-looking data: a customer row pasted in for a test, an invite
 * typed with a client's address, a renewal cron that finds an "overdue" invoice. The day a mail
 * key (RESEND / SMTP / a tenant's Gmail) or WhatsApp credentials reach staging, any of those
 * flows can write to a real customer — and staging must never reach customers.
 *
 * ─── THE RULE ────────────────────────────────────────────────────────────────
 * On staging, an email goes out only to an address on `@anutech.in` or on the list in
 * `STAGING_MAIL_ALLOWLIST` (comma list of `name@x.com` or `@domain.com`). A WhatsApp message goes
 * out only to a number on `STAGING_PHONE_ALLOWLIST` (comma list of numbers; empty = none).
 * Everything else is dropped and logged with the address MASKED (lib/security/redact-contact).
 * No error reaches the person who pressed Send: the send reports "stubbed", the way a send with
 * no mail key already does.
 *
 * Fail closed: on staging, an allowlist that cannot be read (an entry that is neither an address
 * nor an `@domain`) blocks EVERY recipient — a typo in the env must not open the gate.
 *
 * ─── WHERE IT RUNS ───────────────────────────────────────────────────────────
 * Inside sendEmail() (lib/email/send.ts) and sendWhatsApp() (lib/whatsapp/client.ts) — the two
 * chokepoints every customer and internal message already passes through (lib/messaging). Live is
 * untouched: none of the staging signals is set there.
 *
 * "Staging" is read from every signal the app already has: APP_ENV / NEXT_PUBLIC_APP_ENV =
 * "staging" (cloudbuild `_APP_ENV` → Dockerfile), or NEXT_PUBLIC_APP_URL naming a staging host
 * (the run.app service is `resellersos-staging-…`). STAGING_MAIL_ALLOWLIST set anywhere also
 * turns the guard on, so a developer can opt a laptop into the same rule.
 */
import { maskEmail, maskPhone } from "@/lib/security/redact-contact";

type Env = Record<string, string | undefined>;

/** Always allowed on staging, with or without the env list. */
export const DEFAULT_ALLOWED_DOMAIN = "anutech.in";

export const MAIL_ALLOWLIST_ENV = "STAGING_MAIL_ALLOWLIST";
export const PHONE_ALLOWLIST_ENV = "STAGING_PHONE_ALLOWLIST";

/** True on the staging deployment (any one signal is enough). */
export function isStagingEnv(env: Env = process.env): boolean {
  for (const key of ["APP_ENV", "NEXT_PUBLIC_APP_ENV"] as const) {
    if ((env[key] ?? "").trim().toLowerCase() === "staging") return true;
  }
  const url = (env.NEXT_PUBLIC_APP_URL ?? "").trim().toLowerCase();
  if (url) {
    try {
      if (new URL(url).hostname.includes("staging")) return true;
    } catch {
      /* not a URL — not a staging signal either */
    }
  }
  return false;
}

/** Is the recipient guard on for this process? */
export function recipientGuardActive(env: Env = process.env): boolean {
  return isStagingEnv(env) || (env[MAIL_ALLOWLIST_ENV] ?? "").trim() !== "";
}

export type MailAllowlist =
  | { ok: true; addresses: Set<string>; domains: Set<string> }
  | { ok: false; reason: string };

const ADDRESS_RE = /^[^\s@<>,]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const DOMAIN_RE = /^@[a-z0-9.-]+\.[a-z]{2,}$/;

/** Parse STAGING_MAIL_ALLOWLIST (+ the default domain). Any unreadable entry → not ok. */
export function readMailAllowlist(env: Env = process.env): MailAllowlist {
  const addresses = new Set<string>();
  const domains = new Set<string>([DEFAULT_ALLOWED_DOMAIN]);
  const raw = env[MAIL_ALLOWLIST_ENV] ?? "";
  for (const part of raw.split(",")) {
    const entry = part.trim().toLowerCase();
    if (!entry) continue;
    if (DOMAIN_RE.test(entry)) domains.add(entry.slice(1));
    else if (ADDRESS_RE.test(entry)) addresses.add(entry);
    else return { ok: false, reason: `${MAIL_ALLOWLIST_ENV} has an entry that is not an address or @domain` };
  }
  return { ok: true, addresses, domains };
}

/** "Name <a@b.c>" → "a@b.c", lower-cased. */
function bareAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

function addressAllowed(addr: string, list: Extract<MailAllowlist, { ok: true }>): boolean {
  if (list.addresses.has(addr)) return true;
  const at = addr.lastIndexOf("@");
  if (at < 0) return false;
  const domain = addr.slice(at + 1).replace(/\.+$/, "");
  return list.domains.has(domain);
}

export interface MailGuardVerdict {
  /** Recipients that may be sent to ("" when none — then nothing is sent). */
  allowedTo: string;
  /** Masked addresses that were dropped (for the log line). */
  droppedMasked: string[];
  /** Why they were dropped. */
  reason: "staging-allowlist" | "staging-allowlist-unreadable" | null;
}

/**
 * Split `to` (one address or a comma list) into what may go out and what is dropped.
 * Outside staging (guard off) everything is allowed and nothing changes.
 */
export function guardMailRecipients(to: string, env: Env = process.env): MailGuardVerdict {
  if (!recipientGuardActive(env)) return { allowedTo: to, droppedMasked: [], reason: null };
  const parts = to.split(",").map((p) => p.trim()).filter(Boolean);
  const list = readMailAllowlist(env);
  if (!list.ok) {
    return { allowedTo: "", droppedMasked: parts.map((p) => maskEmail(bareAddress(p))), reason: "staging-allowlist-unreadable" };
  }
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const p of parts) {
    const addr = bareAddress(p);
    if (addressAllowed(addr, list)) kept.push(p);
    else dropped.push(maskEmail(addr));
  }
  return { allowedTo: kept.join(", "), droppedMasked: dropped, reason: dropped.length ? "staging-allowlist" : null };
}

/** Digits only, last 10 for an Indian-style compare ("+91 98765 43210" ≡ "9876543210"). */
function phoneKey(raw: string): string {
  const d = raw.replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
}

/**
 * May a WhatsApp/SMS go to this number? Outside staging always yes. On staging only numbers on
 * STAGING_PHONE_ALLOWLIST; an empty list allows none, and an unreadable entry blocks all.
 */
export function guardPhoneRecipient(
  to: string,
  env: Env = process.env,
): { allowed: true } | { allowed: false; masked: string; reason: "staging-allowlist" | "staging-allowlist-unreadable" } {
  if (!recipientGuardActive(env)) return { allowed: true };
  const masked = maskPhone(to);
  const want = phoneKey(to);
  const allowed = new Set<string>();
  for (const part of (env[PHONE_ALLOWLIST_ENV] ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const key = phoneKey(entry);
    if (key.length < 10 || /[a-z@]/i.test(entry)) return { allowed: false, masked, reason: "staging-allowlist-unreadable" };
    allowed.add(key);
  }
  if (want && allowed.has(want)) return { allowed: true };
  return { allowed: false, masked, reason: "staging-allowlist" };
}
