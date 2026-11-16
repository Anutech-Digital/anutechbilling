/**
 * R-2685 — a big bank account for performance checks: ~5,230 lines like staging Excel HDFC 4523
 * (UPI / NEFT / IMPS / salary / card narrations, ~60% money out, ~45% reconciled), with the
 * customers, vendors, open invoices and imports the bank page reads next to them.
 *
 * Deterministic (seeded) so before/after timings compare like with like. Used by the perf tests
 * (bank-page-perf-r2685.test.ts, zoho-bulk-perf-r2685.test.ts) — in memory only, never a database.
 */
import type { BankTransactionRow } from "@/lib/queries/bank";
import type { BankImportRow } from "@/lib/banking/import-history";
import type { OpenInvoice } from "@/lib/banking/invoice-credit-match";
import { utcDateISO } from "@/lib/dates/ist";

/** mulberry32 — a small seeded random, the same numbers every run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["SHARMA", "GUPTA", "TRADERS", "INFOTECH", "SOLUTIONS", "ENTERPRISES", "AGARWAL", "VERMA", "KUMAR", "SINGH",
  "DIGITAL", "SYSTEMS", "CONSULTANTS", "MEDIA", "PRINTERS", "LOGISTICS", "PHARMA", "FOODS", "TEXTILES", "MOTORS"];

export interface BigAccount {
  accountId: string;
  lines: BankTransactionRow[];
  customers: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  invoices: OpenInvoice[];
  imports: BankImportRow[];
}

export function bigBankAccount(n = 5230, seed = 4523): BigAccount {
  const r = seeded(seed);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const name = () => `${pick(WORDS)} ${pick(WORDS)}`;
  const accountId = "acct-4523";
  const customers = Array.from({ length: 800 }, (_, i) => ({ id: `cust-${i}`, name: `${name()} PVT LTD` }));
  const vendors = Array.from({ length: 300 }, (_, i) => ({ id: `vend-${i}`, name: `${name()} ${i}` }));
  const imports: BankImportRow[] = Array.from({ length: 12 }, (_, i) => ({
    kind: "batch", batch_id: `batch-${i}`, legacy_from: null, legacy_to: null,
    file_name: `HDFC-4523-${i + 1}.xlsx`, source: "xlsx", line_count: 0,
    imported_at: `2026-0${(i % 9) + 1}-15T10:00:00Z`, imported_by: null,
    txn_from: null, txn_to: null, first_balance: null, last_balance: null, reconciled_count: 0,
    removed_at: null, removed_by: null, remove_reason: null, removed_lines: null,
  }));
  let bal = 2_500_000;
  const start = Date.parse("2025-04-01T00:00:00Z");
  const lines: BankTransactionRow[] = [];
  for (let i = 0; i < n; i++) {
    const day = utcDateISO(new Date(start + Math.floor((i / n) * 590) * 86_400_000));
    const out = r() < 0.6;
    const amt = Math.round(100 + r() * (r() < 0.1 ? 400_000 : 40_000));
    bal += out ? -amt : amt;
    const kind = r();
    const who = out ? pick(vendors).name : pick(customers).name.replace(" PVT LTD", "");
    const description = kind < 0.35 ? `UPI-${who}-${Math.floor(r() * 1e10)}@okhdfcbank-HDFC0000${i % 97}-${Math.floor(r() * 1e12)}-PAYMENT`
      : kind < 0.6 ? `NEFT CR-ICIC0000${i % 50}-${who}-INV ${Math.floor(r() * 9000)}`
      : kind < 0.7 && out ? `SALARY ${pick(["JAN", "FEB", "MAR", "APR"])} ${pick(WORDS)} ${pick(WORDS)}`
      : kind < 0.85 ? `IMPS-${Math.floor(r() * 1e12)}-${who}-XXXXXXX${i % 1000}`
      : `POS ${Math.floor(r() * 1e6)}XXXXXX${i % 9999} ${pick(WORDS)} STORE`;
    const matched = r() < 0.45;
    lines.push({
      id: `txn-${String(i).padStart(5, "0")}`, tenant_id: "t-1", bank_account_id: accountId,
      txn_date: day, description,
      debit: out ? amt : 0, credit: out ? 0 : amt, balance_after: bal,
      reference: r() < 0.5 ? `REF${Math.floor(r() * 1e9)}` : null,
      source: "csv_upload",
      matched_to_type: matched ? (out ? pick(["expense", "vendor_bill", "salary", "manual"] as const) : pick(["payment", "manual"] as const)) : null,
      matched_to_id: matched ? `m-${i}` : null, matched_at: null, matched_by: null, match_confidence: null,
      imported_at: `${day}T12:00:00Z`, created_at: `${day}T12:00:00Z`, updated_at: `${day}T12:00:00Z`,
      import_batch_id: `batch-${Math.min(11, Math.floor((i / n) * 12))}`,
    });
  }
  const invoices: OpenInvoice[] = Array.from({ length: 400 }, (_, i) => ({
    id: `INV-${i}`, quoteId: `Q-${i}`, customerName: pick(customers).name,
    invoiceDate: utcDateISO(new Date(start + Math.floor(r() * 560) * 86_400_000)),
    amountDue: Math.round(500 + r() * 60_000), taxableValue: null,
  }));
  return { accountId, lines, customers, vendors, invoices, imports };
}
