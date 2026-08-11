import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Compute the penalty to apply to a customer's health based on how long
 * they've had an outstanding balance. As days pass without payment, the
 * effective health drops automatically.
 *
 *   0-7 days   → no penalty (still in friendly-reminder window)
 *   8-15 days  → -10  (gentle warning zone)
 *   16-30 days → -20  (urgent, stronger nudge)
 *   31-60 days → -35  (consider suspending service)
 *   60+ days   → -55  (bad debt territory, write-off zone)
 */
export function healthPenaltyFromOutstandingDays(days: number): number {
  if (days <= 7)   return 0;
  if (days <= 15)  return 10;
  if (days <= 30)  return 20;
  if (days <= 60)  return 35;
  return 55;
}

/**
 * Combine base customer health with the outstanding penalty. Result is clamped 0-100.
 */
export function effectiveHealth(baseHealth: number, outstandingDays: number | null | undefined): number {
  if (!outstandingDays || outstandingDays <= 0) return baseHealth;
  return Math.max(0, Math.min(100, baseHealth - healthPenaltyFromOutstandingDays(outstandingDays)));
}

/**
 * Merge Tailwind classes with conflict resolution.
 * Use everywhere instead of template literals for className.
 *
 * @example
 * cn("px-2 py-1", isActive && "bg-amber", className)
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a number as Indian Rupees.
 * Internally we store paise (integer) but most UI calls pass rupees.
 * Use `rupeeFromPaise()` if you have paise.
 *
 * @example
 * rupee(490644)             // "₹4,90,644"
 * rupee(490644, { compact: true })  // "₹4.9L"
 * rupee(0)                  // "₹0"
 * rupee(null)               // "—"
 */
