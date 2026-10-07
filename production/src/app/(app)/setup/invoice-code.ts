/**
 * R-259 — the owner's invoice code (tenants.doc_code), shared by the setup wizard,
 * Settings → Company and /api/tenant/invoice-code.
 *
 * Why this exists: no screen ever wrote tenants.doc_code, so next_document_number()
 * fell back to the first 4 hex of the tenant id and customers got "INV-3F9A-27-0001".
 *
 * Rules (each one has a reason):
 *   - 2–4 letters, saved upper-case. 4 is the SQL cap (R-015, 16-char GST limit); the SQL
 *     does not upper-case, so we must. Letters only, so a chosen code can never look like
 *     a stray number in "INV-SHRM-27-0001".
 *   - Unique across tenants: invoices.id is a GLOBAL primary key, so two tenants on
 *     "SHRM" would collide on their first invoice of a year. The check also covers other
 *     tenants' hex fallback ("FACE" can be one).
 *   - Locked once a GST document number has been issued with the current code. Changing
 *     it later would not renumber anything, but the series would switch shape mid-year.
 */
import { effectiveDocCode } from "@/lib/actions/consequence";

export const INVOICE_CODE_RE = /^[A-Z]{2,4}$/;

/** GST documents whose numbers carry the code; one issued number locks the code. */
export const GST_DOC_TYPES = ["invoice", "receipt_voucher", "credit_note", "debit_note", "refund_voucher"] as const;

/** What the owner typed → what would be saved: trimmed, upper-case, spaces dropped. */
export function normalizeInvoiceCode(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, "").toUpperCase();
}

/** Null when valid, else a short message for under the field. */
export function invoiceCodeProblem(raw: string | null | undefined): string | null {
  const code = normalizeInvoiceCode(raw);
  if (!code) return "Enter 2–4 letters.";
  if (!/^[A-Z]+$/.test(code)) return "Letters only (A–Z).";
  if (code.length < 2) return "At least 2 letters.";
  if (code.length > 4) return "At most 4 letters.";
  return null;
}

/**
 * A starting suggestion from the company name: initials of the first words, else the
 * first letters. "Sharma Cloud Solutions Pvt Ltd" → "SCS". Legal suffixes are skipped.
 * Only a suggestion — the server still checks it is free.
 */
export function suggestInvoiceCode(companyName: string | null | undefined): string {
  const skip = new Set(["PVT", "PRIVATE", "LTD", "LIMITED", "LLP", "INC", "CO", "AND", "THE", "OF", "OPC"]);
  const words = (companyName ?? "")
    .toUpperCase()
    .replace(/[^A-Z ]+/g, " ")
    .split(" ")
    .filter((w) => w && !skip.has(w));
  if (words.length === 0) return "";
  const initials = words.map((w) => w[0]).join("").slice(0, 4);
  if (initials.length >= 2) return initials;
  return words[0].slice(0, 4).length >= 2 ? words[0].slice(0, 4) : "";
}

/** Indian financial year that `now` falls in, IST, as its end year "27" for FY 2026-27. */
export function fyEndYear(now: Date): string {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear();
  const end = ist.getUTCMonth() >= 3 ? y + 1 : y; // April (3) starts the new FY
  return String(end % 100).padStart(2, "0");
}

/** "INV-SHRM-27-0001" — same shape as next_document_number() (R-015). */
export function previewInvoiceNumber(code: string, fyYY: string, nextNumber: number, prefix = "INV"): string {
  return [prefix, code.slice(0, 4), fyYY, String(Math.max(1, nextNumber)).padStart(4, "0")].join("-");
}

export interface OtherTenantCode {
  id: string;
  doc_code: string | null;
}

/** True when another tenant already prints `code` (its own code or its hex fallback). */
export function codeTakenByOther(code: string, myTenantId: string, others: ReadonlyArray<OtherTenantCode>): boolean {
  const want = normalizeInvoiceCode(code);
  return others.some(
    (t) => t.id !== myTenantId && normalizeInvoiceCode(effectiveDocCode(t.doc_code, t.id)) === want,
  );
}

export type SaveDecision =
  | { ok: true; code: string }
  | { ok: false; status: number; error: string };

/** The whole server-side decision, pure so it can be tested without a database. */
export function decideInvoiceCodeSave(input: {
  raw: string | null | undefined;
  currentCode: string;
  locked: boolean;
  takenByOther: boolean;
}): SaveDecision {
  const code = normalizeInvoiceCode(input.raw);
  const problem = invoiceCodeProblem(code);
  if (problem) return { ok: false, status: 400, error: problem };
  if (code === normalizeInvoiceCode(input.currentCode)) return { ok: true, code };
  if (input.locked) {
    return {
      ok: false,
      status: 409,
      error: `Locked — invoices already carry ${input.currentCode}. The code cannot change after the first GST number.`,
    };
  }
  if (input.takenByOther) {
    return { ok: false, status: 409, error: `${code} is already used by another business. Try a different code.` };
  }
  return { ok: true, code };
}
