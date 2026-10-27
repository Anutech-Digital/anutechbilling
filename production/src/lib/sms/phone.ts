/**
 * R-1903: Indian mobile numbers for OTP — one shape everywhere ("+91" + 10 digits, E.164,
 * the same shape users.phone already documents) and one masked form for every log line.
 *
 * Client-safe (no server imports): the Mobile number card uses the same rules as the routes.
 */

/** "98765 43210", "+91-98765-43210", "09876543210", "919876543210" → "+919876543210"; else null. */
export function normalizeIndianMobile(raw: string | null | undefined): string | null {
  let d = (raw ?? "").replace(/[\s\-().]/g, "");
  if (d.startsWith("+91")) d = d.slice(3);
  else if (/^91\d{10}$/.test(d)) d = d.slice(2);
  else if (/^0\d{10}$/.test(d)) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
}

/** The 10 digits after +91 (for the input box), or "" when the saved number is not one. */
export function localDigits(e164: string | null | undefined): string {
  const n = normalizeIndianMobile(e164);
  return n ? n.slice(3) : "";
}

/** "+919876543210" → "+91 98765 43210" — the person's OWN number, on their own screen. */
export function formatIndianMobile(e164: string | null | undefined): string {
  const n = normalizeIndianMobile(e164);
  return n ? `+91 ${n.slice(3, 8)} ${n.slice(8)}` : (e164 ?? "");
}

/**
 * "+919876543210" → "+91 98*****210". The ONLY form a number may take in a log or audit line.
 * Same rule as public.mask_phone() in migration 20261025083015_r1903_phone_otp.
 */
export function maskPhone(p: string | null | undefined): string {
  if (!p) return "";
  if (/^\+91\d{10}$/.test(p)) return `+91 ${p.slice(3, 5)}*****${p.slice(-3)}`;
  if (p.length > 4) return "*".repeat(p.length - 3) + p.slice(-3);
  return "***";
}
