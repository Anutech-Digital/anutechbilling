/**
 * The khata — a running Debit/Credit statement for one customer or one vendor.
 *
 * ─── THE TWO LEDGERS ARE MIRROR IMAGES, AND THAT IS THE WHOLE BUG SURFACE ───
 * A customer is a DEBTOR: they hold our money, so what they owe is a Debit balance.
 * A vendor is a CREDITOR: we hold theirs, so what we owe is a Credit balance.
 *
 *   CUSTOMER (receivable)              VENDOR (payable)
 *   invoice issued      → Dr           bill received       → Cr
 *   payment received    → Cr           payment made        → Dr
 *   credit note         → Cr           vendor credit note  → Dr
 *   debit note          → Dr           —
 *   refund to customer  → Dr
 *   Dr closing = they owe us           Cr closing = we owe them
 *   Cr closing = we hold an advance    Dr closing = we paid ahead
 *
 * Every entry is therefore stored SIGNED against one convention — positive means "the
 * party owes us more" — and `side()` maps that to the Dr or Cr column depending on which
 * ledger is being read. One sign convention internally, two presentations. The
 * alternative (a `debit` and a `credit` field per row, filled by the caller) is what
 * produces a vendor statement with a customer's signs, because nothing in the types
 * stops it.
 *
 * ─── WHY A DEBIT AND A CREDIT COLUMN AT ALL, IF ONE NUMBER WOULD DO ─────────
 * Because a CA reads this, and Tally prints it this way. A single signed column is
 * easier to compute and unreadable to the person who has to reconcile it against their
 * own books. The engine keeps one number; the table shows two.
 *
 * ─── OPENING BALANCE IS NOT ZERO, AND GETTING IT WRONG IS SILENT ────────────
 * A statement for "FY 2026-27" that starts at zero claims the party had no history
 * before 1 April — which is false for every party that existed last year, and the error
 * shows up as a closing balance that disagrees with the customer's own ledger by exactly
 * the amount they carried forward. So `buildLedger` takes ALL entries and the period, and
 * derives the opening balance from everything before the window. Callers must not
 * pre-filter by date.
 *
 * ─── WHOLE RUPEES ───────────────────────────────────────────────────────────
 * Every amount in and out is an integer rupee (AGENTS.md / CLAUDE.md §13). No division
 * happens here, so nothing can drift; `assertWholeRupees` exists so a caller feeding
 * paise fails loudly instead of producing a statement that is 100× wrong and looks
 * plausible.
 */

import { fyStartYear, fyLabelOfYear } from "@/lib/dates/ist";

export type LedgerKind = "customer" | "vendor";

/**
 * Tally's word for "what kind of document is this". Kept as the vocabulary a CA already
 * uses rather than our internal table names — `Sales` not `invoices`, `Receipt` not
 * `payments`, because this statement is read by somebody outside the app.
 */
export type VoucherType =
  | "Sales"          // invoice raised on a customer
  | "Receipt"        // money received from a customer
  | "Credit Note"    // reduces what the customer owes
  | "Debit Note"     // increases it
  | "Refund"         // money returned to the customer
  | "Purchase"       // bill received from a vendor
  | "Payment";       // money paid to a vendor

/**
 * One line, before it knows which column it belongs in.
 *
 * `effect` is signed against ONE convention for both ledgers: **positive means the
 * party's balance moves in the direction of "owing", negative means it moves back**.
 * For a customer, positive = they owe us more. For a vendor, positive = we owe them
 * more. `side()` turns that into Dr or Cr.
 */
export interface LedgerEntry {
  /** YYYY-MM-DD. The DOCUMENT date, not when it was typed in. */
  date: string;
  /** Document number — INV-…, RV-…, CN-…, a vendor's bill number. */
  reference: string;
  voucher: VoucherType;
  /** Free text shown under the reference: the plan, the reason for a credit note. */
  narration?: string | null;
  /** Whole rupees, always POSITIVE. The direction lives in `increasesLiability`. */
  amount: number;
  /**
   * True when this line increases what the party owes (customer) or what we owe them
   * (vendor). An invoice and a vendor bill are both `true`; a receipt and a vendor
   * payment are both `false`.
   */
  increasesLiability: boolean;
}

export interface LedgerRow extends LedgerEntry {
  /** ₹ in the Debit column, or 0. */
  debit: number;
  /** ₹ in the Credit column, or 0. */
  credit: number;
  /** Running balance AFTER this row, signed: positive = the party owes. */
  balance: number;
  /** "Dr" or "Cr" for the balance column. Null at exactly zero — see balanceSide(). */
  balanceSide: "Dr" | "Cr" | null;
}

