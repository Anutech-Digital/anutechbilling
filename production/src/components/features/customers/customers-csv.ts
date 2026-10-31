/**
 * Customer import CSV — the reader behind ImportCustomersDialog.
 *
 * Recognises a simple ResellerOS header AND common Zoho Books / Billing export headers
 * (Customer Number / Company Name / Display Name / First Name / Last Name / Email /
 * Mobile Phone / GST Identification Number (GSTIN) / Billing State / Place Of Supply /
 * GST Treatment / PAN / Payment Terms / Country).
 *
 * R-1738 (22 Oct 2026): PAN, GST treatment, payment terms (days) and place of supply are
 * read too, with the SAME rules as the customer form (R-1736):
 *   • PAN must be 5 letters, 4 digits, 1 letter; a valid GSTIN supplies it (and a typed PAN
 *     that differs from the GSTIN's is refused — the TDS / 26AS match depends on it).
 *   • GST treatment accepts our values, the Zoho Books labels and Zoho's export codes; a
 *     treatment the facts contradict (Regular with no GSTIN, Overseas in India) is refused
 *     with gstTreatmentProblem — the form's own rule. Blank → suggestGstTreatment.
 *   • Place of supply ("DL", "07", "Delhi") decides the state; it must agree with the GSTIN.
 *   • A blank contact person → the company is the contact (as in the form).
 */
import { GST_STATE_BY_CODE, gstStateFromGstin } from "@/lib/utils";
import { isExportSupply } from "@/lib/gst/place-of-supply";
import { normalizeCountry } from "@/lib/gst/countries";
import { parsePlaceOfSupply } from "@/lib/import/zoho-opening-invoices";
import {
  CUSTOMER_GST_TREATMENTS, GST_TREATMENT_OPTIONS, gstTreatmentProblem, suggestGstTreatment,
  isValidPan, panFromGstin, type CustomerGstTreatment,
} from "@/lib/gst/customer-gst-treatment";

export const CSV_HEADER =
  "customer_number,first_name,last_name,company_name,email,mobile_phone,gstin,place_of_supply,gst_treatment,pan,payment_terms_days";

export const SAMPLE_CSV = [
  CSV_HEADER,
  `CUS-00001,Test,Customer,Test Customer 1,customer1@example.test,+919800000001,03AAAAA0000A1Z5,Punjab,registered_regular,,30`,
  `CUS-00002,,,Test Customer 2,customer2@example.test,9800000002,,Delhi,unregistered_business,ABCDE1234F,0`,
].join("\n");

/** The treatment values a file may use, for the help text. */
export const TREATMENT_VALUES_HELP = CUSTOMER_GST_TREATMENTS.join(", ");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// state name (lowercased) → GST state code, derived from the canonical map.
const STATE_NAME_TO_CODE: Record<string, string> = Object.entries(GST_STATE_BY_CODE)
  .reduce((acc, [code, name]) => { acc[name.toLowerCase()] = code; return acc; }, {} as Record<string, string>);

/** Zoho exports write "-No Value-" for empty cells — treat as blank. */
function nv(v: string | undefined): string {
  const t = (v ?? "").trim();
  if (!t || t.toLowerCase() === "-no value-") return "";
  return t;
}

const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");

/* Our values, the Zoho Books labels ("Registered Business – Regular") and Zoho's export
   codes. Zoho's "business_sez" does not say with/without payment — it maps to SEZ (with
   payment), which charges IGST: the safe reading until the LUT rule is set (R-1736). */
const TREATMENT_BY_WORD: Record<string, CustomerGstTreatment> = (() => {
  const m: Record<string, CustomerGstTreatment> = {};
  for (const v of CUSTOMER_GST_TREATMENTS) m[squash(v)] = v;
  for (const o of GST_TREATMENT_OPTIONS) m[squash(o.label)] = o.value;
  Object.assign(m, {
    businessgst: "registered_regular",
    businessregisteredregular: "registered_regular",
    businessregisteredcomposition: "registered_composition",
    businessnone: "unregistered_business",
    businessunregistered: "unregistered_business",
    businesssez: "sez_with_payment",
    overseas: "overseas",
    consumer: "consumer",
    deemedexport: "deemed_export",
  } satisfies Record<string, CustomerGstTreatment>);
  return m;
})();

