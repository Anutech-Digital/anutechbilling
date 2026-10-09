/**
 * Smart Paste for a LEAD — the extra fields a lead form has and an enquiry email does not need.
 *
 * ─── WHY A WRAPPER AND NOT A CHANGE TO lib/inbound/extract.ts (R-491, 9 Oct 2026) ──────
 * Abhishek pasted "Gupta Traders Pvt Ltd … 15 Google Workspace Business Starter … GSTIN
 * 07AABCG1234K1Z5, Delhi … monthly" into Add lead's Smart Paste. Name, email, phone, product
 * and domain filled; company, seats ("not found" while 15 was right there), GSTIN, state and
 * billing stayed blank.
 *
 * `extractEntities` also decides what the INBOUND-EMAIL AUTO-QUOTE puts on a quote the app may
 * send by itself. Teaching it a looser seat rule there would change a price a customer can hold
 * us to. So the extractor is called untouched and this module only ADDS:
 *
 *   • seats — ONLY when the extractor found none, and only a number written right before a
 *     product ("15 Google Workspace …"). It can turn a null into a number; it can never change
 *     a number the extractor returned (same strict-first argument as SEATS_GAPPED_RE).
 *   • company — a "Company: …" line, or capitalised words ending in a legal suffix
 *     (Pvt Ltd / Private Limited / Ltd / LLP / LLC / Inc / OPC).
 *   • GSTIN — the 15-character pattern. Filled even when its check digit fails (the form shows
 *     that error itself), but then it is NOT trusted for the state.
 *   • state — from a checksum-valid GSTIN (lib/gst/gstin-state.ts), else from exactly one GST
 *     state name written in the text. Two different states named → nothing.
 *   • billing — "monthly billing" style phrases first (findBillingCycle), else the term the
 *     sender stated (findBillingTerm, via the extractor). Both terms stated → nothing.
 *
 * Same rule as the extractor: written rules, every value carries its source, and anything not
 * found stays null.
 */
import {
  extractEntities,
  findBillingCycle,
  type CatalogueEntry,
  type Extracted,
  type ExtractedEntities,
} from "@/lib/inbound/extract";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { GST_STATE_BY_CODE, isValidGstin } from "@/lib/utils";

export type LeadBillingCycle = "monthly" | "yearly";

export interface LeadPasteEntities extends ExtractedEntities {
  company:   Extracted<string>;
  gstin:     Extracted<string>;
  /** False when a GSTIN was read but its check digit does not match — shown as a warning. */
  gstinValid: boolean;
  /** GST state code ("07"), never a free-text name. */
  stateCode: Extracted<string>;
  billing:   Extracted<LeadBillingCycle>;
}

const NONE = { value: null, source: null } as const;

/* ── Seats: "15 Google Workspace …" ───────────────────────────────────────── */

/** Vendor phrases a seat count is written in front of, besides the catalogue's own names. */
const VENDOR_PHRASES = [
  String.raw`google\s+workspace`, String.raw`g\s?-?suite`, String.raw`gsuite`,
  String.raw`microsoft\s+365`, String.raw`office\s+365`, "m365", "o365",
  String.raw`zoho\s+(?:mail|workplace)`,
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function seatsBeforeProduct(text: string, catalogue: readonly CatalogueEntry[]): Extracted<number> {
  const names = catalogue
    .map((c) => c.name.trim())
    .filter((n) => n.length >= 4)
    .sort((a, b) => b.length - a.length)
    .map((n) => escapeRe(n).replace(/\s+/g, String.raw`\s+`));
  const products = [...names, ...VENDOR_PHRASES].join("|");
  /* Not a slice of a longer number or an amount ("Rs 15 Google…", "₹1,500"), and not the
     "365" of "Microsoft 365" / "Office 365" itself. */
  const re = new RegExp(
    String.raw`(?<![0-9,.₹])(?<!\b(?:rs|inr|microsoft|office)\.?\s*)([0-9]{1,4})\s*(?:x\s*)?(?:${products})(?![\p{L}\p{N}])`,
    "iu",
  );
  const m = re.exec(text);
  if (!m) return { ...NONE };
  const n = Number(m[1]);
  /* A four-digit 19xx/20xx is a year ("2026 Google Workspace pricing"), not 2026 seats. */
  if (!Number.isFinite(n) || n <= 0 || n > 9999 || (m[1].length === 4 && n >= 1900 && n <= 2099)) {
    return { ...NONE };
  }
  return { value: n, source: m[0].trim().replace(/\s+/g, " ") };
}

/* ── Company ───────────────────────────────────────────────────────────────── */

const COMPANY_LABEL_RE = /^\s*(?:company(?:\s+name)?|firm(?:\s+name)?|organi[sz]ation|business(?:\s+name)?)\s*[:\-–]\s*(.{2,80}?)\s*[,.;]?\s*$/im;

const LEGAL_SUFFIX =
  String.raw`(?:pvt\.?\s*ltd\.?|private\s+limited|pvt\.?\s+limited|ltd\.?|limited|l\.?l\.?p\.?|llc|inc\.?|opc(?:\s+pvt\.?\s*ltd\.?)?)`;

/* One to six capitalised words (or "&") right before the suffix. A lowercase word — "from",
   "se", "main" — breaks the chain, so "main Rahul from Gupta Traders Pvt Ltd se" yields only
   "Gupta Traders Pvt Ltd". */
/* The words must be capitalised but the suffix may be any case ("PVT LTD", "Pvt ltd"), so the
   suffix is spelled case-free by hand rather than with the `i` flag (which would also let
   lowercase words into the chain). */
const anyCase = (re: string) => re.replace(/\\.|[a-z]/g, (c) => (c.length === 2 ? c : `[${c}${c.toUpperCase()}]`));
const COMPANY_SUFFIX_RE = new RegExp(
  String.raw`((?:(?:[A-Z0-9][A-Za-z0-9&'.\-]*|&)[ \t]+){1,6})(${anyCase(LEGAL_SUFFIX)})(?![A-Za-z])`,
  "",
);

/** Greetings / intro words a capitalised chain can start with but a company name does not. */
const LEADING_NOISE = /^(?:(?:hi|hello|hey|dear|team|from|at|of|for|main|mai|we|i|this|our|company|firm|name|is|am|sir|madam|ji)\b[ \t]*)+/i;

function tidyCompany(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/[,;:]+$/, "").replace(/\.$/, "").trim();
}