export interface LedgerPeriod {
  /** YYYY-MM-DD inclusive. */
  from: string;
  /** YYYY-MM-DD inclusive. */
  to: string;
  label: string;
}

export interface LedgerStatement {
  kind: LedgerKind;
  period: LedgerPeriod;
  /** Signed. Positive = the party already owed at the start of the window. */
  openingBalance: number;
  openingSide: "Dr" | "Cr" | null;
  rows: LedgerRow[];
  /** Sum of the Debit column within the window. */
  totalDebit: number;
  /** Sum of the Credit column within the window. */
  totalCredit: number;
  /** Signed closing balance. */
  closingBalance: number;
  closingSide: "Dr" | "Cr" | null;
  /** ₹ billed to the party in the window (Sales for a customer, Purchase for a vendor). */
  totalBilled: number;
  /** ₹ settled in the window (Receipt for a customer, Payment for a vendor). */
  totalSettled: number;
}

/**
 * Which column a liability-increasing entry lands in.
 *
 * The ONE place the mirror lives. A customer's invoice is a Debit; a vendor's bill is a
 * Credit. Everything else in this module is direction-agnostic, so there is exactly one
 * line to get wrong and one line to test.
 */
export function side(kind: LedgerKind, increasesLiability: boolean): "debit" | "credit" {
  const owingColumn = kind === "customer" ? "debit" : "credit";
  const settlingColumn = kind === "customer" ? "credit" : "debit";
  return increasesLiability ? owingColumn : settlingColumn;
}

/**
 * Dr / Cr label for a signed balance.
 *
 * Zero returns **null**, not "Dr". A settled account is not "₹0 Dr" — that reads as a
 * debt of nothing, which is a strange thing to print on a statement a customer receives.
 * The UI shows a dash.
 */
export function balanceSide(kind: LedgerKind, balance: number): "Dr" | "Cr" | null {
  if (balance === 0) return null;
  const owing = kind === "customer" ? "Dr" : "Cr";
  const opposite = kind === "customer" ? "Cr" : "Dr";
  return balance > 0 ? owing : opposite;
}

/** Signed effect on the running balance: positive = the party owes more. */
export function signedEffect(e: LedgerEntry): number {
  return e.increasesLiability ? e.amount : -e.amount;
}

/**
 * Fails loudly on a non-integer amount.
 *
 * Money in this schema is whole rupees. A caller that passes paise produces a statement
 * exactly 100× too large — which is not obviously wrong on screen, is wrong in an export
 * a CA imports into Tally, and would be found by a customer rather than by us.
 */
export function assertWholeRupees(entries: readonly LedgerEntry[]): void {
  for (const e of entries) {
    if (!Number.isInteger(e.amount)) {
      throw new Error(
        `Ledger entry ${e.reference} has a non-integer amount (${e.amount}). ` +
        `Money is stored in whole rupees — this looks like paise, which would make the statement 100× too large.`,
      );
    }
    if (e.amount < 0) {
      throw new Error(
        `Ledger entry ${e.reference} has a negative amount (${e.amount}). ` +
        `Direction belongs in increasesLiability, not in the sign — a negative debit is a credit nobody can audit.`,
      );
    }
  }
}

/**
 * Chronological order, with a deterministic tie-break.
 *
 * Two documents on the same date must not swap places between renders, because the
 * running balance column would change and a customer comparing two printouts of the same
 * statement would find them different. Within a date: liability-increasing first (you are
 * billed before you pay), then by reference so the order is stable.
 */
function compareEntries(a: LedgerEntry, b: LedgerEntry): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.increasesLiability !== b.increasesLiability) return a.increasesLiability ? -1 : 1;
  return a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0;
}

/**
 * Build the statement.
 *
 * Pass EVERY entry for the party, not just the ones inside the window — the opening
 * balance is derived from what came before, and pre-filtering silently zeroes it.
 */
export function buildLedger(
  kind: LedgerKind,
  allEntries: readonly LedgerEntry[],
  period: LedgerPeriod,
): LedgerStatement {
  assertWholeRupees(allEntries);

  const before = allEntries.filter((e) => e.date < period.from);
  const within = allEntries.filter((e) => e.date >= period.from && e.date <= period.to);

  const openingBalance = before.reduce((b, e) => b + signedEffect(e), 0);
  return buildLedgerFromWindow(kind, openingBalance, within, period);
}

