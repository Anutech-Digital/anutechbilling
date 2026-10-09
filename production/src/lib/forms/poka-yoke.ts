/**
 * Mistake-proof field handling — the rules, with no React in them.
 *
 * ─── THE ONE PRINCIPLE EVERYTHING HERE OBEYS ────────────────────────────────
 * Auto-correction may change how a value LOOKS. It may never change what the value
 * MEANS, and it may never refuse a keystroke.
 *
 * That second half is where most "smart" fields go wrong. A field that blocks the 6th
 * digit of a phone number because 6 digits is not a valid mobile is unusable — nobody
 * types the 10th digit first. A field that reformats on every keystroke moves the caret
 * out from under the operator's finger and they end up with "98 76598765". Both are worse
 * than the plain input they replaced, and both are sold as error prevention.
 *
 * So the split here is deliberate and every caller has to honour it:
 *   • `live*`   — safe on every keystroke. Only ever removes characters that can never be
 *                 part of the value, and never inserts.
 *   • `commit*` — the pretty form, applied on BLUR, when the operator has finished.
 *   • `check*`  — never changes anything. Answers "is this right yet?", which is what the
 *                 green and red pills read.
 *
 * ─── AND A PILL SAYS WHAT IS WRONG, NOT JUST THAT SOMETHING IS ──────────────
 * "Invalid GSTIN" tells an operator nothing they did not already suspect. "15 characters
 * needed, you have 14" tells them what to do, which is the §24 rule applied to a field
 * instead of a dialog. Nothing here ever returns a bare "invalid".
 */
import { isValidGstin, GST_STATE_BY_CODE } from "@/lib/utils";

/**
 * What a validation pill shows.
 *
 * `tone: "empty"` is its own state, NOT an error. A field nobody has typed in yet is not
 * wrong, and painting it red is how a form greets you by shouting.
 */
export interface FieldCheck {
  tone: "empty" | "typing" | "ok" | "error";
  /** Shown in the pill. Always says what to do when the tone is "error". */
  message: string;
  /** Extra fact worth surfacing — the GST state, for instance. */
  detail?: string;
}

const EMPTY: FieldCheck = { tone: "empty", message: "" };

/* ── GSTIN ─────────────────────────────────────────────────────────────────── */

/**
 * On every keystroke: upper-case, and drop anything a GSTIN cannot contain.
 *
 * A GSTIN is 15 alphanumerics. Spaces come from copy-paste out of PDFs and WhatsApp,
 * where they are always noise, so removing them is safe. Length is NOT enforced here —
 * see the header on why a field must never refuse a keystroke.
 */
export function liveGstin(raw: string): string {
  return raw.replace(/[^0-9a-zA-Z]/g, "").toUpperCase().slice(0, 15);
}

/**
 * Is it right yet — and if not, exactly what is missing.
 *
 * The checksum is the whole point. A 15-character string of the right SHAPE is what a
 * typo produces, and it is what puts a wrong tax head on an invoice: see
 * lib/gst/gstin-state.ts, where a GSTIN that fails the checksum is refused the right to
 * decide the place of supply at all.
 */
export function checkGstin(raw: string): FieldCheck {
  const v = liveGstin(raw);
  if (!v) return EMPTY;

  if (v.length < 15) {
    /* Counted out loud. "Invalid GSTIN" would leave them staring at 15 characters
       trying to spot which one is wrong when the answer is that one is missing. */
    return { tone: "typing", message: `${15 - v.length} more character${15 - v.length === 1 ? "" : "s"} — a GSTIN is 15.` };
  }
  if (!isValidGstin(v)) {
    /* Says the state code is unknown when that is the actual fault, because that is the
       one an operator can fix by looking at the certificate again. */
    const state = GST_STATE_BY_CODE[v.slice(0, 2)];
    return {
      tone: "error",
      message: state
        ? "This GSTIN's check digit does not match — one character is mistyped."
        : `“${v.slice(0, 2)}” is not a GST state code, so the first two characters are wrong.`,
    };
  }
  return {
    tone: "ok",
    message: "Valid GSTIN",
    /* The state is shown because it is about to decide IGST vs CGST+SGST, and an
       operator who sees "Delhi" when they expected Haryana has caught a wrong paste
       before it became a tax head. */
    detail: GST_STATE_BY_CODE[v.slice(0, 2)],
  };
}

/** The state code a valid GSTIN implies — null for anything that fails the checksum. */
export function gstinState(raw: string): { code: string; name: string } | null {
  const v = liveGstin(raw);
  if (!isValidGstin(v)) return null;
  const code = v.slice(0, 2);
  const name = GST_STATE_BY_CODE[code];
  return name ? { code, name } : null;
}

