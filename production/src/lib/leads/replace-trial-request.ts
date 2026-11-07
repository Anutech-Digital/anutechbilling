/**
 * R-2563 (7 Nov 2026, follow-up of R-1491) — "← Change the request" on the website /trial form.
 *
 * The visitor sends a trial request (lead + maybe a draft quote), presses "← Change the request",
 * picks another product and sends again. Since R-1491 the second request says "Replaces my earlier
 * request <no>", but the FIRST lead and its draft quote stayed open on the server — sales saw two
 * open leads for one customer, one of them quoting the wrong product.
 *
 * ─── WHO MAY CLOSE AN EARLIER REQUEST ─────────────────────────────────────────────────────────
 * The endpoint is public and quote numbers / lead ids are guessable, and an email + mobile are not
 * secrets — so a reference alone proves nothing. Instead every TRIAL request gets back a signed
 * replace token (HMAC over tenant + lead + time + email + mobile, with the app's signing secret).
 * Only the browser that sent the first request holds it; "Change the request" sends it back with
 * the next request. A token closes nothing unless it verifies, is under 24 h old, and was made for
 * the SAME email and mobile as the new request. Tokens are only issued for trial requests, so a
 * plain /enquiry or /quote lead can never be closed this way.
 *
 * The database step is ONE function, `replace_trial_request` (migration 20261107151134), which
 * re-checks everything under row locks and either closes the old request (Junk "Replaced by …",
 * never-sent draft quotes expired) or leaves a note for a person. See that migration.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { normPhone } from "./duplicates";
import { signingSecrets } from "@/lib/security/signing-secrets";

/** How old the earlier request may be. A changed mind is minutes later, never days. */
export const REPLACE_WINDOW_HOURS = 24;
/** At most this many earlier requests per new one (each "Change" adds one). */
export const MAX_REPLACE_TOKENS = 5;

export interface Contact {
  email: string | null;
  phone: string | null;
}

const LEAD_RE = /^L-[A-Z0-9]{4,20}$/;
const TOKEN_RE = /^(L-[A-Z0-9]{4,20})\.(\d{10})\.([A-Za-z0-9_-]{43})$/;

function mac(secret: string, tenantId: string, leadId: string, issuedSec: number, contact: Contact): string {
  const payload = ["r2563-trial-replace", tenantId, leadId, String(issuedSec),
    (contact.email ?? "").trim().toLowerCase(), normPhone(contact.phone)].join("|");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * The token handed back with a trial request — null when no signing secret is configured (then
 * "Change the request" simply cannot close the earlier lead; the request itself still succeeds).
 */
export function signReplaceToken(args: { tenantId: string; leadId: string; contact: Contact; now?: Date }): string | null {
  if (!LEAD_RE.test(args.leadId) || !normPhone(args.contact.phone) || !(args.contact.email ?? "").trim()) return null;
  let secret: string;
  try { secret = signingSecrets(args.now).primary; } catch { return null; }
  const issued = Math.floor((args.now ?? new Date()).getTime() / 1000);
  return `${args.leadId}.${issued}.${mac(secret, args.tenantId, args.leadId, issued, args.contact)}`;
}

/** The tokens the form sent back, cleaned: strings of the right shape, de-duplicated, at most 5. */
export function cleanReplaceTokens(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== "string") continue;
    const tok = t.trim();
    if (!TOKEN_RE.test(tok) || out.includes(tok)) continue;
    out.push(tok);
    if (out.length >= MAX_REPLACE_TOKENS) break;
  }
  return out;
}

/**
 * The earlier lead ids these tokens name — only tokens signed by this app for THIS tenant and THIS
 * email + mobile, issued in the last 24 hours. Anything else is dropped without a word.
 */
export function verifyReplaceTokens(tokens: unknown, args: { tenantId: string; contact: Contact; now?: Date }): string[] {
  const now = args.now ?? new Date();
  let secrets: string[];
  try {
    const s = signingSecrets(now);
    secrets = [s.primary, ...s.legacy].filter(Boolean);
  } catch { return []; }
  const ids: string[] = [];
  for (const tok of cleanReplaceTokens(tokens)) {
    const m = TOKEN_RE.exec(tok);
    if (!m) continue;
    const [, leadId, issuedRaw, sig] = m;
    const issued = Number(issuedRaw);
    const ageSec = now.getTime() / 1000 - issued;
    if (!(ageSec >= -60 && ageSec <= REPLACE_WINDOW_HOURS * 3600)) continue;
    const got = Buffer.from(sig);
    const ok = secrets.some((secret) => {
      const want = Buffer.from(mac(secret, args.tenantId, leadId, issued, args.contact));
      return want.length === got.length && timingSafeEqual(want, got);
    });
    if (ok && !ids.includes(leadId)) ids.push(leadId);
  }
  return ids;
}