/** A file's GST treatment cell → our value; "" → null; unknown → "invalid". */
export function parseGstTreatmentCell(v: string | null | undefined): CustomerGstTreatment | null | "invalid" {
  const t = (v ?? "").trim();
  if (!t) return null;
  return TREATMENT_BY_WORD[squash(t)] ?? "invalid";
}

/** "30", "Net 30", "30 days", "Due on receipt" → days; "" → null; anything else → "invalid". */
export function parsePaymentTermsCell(v: string | null | undefined): number | null | "invalid" {
  const t = (v ?? "").trim().toLowerCase();
  if (!t) return null;
  if (t === "due on receipt" || t === "immediate") return 0;
  const m = /^(?:net\s*)?(\d{1,3})(?:\s*days?)?$/.exec(t);
  if (!m) return "invalid";
  const n = Number(m[1]);
  return n <= 365 ? n : "invalid";
}

export interface ParsedRow {
  rowNum: number;
  customer_number?: string;
  name: string;
  contact_name?: string;
  company?: string;
  contact_email?: string;
  contact_phone?: string;
  gstin?: string;
  state?: string;
  state_code?: string;
  country?: string;
  gst_treatment?: CustomerGstTreatment;
  pan?: string;
  payment_terms_days?: number;
  error?: string;
  dup?: boolean;
}

