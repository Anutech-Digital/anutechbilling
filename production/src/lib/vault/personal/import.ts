/**
 * R-2126 (GP-11) — personal bank-statement import, the pure part: parsed bank line → a
 * personal money line (kind + category + dedupe hash), and the balance check.
 *
 * No DB, no UI, no company books. It reuses the company importer's PURE modules only:
 *   - statement-parse.ts / statement-xlsx.ts read the file (the caller does that; this module
 *     takes their ParsedRow), so a bank file is read one way everywhere;
 *   - categorise.ts suggestForLine — rules first, then a keyword function, with the
 *     payment-rail guard — wired here with the person's OWN rules and a personal keyword
 *     function (never the business suggestCategory / EXPENSE_CATEGORIES);
 *   - statement-check.ts checkStatement for the running-balance chain.
 *
 * ─── KIND, NOT SIGN ─────────────────────────────────────────────────────────
 * Amounts stay positive whole rupees (as in personal_transactions); `kind` says which way
 * and why. Money that only moves between the person's own pockets — a credit-card bill paid
 * from savings, an ATM withdrawal into cash, a transfer to their other account — is a
 * transfer, never spend or income: counting it would show a ₹12,000 card bill as ₹12,000 of
 * spending on top of the ₹12,000 already spent on the card.
 */
import { suggestForLine, type CategoryRule } from "@/lib/banking/categorise";
import type { ParsedRow } from "@/lib/banking/statement-parse";
import { checkStatement, type StatementCheck } from "@/lib/banking/statement-check";

import type { PersonalIncomeCategory, PersonalSpendCategory } from "./categories";

export type PersonalDirection = "debit" | "credit";
export type PersonalDebitKind = "expense" | "transfer_out" | "card_payment";
export type PersonalCreditKind = "income" | "refund" | "transfer_in";
export type PersonalImportKind = PersonalDebitKind | PersonalCreditKind;

/** A person's own "always put X under Y" rule (personal_category_rules, GP-12) — same shape as the company rule. */
export type PersonalRule = CategoryRule;

export interface PersonalImportOptions {
  /** The person's own rules. Injected: this module never reads them. */
  rules: readonly PersonalRule[];
  /** Names the person's own accounts are held in — a transfer to/from these is a self transfer. */
  ownNames?: readonly string[];
  /** Last digits (4+) of the person's other accounts, as banks print them masked: XXXXXXX9876. */
  ownAccountTails?: readonly string[];
}

export interface PersonalImportLine {
  txn_date: string;
  description: string;
  reference: string | null;
  balance_after: number | null;
  /** Positive whole rupees. */
  amount: number;
  direction: PersonalDirection;
  kind: PersonalImportKind;
  /** null = nobody knows yet (show "Uncategorised", never blank). Transfers and card payments are always null. */
  category: string | null;
  categoryLayer: "rule" | "keyword" | "detected" | null;
  /** Why: `rule: SWIGGY`, `keyword match`, `card payment`, `self transfer`, `ATM cash`, `refund`. */
  reason: string | null;
  dedupeHash: string;
}

// ─── keyword layer ───────────────────────────────────────────────────────────

/** A word that must stand alone (OLA must not match COLA or KOLAR). */
const w = (word: string) => new RegExp(`(?<![A-Z0-9])${word}(?![A-Z])`);
/** A brand long and odd enough to match anywhere, even glued: BILLDKZOMATO. */
const s = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

/*
 * Order matters: first hit wins, most specific first (SWIGGY INSTAMART is groceries before
 * SWIGGY is food; JIOMART is groceries before JIO is a phone bill — the word guard on JIO
 * also keeps it apart). Every category named here is in categories.ts (a test checks it).
 */
