/**
 * R-2524 — a synthetic bank account the size of staging's HDFC ··4523 (5,170 lines on 6 Nov 2026),
 * rounded up to 6,000 lines, for the bank page / reconcile speed benchmark
 * (bank-page-perf-6000.test.ts). Deterministic (seeded), so before/after numbers compare.
 *
 * Shape follows the real account: ~30 % of lines still unmatched, HDFC-style narrations
 * (UPI / NEFT / IMPS / ACH / POS), ~300 customers, ~400 open invoices, ~150 vendors, 24 imports.
 * Test-only data — never written to any database.
 */
import type { BankTransactionRow } from "@/lib/queries/bank";
import type { BankImportRow } from "@/lib/banking/import-history";
import type { CustomerLite } from "@/lib/banking/credit-pay-for";
import type { VendorLite } from "@/lib/banking/debit-pay-for";
import type { OpenInvoice } from "@/lib/banking/invoice-credit-match";
import { utcDateISO } from "@/lib/dates/ist";

/** Small seeded PRNG (mulberry32) — the same 6,000 lines on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Distinct-ish names like a real book: a made-up first word (30 × 30 syllables) + a common word. */
/* 30 two-letter syllables, one string (made-up name parts, not words). */
const SYL = "karivonatelumosidaperazobinetakumerosavigahojilapuveyodefigo".match(/../g) as string[];
const WORDS = ["Sharma", "Gupta", "Kiran", "Lotus", "Indus", "Royal", "Metro", "Sunrise", "Silver", "Galaxy"];
const KINDS = ["Technologies", "Traders", "Solutions", "Enterprises", "Infotech", "Systems", "Media", "Foods"];

const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

export interface PerfFixture {
  accountId: string;
  txns: BankTransactionRow[];
  customers: CustomerLite[];
  vendors: VendorLite[];
  invoices: OpenInvoice[];
  imports: BankImportRow[];
}

export function bankPerfFixture(lines = 6000, seed = 4523): PerfFixture {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const name = () => `${pick(SYL)}${pick(SYL)}${pick(SYL)} ${pick(WORDS)} ${pick(KINDS)}`.replace(/^./, (c) => c.toUpperCase());
  const accountId = uuid("a2524000", 1);

  const customers: CustomerLite[] = Array.from({ length: 300 }, (_, i) => ({ id: uuid("c2524000", i + 1), name: name() }));
  const vendors: VendorLite[] = Array.from({ length: 150 }, (_, i) => ({
    id: uuid("d2524000", i + 1), name: name(), upi_id: i % 3 === 0 ? `vendor${i}@okhdfc` : null,
  }));
  const invoices: OpenInvoice[] = Array.from({ length: 400 }, (_, i) => {
    const c = pick(customers);
    const amt = Math.round(1000 + r() * 200000);
    return {
      id: `INV-${String(i + 1).padStart(4, "0")}`, quoteId: `Q-${String(i + 1).padStart(4, "0")}`, customerName: c.name,
      invoiceDate: dayIso(Math.floor(r() * 560)), amountDue: amt, taxableValue: Math.round(amt / 1.18),
    };
  });

  const imports: BankImportRow[] = Array.from({ length: 24 }, (_, i) => ({
    kind: "batch", batch_id: uuid("b2524000", i + 1), legacy_from: null, legacy_to: null,
    file_name: `HDFC-${i + 1}.xls`, source: "csv_upload", line_count: 0, imported_at: `2026-${String((i % 12) + 1).padStart(2, "0")}-02T10:00:00Z`,
    imported_by: null, txn_from: null, txn_to: null, first_balance: null, last_balance: null,
  } as unknown as BankImportRow));

  const txns: BankTransactionRow[] = [];
  for (let i = 0; i < lines; i++) {
    const credit = r() < 0.45;
    const amt = Math.round(50 + r() * (r() < 0.1 ? 400000 : 30000));
    const who = credit ? pick(customers).name : pick(vendors).name;
    const mode = pick(["UPI", "NEFT CR", "IMPS", "ACH D", "POS", "NEFT DR"]);
    const unmatched = r() < 0.3;
    const day = Math.floor((i / lines) * 580);
    txns.push({
      id: uuid("e2524000", i + 1), tenant_id: uuid("f2524000", 1), bank_account_id: accountId,
      txn_date: dayIso(day), description: `${mode}-${String(100000 + i)}-${who.toUpperCase()}-${pick(["HDFC0001234", "SBIN0004321", "ICIC0000777"])}`,
      debit: credit ? 0 : amt, credit: credit ? amt : 0, balance_after: null,
      reference: r() < 0.5 ? `${mode.slice(0, 4)}${String(400000000 + i)}` : null,
      source: "csv_upload",
      matched_to_type: unmatched ? null : credit ? "payment" : pick(["expense", "vendor_payment", "salary", "manual"] as const),
      matched_to_id: unmatched ? null : `m-${i}`, matched_at: null, matched_by: null, match_confidence: null,
      category: null, imported_at: "2026-11-01T00:00:00Z", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
      import_batch_id: imports[Math.floor((i / lines) * imports.length)].batch_id,
      reconcile_note: null, reversal_of: null,
    });
  }
  return { accountId, txns: txns.reverse(), customers, vendors, invoices, imports };
}

/** 1 Apr 2025 + n days, YYYY-MM-DD (FY 2025-26 into FY 2026-27, as on staging). */
function dayIso(n: number): string {
  return utcDateISO(new Date(Date.UTC(2025, 3, 1) + n * 86_400_000));
}
