/**
 * R-1921 (26 Oct 2026, goal G-RECON — R-1906 audit F4): a vendor's dated running statement and
 * the payables ageing.
 *
 * The database gives the rows (vendor_statement / payables_ageing, migration
 * 20261026171338_r1921_vendor_statement_payables_ageing.sql): every bill, the TDS withheld, every
 * payment, every advance, every set-off of an advance against a bill. Their amounts ADD UP to the
 * popup's net (open bills − advance left, vendor-account.ts vendorBalance) and to the Balance
 * Sheet — supabase/tests/r1921_vendor_statement.test.sql proves it. This file only orders them and
 * carries the running balance; it never computes what is due on its own.
 */

/** One row from vendor_statement(). amount: + we owe the vendor more, − it came off. */
export interface VendorStatementRow {
  entry_date: string;
  seq: number;
  kind: "bill" | "tds" | "set_off" | "payment" | "advance" | "advance_closed" | "adjustment" | string;
  doc_id: string | null;
  doc_ref: string | null;
  particulars: string;
  amount: number;
  set_off: number;
  bank_txn_id: string | null;
  bank_account_id: string | null;
}

export interface VendorStatementLine {
  key: string;
  date: string;
  kind: VendorStatementRow["kind"];
  particulars: string;
  /** What the row added to what we owe (a bill). 0 when none. */
  billed: number;
  /** What came off (payment, TDS, advance). 0 when none. */
  paid: number;
  /** An advance set off against a bill — shown, moves no money. */
  setOff: number;
  /** Running balance after this row: > 0 we owe, < 0 the vendor holds our money. */
  balance: number;
  /** Where the row's money is (the bank line), when there is one. */
  href: string | null;
}

export interface VendorStatement {
  lines: VendorStatementLine[];
  billed: number;
  paid: number;
  closing: number;
  /** Rows the database could not explain by an entry (see the 'adjustment' kind). */
  adjustments: number;
}

const n = (v: unknown) => Math.round(Number(v) || 0);

/** Oldest first (date, then bill → TDS → set-off → payment → advance), with the running balance. */
export function foldStatement(rows: readonly VendorStatementRow[]): VendorStatement {
  const sorted = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.entry_date.localeCompare(b.r.entry_date) || n(a.r.seq) - n(b.r.seq) || a.i - b.i)
    .map((x) => x.r);
  let balance = 0, billed = 0, paid = 0, adjustments = 0;
  const lines = sorted.map((r, i): VendorStatementLine => {
    const amt = n(r.amount);
    balance += amt;
    if (amt > 0) billed += amt; else paid += -amt;
    if (r.kind === "adjustment") adjustments += 1;
    return {
      key: `${i}:${r.kind}:${r.doc_id ?? ""}:${r.bank_txn_id ?? ""}`,
      date: r.entry_date,
      kind: r.kind,
      particulars: r.particulars,
      billed: Math.max(0, amt),
      paid: Math.max(0, -amt),
      setOff: r.kind === "set_off" ? n(r.set_off) : 0,
      balance,
      href: r.bank_txn_id && r.bank_account_id
        ? `/accounting/banking/${encodeURIComponent(r.bank_account_id)}?focus=${encodeURIComponent(r.bank_txn_id)}`
        : null,
    };
  });
  return { lines, billed, paid, closing: balance, adjustments };
}

/** The closing balance in words — same words as the popup's balance (vendor-account.ts balanceWords). */
export function closingWords(closing: number): string {
  if (closing > 0) return "You owe";
  if (closing < 0) return "Advance with vendor";
  return "All settled";
}

/* ─── Payables ageing ──────────────────────────────────────────────────────────────── */

/** One row from payables_ageing(). */
export interface PayablesAgeingRow {
  vendor_id: string | null;
  vendor_name: string;
  not_due: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
  advance: number;
  net: number;
  oldest_days: number;
  bills: number;
}

export const PAYABLE_BUCKETS = ["not_due", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
export type PayableBucket = (typeof PAYABLE_BUCKETS)[number];
export const PAYABLE_BUCKET_LABEL: Record<PayableBucket, string> = {
  not_due: "Not due yet",
  d1_30: "1–30 days",
  d31_60: "31–60 days",
  d61_90: "61–90 days",
  d90_plus: "90+ days",
};

export type PayablesTotals = Record<PayableBucket | "total" | "advance" | "net", number>;

export function payablesTotals(rows: readonly PayablesAgeingRow[]): PayablesTotals {
  const t: PayablesTotals = { not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0, advance: 0, net: 0 };
  for (const r of rows) {
    for (const k of [...PAYABLE_BUCKETS, "total", "advance", "net"] as const) t[k] += n(r[k]);
  }
  return t;
}

/** Numbers from the database arrive as strings (bigint) — make them numbers once. */
export function toAgeingRow(r: Record<string, unknown>): PayablesAgeingRow {
  return {
    vendor_id: (r.vendor_id as string | null) ?? null,
    vendor_name: String(r.vendor_name ?? "Vendor"),
    not_due: n(r.not_due), d1_30: n(r.d1_30), d31_60: n(r.d31_60), d61_90: n(r.d61_90), d90_plus: n(r.d90_plus),
    total: n(r.total), advance: n(r.advance), net: n(r.net), oldest_days: n(r.oldest_days), bills: n(r.bills),
  };
}

export function toStatementRow(r: Record<string, unknown>): VendorStatementRow {
  return {
    entry_date: String(r.entry_date ?? ""),
    seq: n(r.seq),
    kind: String(r.kind ?? ""),
    doc_id: (r.doc_id as string | null) ?? null,
    doc_ref: (r.doc_ref as string | null) ?? null,
    particulars: String(r.particulars ?? ""),
    amount: n(r.amount),
    set_off: n(r.set_off),
    bank_txn_id: (r.bank_txn_id as string | null) ?? null,
    bank_account_id: (r.bank_account_id as string | null) ?? null,
  };
}
