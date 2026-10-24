/**
 * Capability-links (PDF, expense-claim) ki HMAC chaabiyan — ek hi jagah (S20, 28 Sep 2026).
 *
 * ─── KYUN ───────────────────────────────────────────────────────────────────
 * Aaj tak har link SUPABASE_SERVICE_ROLE_KEY se sign hota tha, kyunki PDF_SIGNING_SECRET
 * kabhi set hi nahi hua. Ek chaabi do kaam: DB ka poora admin access AUR public links ka
 * dastkhat. Alag chaabi set karna sahi hai — par jis din set hogi, us din se pehle bante
 * saare link (DSP ke, email ke, employees ke paas pade claim link) ek jhatke me 403 dete,
 * agar verify sirf nayi chaabi maane.
 *
 * Isliye: SIGN hamesha `primary` se, VERIFY `primary` + (grace window tak) purani
 * service-role chaabi se. Grace khatam → sirf primary. Isse PDF_SIGNING_SECRET kisi bhi
 * din set kiya ja sakta hai, bina kisi link ke tootne ke.
 */

/**
 * Grace ka default aakhri din. Env `SIGNING_LEGACY_UNTIL` (ISO date/time) isse badal sakta hai.
 * 31 Dec 2026 IST ka ant — lagbhag 3 mahine: email me gaye links aur employees ke claim link
 * ke liye kaafi, aur itna chhota ki service-role chaabi ka ye doosra kaam hamesha na chale.
 */
export const DEFAULT_LEGACY_UNTIL = "2026-12-31T18:30:00Z";

export interface SigningSecrets {
  /** Isi se naye token sign hote hain. */
  primary: string;
  /** Sirf VERIFY ke liye — purane token jo service-role chaabi se bane the. Grace ke baad khaali. */
  legacy: string[];
}

/** Grace window abhi chal rahi hai? Galat env date par default maano — chup-chaap band karna links todta. */
export function legacyGraceActive(now: Date = new Date()): boolean {
  const raw = process.env.SIGNING_LEGACY_UNTIL?.trim();
  const parsed = raw ? new Date(raw) : null;
  const until = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(DEFAULT_LEGACY_UNTIL);
  return now.getTime() < until.getTime();
}

/**
 * Chaabiyan har call par env se padhi jaati hain (cache nahi) — taaki Cloud Run par secret
 * badalne ke baad naya revision bina kisi purane cached value ke chale, aur test env stub kar sake.
 */
export function signingSecrets(now: Date = new Date()): SigningSecrets {
  const dedicated = process.env.PDF_SIGNING_SECRET?.trim() || "";
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  /* R-739 (23 Oct 2026): production signs ONLY with the dedicated secret. The service-role key
     is the database's full admin key; letting it double as the public links' signing key meant a
     leak of either was a leak of both. Missing in production → refuse (fail closed), naming the
     variable to set. Dev/test keep the fallback so a fresh checkout still works. Links signed
     with the service-role key earlier still VERIFY through `legacy` until SIGNING_LEGACY_UNTIL. */
  if (!dedicated && process.env.NODE_ENV === "production") {
    throw new Error(
      "PDF_SIGNING_SECRET is not set — PDF, expense-claim and bank-consent links cannot be signed or checked. " +
        "Set PDF_SIGNING_SECRET on this deployment (docs/SECURITY-RUNBOOK.md); the service-role key no longer signs links in production.",
    );
  }
  /* Kabhi "" nahi (audit C6): khaali chaabi par HMAC = har token forgeable. Dono gayab to
     phat jao — bina chaabi band darwaza, khaali chaabi se khule darwaze se behtar. */
  const primary = dedicated || serviceRole;
  if (!primary) {
    throw new Error(
      "No signing secret: set PDF_SIGNING_SECRET (or SUPABASE_SERVICE_ROLE_KEY) — refusing to sign with an empty key",
    );
  }
  const legacy =
    dedicated && serviceRole && serviceRole !== dedicated && legacyGraceActive(now) ? [serviceRole] : [];
  return { primary, legacy };
}