/* ── Phone ─────────────────────────────────────────────────────────────────── */

/**
 * On every keystroke: digits only, and a leading 91 or 0 stripped once ten digits are in
 * sight.
 *
 * Deliberately does NOT insert spaces while typing. Grouping mid-type is what fights the
 * caret; the pretty form arrives on blur via `commitPhone`.
 */
export function livePhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  /* +91 / 0091 / a trunk 0 are prefixes, not part of the number. Removed only when what
     follows could be a real mobile, so somebody typing a landline or a partial number is
     not silently edited. */
  const stripped = d.replace(/^(?:0091|91|0)(?=[6-9]\d{0,9}$)/, "");
  return stripped.slice(0, 10);
}

/** The display form, applied on blur. `+91 98765 43210`. */
export function commitPhone(raw: string): string {
  const d = livePhone(raw);
  return d.length === 10 ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : raw.trim();
}

export function checkPhone(raw: string): FieldCheck {
  const d = livePhone(raw);
  if (!d) return EMPTY;

  if (d.length < 10) {
    return { tone: "typing", message: `${10 - d.length} more digit${10 - d.length === 1 ? "" : "s"} — an Indian mobile is 10.` };
  }
  if (!/^[6-9]/.test(d)) {
    /* The single most common paste error: a landline with its STD code, which is ten
       digits and looks perfect until somebody tries to WhatsApp it. */
    return {
      tone: "error",
      message: "Indian mobiles start with 6, 7, 8 or 9 — this looks like a landline.",
    };
  }
  return { tone: "ok", message: "Valid mobile number" };
}

/* ── Domain ────────────────────────────────────────────────────────────────── */

/**
 * `https://www.acme.com/pricing?ref=x` → `acme.com`.
 *
 * Safe on every keystroke: it only ever removes, and the pieces it removes (scheme, www,
 * path, query, trailing dot) can never be part of a domain. Lower-cased because domains
 * are case-insensitive and a mixed-case one will not match a stored customer_domains row.
 */
export function liveDomain(raw: string): string {
  return raw
    .trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")   // scheme
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")                   // path, query, fragment
    .replace(/^@+|@.*$/g, (m) => (m.startsWith("@") ? "" : m))
    .replace(/\.+$/, "")
    .replace(/\s+/g, "");
}

export function checkDomain(raw: string): FieldCheck {
  const d = liveDomain(raw);
  if (!d) return EMPTY;
  if (!d.includes(".")) {
    return { tone: "typing", message: "Add the ending — .com, .in, .co.in…" };
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
    return { tone: "error", message: "A domain is letters, numbers and dots — like acme.co.in." };
  }
  return { tone: "ok", message: "Valid domain" };
}

/* ── Money ─────────────────────────────────────────────────────────────────── */

/**
 * ─── WHOLE RUPEES, AND THE FIELD SAYS SO ────────────────────────────────────
 * This codebase stores money in whole rupees (CLAUDE.md §13, corrected against live data
 * after the file itself claimed paise). A field that silently accepts "1500.50" and
 * rounds it has decided something about someone's money without telling them.
 *
 * So a decimal point is not stripped in silence — `checkMoney` reports it, and the
 * operator decides. Everything else that is not a digit IS noise: commas and spaces come
 * from pasting "1,50,000" out of a spreadsheet, and the rupee sign is decoration.
 */
export function liveMoney(raw: string): string {
  /* Keeps the dot AND a leading minus. Both survive for the same reason: so `checkMoney`
     can SAY something about them. Stripping the minus would turn -500 into 500 in silence,
     which is the one thing this module promises never to do to a number — and the dot has
     to stay or a typed "1500." is fought mid-keystroke. */
  const sign   = /^\s*-/.test(raw) ? "-" : "";
  const digits = raw.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
  return (sign + digits).slice(0, 16);
}