const SPEND_KEYWORDS: ReadonlyArray<readonly [PersonalSpendCategory, readonly RegExp[]]> = [
  ["Groceries", [s("INSTAMART"), s("BIGBASKET"), s("BLINKIT"), s("GROFERS"), s("ZEPTO"), s("DMART"), s("AVENUE SUPERMARTS"), s("JIOMART"), s("KIRANA"), w("GROCER(Y|IES)?"), s("SUPERMARKET")]],
  ["Food / Dining", [s("SWIGGY"), s("ZOMATO"), s("DOMINOS"), s("MCDONALD"), w("KFC"), s("STARBUCKS"), s("PIZZA HUT"), s("EATSURE"), s("RESTAURANT"), w("CAFE")]],
  ["Insurance Premium", [s("LIC OF INDIA"), w("LIC"), s("INSURANCE"), s("HDFC LIFE"), s("ICICI PRU"), s("STAR HEALTH"), s("POLICYBAZAAR")]],
  ["Utilities", [s("ELECTRICITY"), s("BESCOM"), w("BSES"), s("TATA POWER"), s("ADANI ELEC"), s("MSEDCL"), s("TPDDL"), s("WATER BILL"), s("GAS BILL"), s("INDANE"), s("BHARAT GAS"), w("HP GAS"), s("AIRTEL"), w("JIO"), s("VODAFONE"), w("BSNL"), s("BROADBAND"), s("RECHARGE"), w("DTH"), s("TATA PLAY"), s("FIBERNET")]],
  ["Rent / EMI", [w("RENT"), w("EMI"), s("HOME LOAN"), s("HOUSING LOAN"), s("LOAN REPAY")]],
  ["Education / Fees", [s("SCHOOL"), s("COLLEGE"), s("UNIVERSITY"), s("TUITION"), w("FEES?"), s("BYJU"), s("UNACADEMY")]],
  ["Medical", [s("HOSPITAL"), s("PHARMACY"), s("PHARMEASY"), s("APOLLO"), s("MEDPLUS"), s("NETMEDS"), w("1MG"), s("CLINIC"), s("DIAGNOSTIC"), s("CHEMIST"), w("MEDICAL")]],
  ["Travel", [s("IRCTC"), s("MAKEMYTRIP"), s("GOIBIBO"), s("CLEARTRIP"), s("INDIGO"), s("AIR INDIA"), s("VISTARA"), s("SPICEJET"), s("REDBUS"), w("UBER"), w("OLA"), s("RAPIDO"), w("YATRA"), w("HOTEL"), w("OYO"), s("AIRBNB")]],
  ["Vehicle / Fuel", [w("FUEL"), s("PETROL"), s("DIESEL"), s("INDIAN OIL"), w("IOCL"), w("BPCL"), w("HPCL"), s("BHARAT PETROLEUM"), s("HINDUSTAN PETROLEUM"), s("FASTAG"), s("PARKING")]],
  ["Investment", [s("ZERODHA"), w("GROWW"), s("UPSTOX"), s("KUVERA"), s("MUTUAL FUND"), w("SIP"), w("NPS"), w("PPF"), s("INDIAN CLEARING"), w("ICCL"), w("CAMS"), s("KFINTECH")]],
  ["Tax", [s("INCOME TAX"), s("ADVANCE TAX"), s("PROPERTY TAX"), w("TDS"), w("CBDT"), s("TIN NSDL")]],
  ["Shopping", [s("AMAZON"), s("FLIPKART"), s("MYNTRA"), w("AJIO"), s("MEESHO"), s("NYKAA"), s("TATA CLIQ"), s("CROMA"), s("RELIANCE DIGITAL"), s("DECATHLON")]],
  ["Household", [s("URBAN COMPANY"), s("URBANCLAP"), w("MAID"), s("SOCIETY MAINT"), s("IKEA"), s("PEPPERFRY")]],
  ["Festival / Gifts", [w("GIFTS?"), s("FERNS N PETALS"), w("FNP")]],
];

const INCOME_KEYWORDS: ReadonlyArray<readonly [PersonalIncomeCategory, readonly RegExp[]]> = [
  ["Cashback", [s("CASHBACK"), s("CASH BACK")]],
  ["Refund", [s("REFUND"), s("REVERSAL"), w("REV"), s("CHARGEBACK")]],
  ["Salary", [s("SALARY"), w("SAL"), s("PAYROLL")]],
  ["Interest", [s("INTEREST"), /(?<![A-Z])INT\.?\s*(PD|CR|CREDIT|PAID)(?![A-Z])/]],
  ["Dividend", [s("DIVIDEND"), w("DIV")]],
  ["Rent Received", [w("RENT")]],
];