export function parseCustomersCsv(text: string, existingNums: Set<string>, existingEmails: Set<string>): ParsedRow[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error("CSV needs a header row + at least one data row.");

  const header = parseLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const col = (aliases: string[]): number => {
    for (const a of aliases) { const i = header.indexOf(a); if (i >= 0) return i; }
    return -1;
  };

  const idxNum     = col(["customer_number", "customer number", "customer no", "customer id"]);
  const idxCompany = col(["company name", "company_name", "company"]);
  const idxDisplay = col(["display name", "display_name", "customer name", "customer_name", "name"]);
  const idxFirst   = col(["first_name", "first name", "firstname"]);
  const idxLast    = col(["last_name", "last name", "lastname"]);
  const idxContact = col(["contact_name", "contact name", "primary contact", "contact person"]);
  const idxEmail   = col(["contact_email", "email", "emailid", "email id", "email address"]);
  const idxMobile  = col(["mobile_phone", "mobile phone", "mobilephone", "mobile"]);
  const idxPhone   = col(["contact_phone", "phone"]);
  const idxGstin   = col(["gstin", "gst_no", "gst no", "gst identification number (gstin)", "gst identification number", "gst"]);
  const idxState   = col(["billing_state", "billing state", "state", "shipping state"]);
  const idxPos     = col(["place_of_supply", "place of supply", "place of supply (state)", "pos"]);
  const idxCountry = col(["country", "billing_country", "billing country"]);
  const idxTreat   = col(["gst_treatment", "gst treatment", "treatment"]);
  const idxPan     = col(["pan", "pan_no", "pan no", "pan number", "permanent account number"]);
  const idxTerms   = col(["payment_terms_days", "payment terms (days)", "payment terms days", "payment_terms", "payment terms", "terms"]);

  if (idxFirst === -1 && idxCompany === -1 && idxDisplay === -1 && idxContact === -1) {
    throw new Error("Couldn't find a name column (First Name / Company Name / Display Name).");
  }

  const seenNum = new Set<string>();
  const seenEmail = new Set<string>();
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const rowNum = i + 1;
    const cell = (idx: number) => (idx >= 0 ? nv(cols[idx]) : "");

    const first = cell(idxFirst);
    const last  = cell(idxLast);
    const company = cell(idxCompany);
    const display = cell(idxDisplay);
    const contact = cell(idxContact);

    // Customer name = Company (B2B standard); Primary Contact = person (First+Last).
    const person = [first, last].filter(Boolean).join(" ").trim();
    const name = company || person || display || contact;
    if (!name) {
      rows.push({ rowNum, name: "", error: "Missing name" });
      continue;
    }
    /* R-1738: no person → the company is the contact (same as the Add company form). */
    const contact_name = person || contact || display || name;
    const fail = (error: string) => rows.push({ rowNum, name, error });

    const customer_number = cell(idxNum) || undefined;
    const email = cell(idxEmail);
    /* R-2180: "USA" / "EE" / "estonia" → the picker's name, so the saved value matches the form. */
    const country = normalizeCountry(cell(idxCountry)) || "India";
    const foreign = isExportSupply(country);
    const gstin = foreign ? "" : cell(idxGstin).toUpperCase();

    // State: the GSTIN's state first, then Place of supply, then the billing state.
    const fromGstin = gstin ? gstStateFromGstin(gstin) : { code: null, name: null };
    const posRaw = cell(idxPos);
    const posCode = posRaw && !foreign ? parsePlaceOfSupply(posRaw) : null;
    if (posRaw && !foreign && !posCode) {
      fail(`Place of supply "${posRaw}" is not a GST state`);
      continue;
    }
    if (posCode && fromGstin.code && posCode !== fromGstin.code) {
      fail(`Place of supply ${GST_STATE_BY_CODE[posCode]} does not match the GSTIN's state (${fromGstin.name ?? fromGstin.code})`);
      continue;
    }
    const stateRaw = cell(idxState);
    let stateName: string;
    let stateCode: string | undefined;
    if (foreign) {
      stateName = posRaw || stateRaw;
      stateCode = undefined;
    } else if (fromGstin.code || posCode) {
      stateCode = (fromGstin.code ?? posCode)!;
      stateName = GST_STATE_BY_CODE[stateCode] ?? stateRaw;
    } else {
      // A 2-letter code like "PB"/"DL" isn't a state name — read it as a Zoho code.
      const abbr = stateRaw.length === 2 ? parsePlaceOfSupply(stateRaw) : null;
      stateCode = abbr ?? (stateRaw ? STATE_NAME_TO_CODE[stateRaw.toLowerCase()] : undefined) ?? undefined;
      stateName = stateCode && abbr ? GST_STATE_BY_CODE[stateCode] : stateRaw;
    }

    // GST treatment — the form's rule (R-1736): blank → suggested; contradicting facts → refused.
    const treatCell = parseGstTreatmentCell(cell(idxTreat));
    if (treatCell === "invalid") {
      fail(`GST treatment "${cell(idxTreat)}" is not recognised — use one of: ${TREATMENT_VALUES_HELP}`);
      continue;
    }
    const gst_treatment = treatCell ?? suggestGstTreatment({ country, gstin, customerType: "business" });
    const treatProblem = gstTreatmentProblem({ treatment: gst_treatment, country, gstin });
    if (treatProblem) {
      fail(treatProblem);
      continue;
    }

    // PAN — from a valid GSTIN, else typed; a typed one must be well-formed and agree.
    const panTyped = foreign ? "" : cell(idxPan).toUpperCase();
    if (panTyped && !isValidPan(panTyped)) {
      fail(`PAN "${panTyped}" is not valid — a PAN is 5 letters, 4 digits, 1 letter (e.g. AAACR5055K)`);
      continue;
    }
    const panGstin = foreign ? null : panFromGstin(gstin);
    if (panTyped && panGstin && panTyped !== panGstin) {
      fail(`PAN ${panTyped} does not match the GSTIN (its PAN is ${panGstin})`);
      continue;
    }
    const pan = panGstin ?? (panTyped || undefined);

    const terms = parsePaymentTermsCell(cell(idxTerms));
    if (terms === "invalid") {
      fail(`Payment terms "${cell(idxTerms)}" — give the number of days (0 to 365), e.g. 30`);
      continue;
    }

    // Dedup: customer_number first (stable), else email.
    let dup = false;
    const numKey = customer_number?.toLowerCase();
    const emailKey = email.toLowerCase();
    if (numKey) {
      if (existingNums.has(numKey) || seenNum.has(numKey)) dup = true;
      seenNum.add(numKey);
    } else if (emailKey) {
      if (existingEmails.has(emailKey) || seenEmail.has(emailKey)) dup = true;
      seenEmail.add(emailKey);
    }

    rows.push({
      rowNum,
      customer_number,
      name,
      contact_name,
      company: company || undefined,
      contact_email: email && EMAIL_RE.test(email) ? email : (email || undefined),
      contact_phone: (cell(idxMobile) || cell(idxPhone)) || undefined,
      gstin: gstin || undefined,
      state: stateName || undefined,
      state_code: stateCode,
      country,
      gst_treatment,
      pan,
      payment_terms_days: terms ?? undefined,
      dup,
    });
  }
  return rows;
}

export function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