/** The number a money field holds, or null when it does not hold one yet. */
export function parseMoney(raw: string): number | null {
  const v = liveMoney(raw);
  if (!v || v === ".") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Indian grouping: 1,50,000 — not 150,000. Applied on blur. */
export function commitMoney(raw: string): string {
  const n = parseMoney(raw);
  if (n == null) return raw.trim();
  return Math.round(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export function checkMoney(raw: string): FieldCheck {
  const v = liveMoney(raw);
  if (!v) return EMPTY;

  const n = parseMoney(raw);
  if (n == null) return { tone: "typing", message: "Type an amount in rupees." };
  if (n < 0) {
    /* Reachable precisely because liveMoney keeps the minus. A refund or a reduction has
       its own document — a credit note — and is never a negative number typed into an
       amount box. Said, not corrected. */
    return { tone: "error", message: "An amount cannot be negative — raise a credit note instead." };
  }

  if (v.includes(".") && !Number.isInteger(n)) {
    /* Stated, not silently rounded. It is their money. */
    return {
      tone: "error",
      message: `Paise are not stored — this will be saved as ₹${Math.round(n).toLocaleString("en-IN")}.`,
    };
  }
  return {
    tone: "ok",
    message: `₹${Math.round(n).toLocaleString("en-IN")}`,
    detail: "whole rupees",
  };
}

/* ── Email ─────────────────────────────────────────────────────────────────── */

/** Lower-cased and de-spaced. Both are safe: an address is case-insensitive at the domain
 *  and can never contain a space, and both arrive constantly from WhatsApp paste. */
export function liveEmail(raw: string): string {
  return raw.replace(/\s+/g, "").toLowerCase();
}

export function checkEmail(raw: string): FieldCheck {
  const v = liveEmail(raw);
  if (!v) return EMPTY;
  if (!v.includes("@")) return { tone: "typing", message: "An address needs an @." };
  if (!/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(v)) {
    return { tone: "error", message: "Check the address — it should look like name@company.com." };
  }
  return { tone: "ok", message: "Valid email" };
}

/* ── Company, as far as it can honestly be known ───────────────────────────── */

/**
 * Free-mail hosts. An address at one of these says nothing about the company.
 *
 * The list matters more than it looks: without it, three customers on gmail.com would all
 * be filed under the "company domain" gmail.com, and the domain-matching that links an
 * enquiry to a customer would tie together three businesses that have never met.
 */
const FREE_MAIL: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.in", "yahoo.co.in",
  "hotmail.com", "outlook.com", "live.com", "msn.com",
  "rediffmail.com", "rediff.com", "icloud.com", "me.com", "aol.com",
  "protonmail.com", "proton.me", "zohomail.in", "zoho.com",
]);

/**
 * The company DOMAIN implied by a work email — and nothing more.
 *
 * ─── WHY THIS AND NOT A COMPANY NAME ────────────────────────────────────────
 * The brief asks smart-paste to extract "Company". A domain is the part of that which can
 * actually be known: `rahul@acme.co.in` is `acme.co.in`, derivably, every time. The NAME
 * is not — "Acme", "Acme Corp", "Acme Corporation Pvt Ltd" and "ACME India" are four
 * different strings for one business, and the one that ends up on a tax invoice is a legal
 * fact nobody should guess from an email address. The GSTIN lookup already fills the legal
 * name properly.
 *
 * So this fills the website field and leaves the company name for a human. A blank costs
 * ten seconds of typing; a wrong bill-to party costs a reissued invoice.
 */
export function companyDomainFromEmail(email: string | null | undefined): string | null {
  const host = liveEmail(email ?? "").split("@")[1] ?? "";
  const domain = liveDomain(host);
  if (!domain || !domain.includes(".")) return null;
  return FREE_MAIL.has(domain) ? null : domain;
}

/* ── Payment reference (R-449) ─────────────────────────────────────────────── */

/**
 * The reference a payment method's own format allows, or null when it fits.
 * - UPI: the UTR / UPI ref is exactly 12 digits (GPay, PhonePe, Paytm, bank QR all show it).
 * - Bank transfer: IMPS 12, NEFT 16, RTGS 22 — letters and digits, 12 to 22 long.
 * Spaces and hyphens from copy-paste are ignored. Other methods: no format rule here.
 * A 5-digit "12345" used to save as a UPI payment (Abhishek, 8 Oct 2026).
 */
export function paymentRefProblem(method: string, raw: string): string | null {
  const ref = raw.replace(/[\s-]/g, "");
  if (method === "upi") {
    if (/^\d{12}$/.test(ref)) return null;
    const digits = ref.replace(/\D/g, "").length;
    return /\D/.test(ref)
      ? "A UPI reference is 12 digits, numbers only."
      : `A UPI reference is 12 digits — this has ${digits}.`;
  }
  if (method === "bank_transfer") {
    if (/^[A-Za-z0-9]{12,22}$/.test(ref)) return null;
    return "A bank UTR is 12 to 22 letters and digits (IMPS 12, NEFT 16, RTGS 22).";
  }
  return null;
}