export function rupee(
  n: number | null | undefined,
  opts: { compact?: boolean; decimals?: number } = {}
): string {
  const { compact = false, decimals = 0 } = opts;
  if (n === null || n === undefined) return "—";
  const abs = Math.abs(n);
  if (compact) {
    if (abs >= 10_000_000) return `₹${(n / 10_000_000).toFixed(decimals || 1)}Cr`;
    if (abs >= 100_000) return `₹${(n / 100_000).toFixed(decimals || 1)}L`;
    if (abs >= 1_000) return `₹${(n / 1_000).toFixed(decimals || 1)}K`;
    return `₹${n.toFixed(decimals)}`;
  }
  // Indian numbering format: 4,90,644
  const fixed = n.toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  const formatted = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`
    : last3;
  return `₹${formatted}${decPart ? `.${decPart}` : ""}`;
}

/**
 * Convert paise (integer) to rupees and format.
 * @example rupeeFromPaise(49064400) // "₹4,90,644"
 */
export function rupeeFromPaise(paise: number | null | undefined, opts?: Parameters<typeof rupee>[1]) {
  if (paise === null || paise === undefined) return "—";
  return rupee(paise / 100, opts);
}

/**
 * Format an integer with Indian comma separators (no currency).
 * @example num(1234567) // "12,34,567"
 */
export function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN");
}

/**
 * Format a date in IST as "DD MMM YYYY" (e.g., "15 May 2026").
 */
export function formatDate(
  input: Date | string | number | null | undefined,
  format: "short" | "long" | "relative" = "short"
): string {
  if (!input) return "—";
  const d = typeof input === "string" || typeof input === "number" ? new Date(input) : input;
  if (isNaN(d.getTime())) return "—";

  if (format === "relative") {
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return formatDate(d, "short");
  }

  const day = d.getDate();
  const month = d.toLocaleString("en-IN", { month: "short", timeZone: "Asia/Kolkata" });
  const year = d.getFullYear();
  if (format === "long") {
    const time = d.toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata", hour12: true });
    return `${day} ${month} ${year} · ${time}`;
  }
  return `${day} ${month} ${year}`;
}

/**
 * Normalise an Indian phone to bare E.164 digits (no `+`, no spaces).
 * Accepts free-form input ("+91 98765 43210", "9876543210", "098765 43210").
 * A bare 10-digit number is assumed Indian and prefixed with 91.
 * Returns null when there aren't enough digits to be a real number.
 */
export function toWhatsAppDigits(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("0")) d = d.replace(/^0+/, "");     // strip STD leading zeros
  if (d.length === 10) d = "91" + d;                    // bare Indian mobile → add country code
  if (d.length < 10) return null;
  return d;
}

/**
 * Days between two dates, IST-aware and date-only (ignores time of day).
 *
 * Old impl used millisecond diff + Math.round which was off-by-one for the
 * common case "is X due today?" when called near midnight or with a date
 * string that parses to UTC midnight while `from` is wall-clock. Now we
 * snap both endpoints to IST date boundaries and integer-floor before
 * subtracting, matching the IST-aware day arithmetic used by the renewal
 * cadence engine.
 *
 * @example daysBetween(new Date(), "2026-05-24") // 0 anywhere in IST today
 */
export function daysBetween(from: Date | string, to: Date | string): number {
  const a = from instanceof Date ? from : new Date(from);
  const b = to   instanceof Date ? to   : new Date(to);
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const dayMs       = 24 * 60 * 60 * 1000;
  const aIST = Math.floor((a.getTime() + istOffsetMs) / dayMs);
  const bIST = Math.floor((b.getTime() + istOffsetMs) / dayMs);
  return bIST - aIST;
}

/**
 * End-of-day in IST for a `YYYY-MM-DD` (or ISO) date string, as a Date.
 *
 * A quote "valid until 30 Jun 2026" must stay valid through the WHOLE of
 * 30 Jun in IST — i.e. until 23:59:59.999 IST. Since IST = UTC+5:30, that
 * instant equals 18:29:59.999 UTC on the SAME calendar date. Comparing against
 * a bare `new Date("2026-06-30")` (UTC midnight = 05:30 IST) wrongly expired
 * the quote at dawn on its last valid day. (audit bug #20)
 */
export function endOfDayIST(dateStr: string): Date {
  const ymd = dateStr.slice(0, 10); // tolerate full ISO timestamps too
  return new Date(`${ymd}T18:29:59.999Z`);
}

/**
 * Is a quote (or any dated document) expired, judged at end-of-day IST?
 * Returns false when no expiry date is set. (audit bug #20)
 */
export function isQuoteExpired(
  expiresDate: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!expiresDate) return false;
  return now.getTime() > endOfDayIST(expiresDate).getTime();
}

// ──────────────────────────────────────────────────────────────────────
// GSTIN
//
// A valid Indian GSTIN is 15 chars: `SSPPPPPPPPPPENZC`
//   - SS    : state code (digits 0-9)            — positions 1-2
//   - PPPPP : PAN's first 5 (5 uppercase letters) — positions 3-7
//   - PPPP  : PAN's next 4 (4 digits)             — positions 8-11
//   - P     : PAN's 10th (1 uppercase letter)     — position 12
//   - E     : entity number (1 digit 1-9 or letter) — position 13
//   - N     : literal `Z`                          — position 14
//   - C     : checksum char (0-9 or A-Z)           — position 15
//
// The checksum follows a mod-36 algorithm (similar to GS1):
//   - chars 0-9 map to values 0-9, A-Z map to 10-35
//   - iterate right-to-left over the first 14 chars
//   - alternating factor 2, 1, 2, 1, ... (start 2)
//   - product = code * factor;  digit = floor(product/36) + (product % 36)
//   - sum all digits
//   - checksum = (36 - sum % 36) % 36;  back-convert to char
// ──────────────────────────────────────────────────────────────────────

const GSTIN_FORMAT_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const GSTIN_CHARS     = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function gstinChecksum(first14: string): string {
  let sum = 0;
  let factor = 2;
  for (let i = first14.length - 1; i >= 0; i--) {
    const code = GSTIN_CHARS.indexOf(first14[i]);
    if (code < 0) return ""; // unknown char
    const product = code * factor;
    sum   += Math.floor(product / 36) + (product % 36);
    factor = factor === 2 ? 1 : 2;
  }
  const checkVal = (36 - (sum % 36)) % 36;
  return GSTIN_CHARS[checkVal];
}

/**
 * Validate an Indian GSTIN — full format + mod-36 checksum.
 * Returns true only when the 15th character matches the computed checksum.
 * @example isValidGstin("07ABDCA0298H1ZP") // true
 * @example isValidGstin("27AABCE9876D1Z3") // false (placeholder, bad checksum)
 */
export function isValidGstin(gstin: string): boolean {
  if (!gstin || gstin.length !== 15)       return false;
  const upper = gstin.toUpperCase();
  if (!GSTIN_FORMAT_RE.test(upper))         return false;
  const expected = gstinChecksum(upper.slice(0, 14));
  return expected !== "" && expected === upper[14];
}

/**
 * Verbose GSTIN validator — returns a structured result so callers can
 * surface the right error to the user (format vs. checksum).
 */
export function validateGstin(gstin: string):
  | { ok: true }
  | { ok: false; reason: "empty" | "length" | "format" | "checksum"; message: string } {
  if (!gstin)                          return { ok: false, reason: "empty",    message: "GSTIN is empty"      };
  const upper = gstin.toUpperCase();
  if (upper.length !== 15)             return { ok: false, reason: "length",   message: "GSTIN must be 15 chars" };
  if (!GSTIN_FORMAT_RE.test(upper))    return { ok: false, reason: "format",   message: "GSTIN format is wrong — expected SS+5letters+4digits+letter+digit/letter+Z+check" };
  const expected = gstinChecksum(upper.slice(0, 14));
  if (expected !== upper[14])          return { ok: false, reason: "checksum", message: `Checksum mismatch (got ${upper[14]}, expected ${expected})` };
  return { ok: true };
}

/**
 * GST state-code → state-name map.
 * First 2 digits of a GSTIN encode the state. Source: GSTN master list.
 *  - 28 was the old AP (pre-Telangana split, deprecated)
 *  - 25 was old Daman & Diu (merged into 26 in 2020)
 *  - 97/99 are administrative (Other Territory / Centre)
 * Kept here as the single lookup table for the whole app.
 */
/**
 * Format a foreign (non-INR) vendor-bill amount in the supplier's own currency,
 * derived from the ₹ figure + the stored exchange rate. Returns null for
 * domestic (INR) bills or when there's no usable rate — callers show only ₹ then.
 * @example foreignAmount("USD", 24293, 91.5) // "$265.50"
 */
export function formatForeignAmount(currency: string | null | undefined, amount: number): string | null {
  const cur = (currency || "INR").toUpperCase();
  if (cur === "INR") return null;
  const sym: Record<string, string> = { USD: "$", GBP: "£", EUR: "€", AUD: "A$", CAD: "C$", SGD: "S$", JPY: "¥" };
  const prefix = sym[cur] ?? `${cur} `;
  return prefix + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function foreignAmount(currency: string | null | undefined, inr: number, fxRate: number | null | undefined): string | null {
  if (!fxRate || fxRate <= 0) return null;
  return formatForeignAmount(currency, inr / fxRate);
}

export const GST_STATE_BY_CODE: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Centre Jurisdiction",
};

/**
 * Pulls (code, name) from a GSTIN by reading the first two digits.
 * Returns nulls if the GSTIN is too short or the code isn't recognised.
 * Doesn't validate the full checksum — see isValidGstin() for that.
 * @example gstStateFromGstin("07ABDCA0298H1ZP") // { code: "07", name: "Delhi" }
 */
export function gstStateFromGstin(gstin: string): { code: string | null; name: string | null } {
  const cleaned = (gstin || "").trim().toUpperCase();
  if (cleaned.length < 2) return { code: null, name: null };
  const code = cleaned.slice(0, 2);
  if (!/^\d{2}$/.test(code))     return { code: null, name: null };
  const name = GST_STATE_BY_CODE[code] ?? null;
  return { code, name };
}

/**
 * Format a phone number to standard Indian format.
 * @example formatPhone("9876543210") // "+91 98765 43210"
 */
export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "").replace(/^91/, "");
  if (digits.length !== 10) return phone;
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

/**
 * Initials from a full name (max 2 chars).
 * @example initials("Rajesh Kumar Sharma") // "RS"
 */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase())
    .filter((_, i, arr) => i === 0 || i === arr.length - 1)
    .join("")
    .slice(0, 2);
}

/**
 * Human label for a bank/cash account: "HDFC ••1234". Crucially, it OMITS the
 * masked-number suffix when the account has no number (e.g. a cash-in-hand
 * account), so it never renders the stray "••null" bug. Use everywhere a bank
 * account is shown so the fix stays in one place.
 */
export function bankLabel(name?: string | null, last4?: string | null): string {
  const base = (name ?? "").trim() || "Account";
  const l4 = (last4 ?? "").trim();
  return l4 ? `${base} ••${l4}` : base;
}

/**
 * Truncate a string with ellipsis.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Sleep for ms milliseconds (useful for testing UX, NEVER in production logic).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Type guard: filter out null/undefined.
 * @example items.filter(notNull)
 */
export function notNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Type-safe object entries (Object.entries with proper types).
 */
export function entries<T extends object>(obj: T): [keyof T, T[keyof T]][] {
  return Object.entries(obj) as [keyof T, T[keyof T]][];
}

/**
 * Clean an entity's display name for the primary line.
 *
 * A few tenants store a phone / GSTIN appended to the NAME
 * (e.g. "Hakimuddin Nazarali -274092700925"). That raw number shouldn't crowd
 * the primary name — strip a trailing " - <7+ digits>" so the name reads clean;
 * the number can be surfaced as secondary metadata via {@link phoneSuffixOf}.
 * Legit names (with dots, letters, short numbers) are left untouched.
 */
const NAME_NUM_SUFFIX = /\s*[-–—]\s*(\d[\d\s]{6,})\s*$/;
export function cleanDisplayName(raw: string): string {
  const name = raw.replace(NAME_NUM_SUFFIX, "").trim();
  return name || raw.trim();
}
/** The phone/number suffix stripped from a name by {@link cleanDisplayName}, else null. */
export function phoneSuffixOf(raw: string): string | null {
  const m = raw.match(NAME_NUM_SUFFIX);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

/**
 * Title-case a person's name for DISPLAY only (never mutate the stored value).
 * Fixes mixed-casing data (e.g. "HITESH BABU" / "prashant" → "Hitesh Babu" /
 * "Prashant"). Handles hyphens and apostrophes ("d'souza" → "D'Souza",
 * "sai-kiran" → "Sai-Kiran"). A token that is ALL-CAPS and short (≤3 chars,
 * e.g. "HR", "IT") is left as-is so genuine acronyms aren't broken.
 */
export function toTitleCase(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return s;
  const capWord = (w: string): string => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w);
  return s
    .split(/\s+/)
    .map((word) => {
      if (word.length <= 3 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word; // keep HR, IT, CEO
      return word.split(/([-'])/).map((part) => (part === "-" || part === "'" ? part : capWord(part))).join("");
    })
    .join(" ");
}