function firstHit<C extends string>(table: ReadonlyArray<readonly [C, readonly RegExp[]]>, text: string): C | null {
  const t = text.toUpperCase();
  for (const [category, patterns] of table) if (patterns.some((p) => p.test(t))) return category;
  return null;
}

/**
 * The personal keyword function for one side of the statement — the `keywordFn` that
 * categorise.ts takes. Split by direction on purpose: SALARY on a debit is not income and
 * SWIGGY on a credit is not spending, and categorise.ts's keyword layer is direction-blind.
 */
export function personalKeywordFn(direction: PersonalDirection): (text: string) => string | null {
  return direction === "debit"
    ? (text) => firstHit(SPEND_KEYWORDS, text)
    : (text) => firstHit(INCOME_KEYWORDS, text);
}

// ─── detection ───────────────────────────────────────────────────────────────

const CARD_PAYMENT = [
  /(?<![A-Z])CC\s*(PAYMENT|PMT|PAY|BILL)/,
  /CREDIT\s*CARD\s*(PAYMENT|PMT|PAY|BILL)/,
  /(?<![A-Z])CARD\s*(PAYMENT|PMT)(?![A-Z])/,
  /(?<![A-Z])CRED(\s*CLUB|\.CLUB)?(?![A-Z])/,
];
const MASKED_CARD = /\d{4,6}X{4,}\d{4}/;

/** A credit-card BILL paid from this account (not a purchase made with a card). */
export function detectCardPayment(description: string): boolean {
  const t = description.toUpperCase();
  if (CARD_PAYMENT.some((p) => p.test(t))) return true;
  return /BILLPAY/.test(t) && MASKED_CARD.test(t);
}

const ATM_CASH = /(?<![A-Z])(ATM\s*WDL|ATM\s*CASH|ATW|NWD|CASH\s*WDL|CASH\s*WITHDRAWAL)(?![A-Z])/;
const SELF_WORDS = /(?<![A-Z])(SELF|OWN\s*(A\/C|AC|ACCOUNT)|TO\s+OWN|SWEEP)(?![A-Z])/;

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The person's own name or own masked account number in the narration. */
function namesMe(t: string, opts: Pick<PersonalImportOptions, "ownNames" | "ownAccountTails">): boolean {
  for (const name of opts.ownNames ?? []) {
    const words = name.toUpperCase().replace(/[^A-Z ]+/g, " ").split(/\s+/).filter(Boolean);
    if (words.join("").length < 3) continue;   // too short to mean anything
    if (new RegExp(`(?<![A-Z])${words.map(escapeRe).join("[\\s.*_-]+")}(?![A-Z])`).test(t)) return true;
  }
  for (const tail of opts.ownAccountTails ?? []) {
    const d = tail.replace(/\D/g, "");
    if (d.length >= 4 && new RegExp(`X+${d}(?!\\d)`).test(t)) return true;
  }
  return false;
}

/** Money moving between the person's own accounts: SELF / OWN A/C / sweep words, or their own name / account tail. */
export function detectSelfTransfer(
  description: string,
  opts: Pick<PersonalImportOptions, "ownNames" | "ownAccountTails">,
): boolean {
  const t = description.toUpperCase();
  return SELF_WORDS.test(t) || namesMe(t, opts);
}

// ─── dedupe ──────────────────────────────────────────────────────────────────

const norm = (x: string | null | undefined) => (x ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "");

