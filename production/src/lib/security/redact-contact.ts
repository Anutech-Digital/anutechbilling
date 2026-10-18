/**
 * R-1610 (19 Oct 2026): the ONE way a server log line names a customer's email or phone.
 *
 * Logs go to Cloud Logging, kept for months and readable by anyone with a GCP viewer role, so a
 * full address there is customer data leaked to a place nobody reviews (DPDP). A log line still
 * has to be useful when something fails, so the mask keeps enough to tell two customers apart
 * and to match the record in the app (first letter + domain; country code, first two and the
 * line's tail) — never the whole value.
 *
 *   maskEmail("pardeep@anutech.in")   → "p***@anutech.in"
 *   maskPhone("+91 98765 43210")      → "+91 98***43210"
 *   maskContactValue(x)               → either of the above, by shape; arrays joined
 *   redactContacts(text)              → every email/phone INSIDE a free-text string masked
 *                                       (SMTP/provider error messages quote the recipient)
 *
 * Display masking for roles that may not see a contact is a different job — that is
 * maskContact() in lib/auth/roles.ts. The scan test (contact-logging-scan.test.ts) fails on a new
 * console line that prints an email/phone/recipient without one of these.
 */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/** A phone-like run: optional +, 10–15 digits with spaces, dots or dashes between. */
const PHONE_RE = /\+?\d(?:[\s.-]?\d){9,14}/g;

export function maskEmail(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "(none)";
  const at = v.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${v[0]}***${v.slice(at)}`;
}

export function maskPhone(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "(none)";
  const digits = v.replace(/\D/g, "");
  if (digits.length < 7) return "***";
  /* National part = the last 10 digits; anything before it is the country code. */
  const national = digits.length > 10 ? digits.slice(-10) : digits;
  const cc = digits.length > 10 ? `+${digits.slice(0, -10)} ` : v.startsWith("+") ? "+" : "";
  const tail = Math.min(5, national.length - 4);
  return `${cc}${national.slice(0, 2)}***${national.slice(-tail)}`;
}

/** An email or a phone, by its shape; a list (to: string[]) masked item by item. */
export function maskContactValue(value: string | readonly string[] | null | undefined): string {
  if (Array.isArray(value)) return value.map((v) => maskContactValue(v)).join(", ") || "(none)";
  const v = String(value ?? "").trim();
  if (!v) return "(none)";
  return v.includes("@") ? maskEmail(v) : maskPhone(v);
}

/** Free text (an error message, a provider reply) with every email and phone inside it masked. */
export function redactContacts(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(EMAIL_RE, (m) => maskEmail(m))
    .replace(PHONE_RE, (m) => maskPhone(m));
}