/**
 * Wahi statement, jab opening balance pehle se jud kar aaye.
 *
 * S17 (28 Sep 2026): `report_party_ledger` RPC window se pehle ka signed jod SQL me
 * karta hai aur sirf window ki entries bhejta hai — poori history browser me laane ki
 * zaroorat nahi. `buildLedger` bhi isi se banta hai, isliye dono raaston ka
 * sort / running balance / Dr-Cr ek hi code hai.
 *
 * `windowEntries` me sirf period ke andar ki entries honi chahiye; bahar ki aayi to
 * loudly fail — warna closing balance chup-chaap galat hota.
 */
export function buildLedgerFromWindow(
  kind: LedgerKind,
  openingBalance: number,
  windowEntries: readonly LedgerEntry[],
  period: LedgerPeriod,
): LedgerStatement {
  assertWholeRupees(windowEntries);
  if (!Number.isInteger(openingBalance)) {
    throw new Error(
      `Opening balance ${openingBalance} is not a whole number of rupees — money is stored in whole rupees, so this looks like paise.`,
    );
  }
  const stray = windowEntries.find((e) => e.date < period.from || e.date > period.to);
  if (stray) {
    throw new Error(
      `Ledger entry ${stray.reference} (${stray.date}) is outside ${period.from} – ${period.to}. ` +
      `Only the window's entries belong here; earlier ones go into the opening balance.`,
    );
  }

  const within = [...windowEntries].sort(compareEntries);

  let balance = openingBalance;
  let totalDebit = 0, totalCredit = 0, totalBilled = 0, totalSettled = 0;

  const rows: LedgerRow[] = within.map((e) => {
    const col = side(kind, e.increasesLiability);
    const debit = col === "debit" ? e.amount : 0;
    const credit = col === "credit" ? e.amount : 0;
    totalDebit += debit;
    totalCredit += credit;
    if (e.increasesLiability) totalBilled += e.amount; else totalSettled += e.amount;

    balance += signedEffect(e);
    return { ...e, debit, credit, balance, balanceSide: balanceSide(kind, balance) };
  });

  return {
    kind, period,
    openingBalance, openingSide: balanceSide(kind, openingBalance),
    rows, totalDebit, totalCredit,
    closingBalance: balance, closingSide: balanceSide(kind, balance),
    totalBilled, totalSettled,
  };
}

/* ─── PERIODS ─────────────────────────────────────────────────────────────── */

/** Indian financial year containing this date: 1 Apr → 31 Mar. */
export function fyOf(isoDate: string): number {
  return fyStartYear(isoDate);
}

/** "FY 2026-27" — the ledger's screen label; the "2026-27" part is lib/dates/ist.ts fyLabelOfYear. */
export function fyLabel(startYear: number): string {
  return `FY ${fyLabelOfYear(startYear)}`;
}

export function fyPeriod(startYear: number): LedgerPeriod {
  return {
    from: `${startYear}-04-01`,
    to: `${startYear + 1}-03-31`,
    label: fyLabel(startYear),
  };
}

/**
 * Indian fiscal quarters, NOT calendar quarters.
 *
 * Q1 is Apr–Jun. A statement headed "Q1" that showed Jan–Mar would disagree with every
 * other Indian financial document the reader has, and the mistake is invisible unless
 * somebody checks the dates.
 */
export function quarterPeriod(fyStartYear: number, q: 1 | 2 | 3 | 4): LedgerPeriod {
  const startMonth = 4 + (q - 1) * 3;               // 4, 7, 10, 13
  const startYear = startMonth > 12 ? fyStartYear + 1 : fyStartYear;
  const sm = ((startMonth - 1) % 12) + 1;
  const endMonthAbs = startMonth + 2;
  const endYear = endMonthAbs > 12 ? fyStartYear + 1 : fyStartYear;
  const em = ((endMonthAbs - 1) % 12) + 1;
  return {
    from: `${startYear}-${String(sm).padStart(2, "0")}-01`,
    to: `${endYear}-${String(em).padStart(2, "0")}-${lastDay(endYear, em)}`,
    label: `Q${q} ${fyLabel(fyStartYear)}`,
  };
}

const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

export function monthPeriod(year: number, month: number): LedgerPeriod {
  const mm = String(month).padStart(2, "0");
  return {
    from: `${year}-${mm}-01`,
    to: `${year}-${mm}-${lastDay(year, month)}`,
    label: `${MONTH_NAMES[month]} ${year}`,
  };
}

export function customPeriod(from: string, to: string): LedgerPeriod {
  return { from, to, label: `${from} to ${to}` };
}

/** Days in a month, leap-year aware — Feb 29 must not fall outside its own month. */
function lastDay(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return String(d).padStart(2, "0");
}