/** cyrb53 — a small, fast, well-spread string hash; two seeds give 106 bits. Not for secrets. */
function cyrb53(str: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/**
 * The identity of a bank line, stable across re-imports of the same statement (CSV or
 * Excel, any spacing/case): date + side + amount + narration + reference, each normalised.
 * The running balance is left out — it describes the account, not the line.
 * `occurrence` separates genuinely identical lines in one file (two ₹20 teas, same day,
 * no reference): the 2nd gets #1, and a re-import counts them the same way.
 */
export function dedupeHash(row: Pick<ParsedRow, "txn_date" | "description" | "debit" | "credit" | "reference"> & { balance_after?: number | null }, occurrence = 0): string {
  const side = row.debit > 0 ? `D${row.debit}` : `C${row.credit}`;
  const key = [row.txn_date, side, norm(row.description), norm(row.reference)].join("|") + (occurrence > 0 ? `#${occurrence}` : "");
  return `p1-${cyrb53(key, 1)}${cyrb53(key, 2)}`;
}

// ─── mapping ─────────────────────────────────────────────────────────────────

/** One parsed bank line → one personal line. Throws on a line that is neither (or both) debit and credit. */
export function mapParsedRow(row: ParsedRow, opts: PersonalImportOptions, occurrence = 0): PersonalImportLine {
  const debit = row.debit > 0;
  const credit = row.credit > 0;
  if (debit === credit) throw new RangeError(`R-2126: a bank line must be a debit or a credit (${row.txn_date} ${row.description})`);

  const direction: PersonalDirection = debit ? "debit" : "credit";
  const t = row.description.toUpperCase();
  const base = {
    txn_date: row.txn_date,
    description: row.description,
    reference: row.reference,
    balance_after: row.balance_after,
    amount: debit ? row.debit : row.credit,
    direction,
    dedupeHash: dedupeHash(row, occurrence),
  };
  const moved = (kind: PersonalImportKind, reason: string): PersonalImportLine =>
    ({ ...base, kind, category: null, categoryLayer: "detected", reason });

  const suggestion = suggestForLine(row, opts.rules, personalKeywordFn(direction));
  const categorised = (kind: PersonalImportKind): PersonalImportLine => ({
    ...base,
    kind,
    category: suggestion?.category ?? null,
    categoryLayer: suggestion ? (suggestion.layer === "tenant-rule" ? "rule" : "keyword") : null,
    reason: suggestion?.reason ?? null,
  });

  if (debit) {
    if (detectCardPayment(t)) return moved("card_payment", "card payment");
    if (ATM_CASH.test(t)) return moved("transfer_out", "ATM cash");
    if (detectSelfTransfer(t, opts)) return moved("transfer_out", "self transfer");
    return categorised("expense");
  }

  if (SELF_WORDS.test(t)) return moved("transfer_in", "self transfer");
  const income = personalKeywordFn("credit")(t);
  if (income === "Refund" || income === "Cashback") {
    const ruled = suggestion?.layer === "tenant-rule";
    return {
      ...base,
      kind: "refund",
      category: ruled ? suggestion!.category : income,
      categoryLayer: ruled ? "rule" : "detected",
      reason: ruled ? suggestion!.reason : "refund",
    };
  }
  /* Salary / interest / dividend wording beats a name match: a salary credit often prints
     the employee's own name as the beneficiary, and that is not a self transfer. */
  if (!income && namesMe(t, opts)) return moved("transfer_in", "self transfer");
  return categorised("income");
}

/** A whole statement, in file order; identical lines are numbered so each keeps its own stable hash. */
export function mapStatement(rows: readonly ParsedRow[], opts: PersonalImportOptions): PersonalImportLine[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const first = dedupeHash(row);
    const n = seen.get(first) ?? 0;
    seen.set(first, n + 1);
    return mapParsedRow(row, opts, n);
  });
}

// ─── balance check ───────────────────────────────────────────────────────────

/**
 * Does the statement's own running balance agree with its lines? Reuses the company check
 * (gaps between dates, wrong opening, paise rounding). With no opening balance given, the
 * statement's implied opening is used, so a first import still catches missing lines.
 * null = the file has no running-balance column — nothing to check, say nothing.
 */
export function verifyAgainstStatement(
  rows: ReadonlyArray<Pick<ParsedRow, "txn_date" | "debit" | "credit" | "balance_after">>,
  openingBalance?: number,
): StatementCheck | null {
  const lines = rows.map((r) => ({ txn_date: r.txn_date, debit: r.debit, credit: r.credit, balance_after: r.balance_after }));
  if (openingBalance !== undefined) return checkStatement(lines, openingBalance);
  const probe = checkStatement(lines, 0);
  return probe ? checkStatement(lines, probe.impliedOpening) : null;
}
