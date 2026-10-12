/**
 * What an irreversible action is about to do, in the operator's words.
 *
 * ─── WHY THIS IS SHARED ─────────────────────────────────────────────────────
 * Three acts in this app cannot be taken back: issuing a tax invoice, sending a quote
 * to a customer, and recording a payment. Each has its own reasons, but two things are
 * identical across all three and were about to be written three times:
 *
 *   - the document-number format, `{PREFIX}-{DOC_CODE}-{YYYY}-{YY}-{NNNN}`, matching
 *     live rows like `INV-TEST-2026-27-0008`;
 *   - the series-gap check, which turns out to matter everywhere. Measured 23 Aug 2026,
 *     ANUTECH holds **zero** invoices with its invoice series at 32, **zero** payments
 *     with its receipt-voucher series at 39, and a quote series at 41. Every counter has
 *     holes, so every one of these dialogs should say so.
 *
 * A fourth act — suspending or cancelling a subscription — is NOT here, because it does
 * not exist as an operator action. The nearest thing, deleting a subscription, already
 * confirms properly (`subscriptions/page.tsx`: what it does, what it is for, and the
 * alternative when it is blocked). Naming a tap that has no button would have been
 * inventing work.
 */

export type ConsequenceTone = "fact" | "warning";

export interface Consequence {
  tone: ConsequenceTone;
  text: string;
}

/** A tenant's counter for one document type, in one financial year. */
export interface SeriesState {
  /** e.g. "INV", "RV", "Q" */
  prefix: string;
  /** The tenant's document code, e.g. "ADPL". Null when never set. */
  docCode: string | null;
  /** e.g. "FY2627" */
  fiscalYear: string;
  /** The last number ISSUED. The next is this + 1. */
  lastNumber: number;
  /** How many documents of this type the books actually hold. */
  documentCount: number;
}

/**
 * `{PREFIX}-{DOC_CODE}-{YYYY}-{YY}-{NNNN}`, matching live data.
 *
 * The doc code is omitted when the tenant has none rather than rendered as "null" —
 * Demo Co' row is in exactly that state, and a literal "INV-null-…" on a tax
 * document is worse than a missing segment.
 */
/**
 * Predicts the next document number — and must produce the SAME string that
 * `public.format_document_number` does, because it is shown to the operator as what they
 * are about to spend. Two copies of one format is the drift this codebase keeps paying
 * for; `document-number-format.test.ts` asserts they agree on a worked example.
 *
 * R-015 (29 Sep 2026) shortened it from 21 characters to 16. CGST Rule 46(b) allows 16
 * and this app was issuing `INV-ADPL-2026-27-0002`. The financial year is now carried by
 * its END year only — FY2627 → "27" — which is unambiguous and monotonic.
 *
 * The tenant code stays, deliberately: `invoices.id` is a bare global primary key, so
 * without it the second tenant to issue its first invoice of a year collides with the
 * first tenant's. Capped at 4, as the SQL caps it.
 */
/**
 * The tenant code next_document_number() actually prints — including its FALLBACK.
 *
 * R-095 (1 Oct 2026): with tenants.doc_code empty, the SQL takes the first 4 hex of the
 * tenant id, upper-cased (ANUTECH fbb976f1-… → "FBB9"). The dialog passed the raw NULL
 * through, so it predicted "INV-27-0008" for an invoice that came out "INV-FBB9-27-0008"
 * — the owner confirmed an irreversible GST number that was not the one issued.
 * Mirrors next_document_number: trim, empty → id fallback, cap at 4.
 */
export function effectiveDocCode(docCode: string | null | undefined, tenantId: string): string {
  const own = (docCode ?? "").trim();
  const code = own || tenantId.replace(/-/g, "").slice(0, 4).toUpperCase();
  return code.slice(0, 4);
}

export function formatDocumentNumber(s: SeriesState, n: number): string {
  const fy = /^FY(\d{2})(\d{2})$/.exec(s.fiscalYear);
  const year = fy ? fy[2] : s.fiscalYear;
  const code = s.docCode?.trim().slice(0, 4) || null;
  return [s.prefix, code, year, String(n).padStart(4, "0")]
    .filter(Boolean)
    .join("-");
}

/**
 * The gap between numbers consumed and documents held, when there is one.
 *
 * Not a rule being broken — a fact the operator is better off seeing before adding to
 * it. A GST series is expected to run sequentially, and a counter sitting well ahead of
 * the books is the first thing an auditor asks about. Returns null when they agree,
 * because a warning that fires on the healthy case is a warning nobody reads.
 *
 * @param noun  what the documents are called here — "invoice", "receipt voucher"
 */
export function seriesGap(s: SeriesState | null, noun: string): Consequence | null {
  if (!s || s.lastNumber <= 0) return null;
  const gap = s.lastNumber - s.documentCount;
  if (gap <= 0) return null;

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  if (s.documentCount === 0) {
    return {
      tone: "warning",
      text: `This series has already used ${plural(s.lastNumber, "number")} but the books hold no ${noun}s — those were issued and later deleted. Numbers 1-${s.lastNumber} stay permanently unaccounted for, and an auditor will ask.`,
    };
  }
  return {
    tone: "warning",
    text: `${plural(gap, "number")} in this series have no ${noun} against them — issued and later deleted. They cannot be reissued.`,
  };
}

/** True when at least one consequence makes the action impossible rather than risky. */
export function isBlocked(list: readonly Consequence[]): boolean {
  return list.some((c) => c.tone === "warning" && /cannot be|nothing can be|no amount/i.test(c.text));
}