export function findCompany(text: string): Extracted<string> {
  const label = COMPANY_LABEL_RE.exec(text);
  if (label) {
    const v = tidyCompany(label[1]);
    if (v.length >= 2 && !v.includes("@")) return { value: v, source: label[0].trim() };
  }
  /* Capitalised first; a lowercase WhatsApp ("gupta traders pvt ltd") only as a fallback, and
     then only the two words before the suffix — a lowercase chain has no edge to stop at. */
  const m = COMPANY_SUFFIX_RE.exec(text);
  if (m) {
    const words = m[1].replace(LEADING_NOISE, "").trim();
    if (words && /[A-Za-z]/.test(words)) {
      const v = tidyCompany(`${words} ${m[2]}`);
      return { value: v, source: m[0].trim() };
    }
  }
  const ci = /((?:[a-z0-9&'.\-]+[ \t]+){1,2})(pvt\.?\s*ltd\.?|private\s+limited|llp)(?![a-z])/i.exec(text);
  if (ci) {
    const words = ci[1].replace(LEADING_NOISE, "").trim();
    if (words && /[a-z]/i.test(words)) {
      const v = tidyCompany(`${words} ${ci[2]}`).replace(/\b\p{L}/gu, (c) => c.toUpperCase());
      return { value: v, source: ci[0].trim() };
    }
  }
  return { ...NONE };
}

/* ── GSTIN + state ─────────────────────────────────────────────────────────── */

const GSTIN_RE = /(?<![A-Za-z0-9])([0-9]{2}[A-Za-z]{5}[0-9]{4}[A-Za-z][1-9A-Za-z][Zz][0-9A-Za-z])(?![A-Za-z0-9])/;

export function findGstin(text: string): Extracted<string> {
  const m = GSTIN_RE.exec(text);
  return m ? { value: m[1].toUpperCase(), source: m[0] } : { ...NONE };
}

/** Exactly one GST state named in the text → its code. None, or two different ones → null. */
export function stateFromText(text: string): Extracted<string> {
  const found = new Map<string, string>();
  for (const [code, name] of Object.entries(GST_STATE_BY_CODE)) {
    if (code === "97" || code === "99") continue;
    const pattern = escapeRe(name).replace(/\s+and\s+/gi, String.raw`\s*(?:and|&)\s*`).replace(/\s+/g, String.raw`\s+`);
    const m = new RegExp(String.raw`(?<![\p{L}])${pattern}(?![\p{L}])`, "iu").exec(text);
    if (m) found.set(code, m[0]);
  }
  /* "Delhi" sits inside nothing else, but a longer name can contain a shorter one — keep the
     state whose match is not part of a longer state's match. */
  const entries = [...found.entries()].filter(([, src]) =>
    ![...found.values()].some((other) => other !== src && other.toLowerCase().includes(src.toLowerCase())),
  );
  if (entries.length !== 1) return { ...NONE };
  return { value: entries[0][0], source: entries[0][1] };
}

/* ── The whole thing ───────────────────────────────────────────────────────── */

export function extractLeadPaste(text: string, catalogue: readonly CatalogueEntry[] = []): LeadPasteEntities {
  /* The extractor exactly as inbound auto-quote calls it on a body — untouched. */
  const base = extractEntities({ fromName: null, fromEmail: null, subject: "", body: text, catalogue });

  const seats = base.seats.value != null ? base.seats : seatsBeforeProduct(text, catalogue);

  const company = findCompany(text);
  const gstin = findGstin(text);
  const gstinValid = gstin.value ? isValidGstin(gstin.value) : false;

  /* Company and e-mail text are blanked before looking for a state name, so "Kerala Traders
     Pvt Ltd" or "sales@delhi.example" do not decide a tax head. */
  let rest = text;
  if (company.source) rest = rest.replace(company.source, " ");
  rest = rest.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ");
  const fromGstin = stateCodeFromGstin(gstin.value);
  const stateCode: Extracted<string> = fromGstin
    ? { value: fromGstin, source: `GSTIN ${gstin.value}` }
    : stateFromText(rest);

  const cycle = findBillingCycle(text);
  const billing: Extracted<LeadBillingCycle> = cycle.value
    ? { value: "monthly", source: cycle.source }
    : base.term.value === "annual"
      ? { value: "yearly", source: base.term.source }
      : base.term.value === "monthly"
        ? { value: "monthly", source: base.term.source }
        : { ...NONE };

  return { ...base, seats, company, gstin, gstinValid, stateCode, billing };
}

/** State code → "Delhi (07)" for the preview. */
export function stateCodeLabel(code: string | null): string | null {
  if (!code) return null;
  const name = GST_STATE_BY_CODE[code];
  return name ? `${name} (${code})` : null;
}
