/**
 * Bank accounts + transactions — TanStack Query hooks.
 *
 * Two entities:
 *   • bank_accounts    — operator's bank accounts (HDFC / ICICI / SBI etc.)
 *   • bank_transactions — individual ledger entries, either typed manually,
 *     imported from a CSV statement, or (future) auto-fetched via API.
 *
 * Reconciliation pattern: each bank_transaction can be linked to ONE source
 * entity in the rest of the system via (matched_to_type, matched_to_id).
 * Today supported types: 'payment' (customer paid us), 'expense' (we paid a
 * vendor), 'vendor_bill', 'transfer' (between our own accounts), 'manual'
 * (operator says it's reconciled, no internal match).
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { localDateISO } from "@/lib/leads/outcomes";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import type { OpenInvoice } from "@/lib/banking/invoice-credit-match";

// ─── Types ─────────────────────────────────────────────────────────────────

export type BankAccountRow = {
  id:                   string;
  tenant_id:            string;
  name:                 string;
  bank_name:            string;
  account_number_last4: string | null;
  ifsc:                 string | null;
  account_type:         "current" | "savings" | "overdraft" | "fixed_deposit" | "cash" | "other" | "credit_card";
  opening_balance:      number;
  opening_balance_date: string;
  is_active:            boolean;
  notes:                string | null;
  created_at:           string;
  updated_at:           string;
  // computed (joined via RPC on read)
  current_balance?:     number;
};

export type BankTransactionRow = {
  id:               string;
  tenant_id:        string;
  bank_account_id:  string;
  txn_date:         string;
  description:      string;
  debit:            number;
  credit:           number;
  balance_after:    number | null;
  reference:        string | null;
  source:           "manual" | "csv_upload" | "api_fetch";
  matched_to_type:  "payment" | "project" | "expense" | "vendor_bill" | "transfer" | "salary" | "split" | "manual" | "statutory" | "prepaid" | "referral_commission" | null;
  matched_to_id:    string | null;
  matched_at:       string | null;
  matched_by:       string | null;
  match_confidence: "exact" | "high" | "low" | "manual" | null;
  /** Category given at import (rule / keyword / operator) — a suggestion, not a booking. */
  category?:        string | null;
  imported_at:      string;
  created_at:       string;
  updated_at:       string;
};

export type BankAccountInsert = Omit<
  BankAccountRow,
  "id" | "tenant_id" | "created_at" | "updated_at" | "current_balance"
>;

export type BankAccountUpdate = Partial<Omit<BankAccountInsert, "is_active">>;

/** What deleting an account would touch — shown in the confirm dialog. */
export type BankAccountDependencies = {
  transactions: number;   // imported/manual bank lines (CASCADE-deleted)
  payments:     number;   // money records that lose their "paid via" link (SET NULL)
  salaries:     number;
  loans:        number;
  emi:          number;
  dues:         number;
};

export type BankTransactionInsert = Omit<
  BankTransactionRow,
  | "id"
  | "tenant_id"
  | "imported_at"
  | "created_at"
  | "updated_at"
  | "matched_to_type"
  | "matched_to_id"
  | "matched_at"
  | "matched_by"
  | "match_confidence"
>;

// ─── Bank accounts ─────────────────────────────────────────────────────────

export function useBankAccounts() {
  return useQuery({
    queryKey: ["bank_accounts"],
    queryFn: async (): Promise<BankAccountRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("bank_accounts")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      // Compute current_balance for each account via the RPC. We could lazy-
      // load this per-card but the count is small (a handful per tenant)
      // and the RPC is fast (single aggregation per account).
      const accounts = (data ?? []) as BankAccountRow[];
      const withBalances = await Promise.all(
        accounts.map(async (acc) => {
          const { data: bal } = await supabase.rpc("bank_account_current_balance", {
            p_account_id: acc.id,
          });
          return { ...acc, current_balance: (bal as number | null) ?? acc.opening_balance };
        }),
      );
      return withBalances;
    },
    staleTime: 60_000,
  });
}

export function useBankAccount(id: string | null | undefined) {
  return useQuery({
    queryKey: ["bank_accounts", id],
    enabled:  Boolean(id),
    queryFn: async (): Promise<BankAccountRow | null> => {
      if (!id) return null;
      const supabase = createClient();
      const { data, error } = await supabase
        .from("bank_accounts")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      const { data: bal } = await supabase.rpc("bank_account_current_balance", {
        p_account_id: id,
      });
      return { ...(data as BankAccountRow), current_balance: (bal as number | null) ?? data.opening_balance };
    },
  });
}

export function useCreateBankAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<BankAccountInsert, "is_active">) => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");
      const { data: me, error: meErr } = await supabase
        .from("users")
        .select("tenant_id")
        .eq("id", authData.user.id)
        .single();
      if (meErr) throw meErr;
      const { data, error } = await supabase
        .from("bank_accounts")
        .insert({ ...input, tenant_id: me!.tenant_id })
        .select()
        .single();
      if (error) throw error;
      return data as BankAccountRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      toast.success("Bank account added");
    },
    onError: (err) => {
      toastError(err, { fallback: "Could not add bank account" });
    },
  });
}

export function useUpdateBankAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: BankAccountUpdate }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("bank_accounts")
        .update(input.patch)
        .eq("id", input.id)
        .select()
        .single();
      if (error) throw error;
      return data as BankAccountRow;
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts", row.id] });
      toast.success("Account updated");
    },
    onError: (err) => {
      toastError(err, { fallback: "Could not update account" });
    },
  });
}

/**
 * Count what a delete would touch, so the confirm dialog can disclose it
 * honestly (N transactions permanently deleted, M money-record links cleared).
 */
export function useBankAccountDependencies(id: string | null | undefined) {
  return useQuery({
    queryKey: ["bank_accounts", id, "dependencies"],
    enabled:  Boolean(id),
    queryFn: async (): Promise<BankAccountDependencies> => {
      const supabase = createClient();
      const countFor = async (table: string, col: string) => {
        const { count, error } = await supabase
          .from(table as never)
          .select("id", { count: "exact", head: true })
          .eq(col, id as string);
        if (error) throw error;
        return count ?? 0;
      };
      const [transactions, payments, salaries, loans, repayments, emi, dues] = await Promise.all([
        countFor("bank_transactions",        "bank_account_id"),
        countFor("payments",                 "bank_account_id"),
        countFor("salary_payments",          "bank_account_id"),
        countFor("employee_loans",           "bank_account_id"),
        countFor("employee_loan_repayments", "bank_account_id"),
        countFor("emi_payments",             "bank_account_id"),
        countFor("statutory_dues_payments",  "bank_account_id"),
      ]);
      return { transactions, payments, salaries, loans: loans + repayments, emi, dues };
    },
  });
}

export function useDeleteBankAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_bank_account", { p_account_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      toast.success("Bank account deleted");
    },
    onError: (err) => {
      toastError(err, { fallback: "Could not delete account" });
    },
  });
}

// ─── Transfer between two own accounts (e.g. bank → petty cash) ─────────────
export function useRecordTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      fromAccountId: string;
      toAccountId:   string;
      amount:        number;
      txnDate:       string;   // YYYY-MM-DD
      note?:         string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("record_account_transfer", {
        p_from_account: input.fromAccountId,
        p_to_account:   input.toAccountId,
        p_amount:       input.amount,
        p_txn_date:     input.txnDate,
        p_note:         input.note ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      toast.success("Transfer recorded");
    },
    onError: (err) => toastError(err, { fallback: "Transfer failed" }),
  });
}

// ─── Bank transactions ─────────────────────────────────────────────────────

export function useBankTransactions(accountId: string | null | undefined) {
  return useQuery({
    queryKey: ["bank_transactions", accountId],
    enabled:  Boolean(accountId),
    queryFn: async (): Promise<BankTransactionRow[]> => {
      if (!accountId) return [];
      const supabase = createClient();
      const { data, error } = await supabase
        .from("bank_transactions")
        .select("*")
        .eq("bank_account_id", accountId)
        .order("txn_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as BankTransactionRow[];
    },
    staleTime: 30_000,
  });
}

/** An unmatched debit line + its account name — candidates to reconcile an expense to. */
export type UnmatchedDebit = {
  id: string;
  bank_account_id: string;
  account_name: string;
  txn_date: string;
  description: string | null;
  debit: number;
};

/**
 * All unreconciled money-OUT (debit) lines across the tenant's accounts — the
 * candidate list when reconciling a paid expense TO its bank line (expense-first
 * reconcile). RLS scopes to the tenant. Newest first; the dialog ranks by
 * amount/date closeness to the expense.
 */
export function useUnmatchedBankDebits() {
  return useQuery({
    queryKey: ["bank_transactions", "unmatched-debits"],
    queryFn: async (): Promise<UnmatchedDebit[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("bank_transactions")
        .select("id, bank_account_id, txn_date, description, debit, bank_accounts(name)")
        .is("matched_to_id", null)
        .gt("debit", 0)
        .order("txn_date", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []).map((r) => {
        const acc = (r as { bank_accounts?: { name?: string } | { name?: string }[] }).bank_accounts;
        const name = Array.isArray(acc) ? acc[0]?.name : acc?.name;
        return {
          id: r.id as string,
          bank_account_id: r.bank_account_id as string,
          account_name: name ?? "Account",
          txn_date: r.txn_date as string,
          description: (r.description ?? null) as string | null,
          debit: (r.debit ?? 0) as number,
        };
      });
    },
    staleTime: 15_000,
  });
}

/** An unmatched CREDIT line — money that arrived and nothing in the books explains. */
export type UnmatchedCredit = {
  id: string;
  bank_account_id: string;
  account_name: string;
  txn_date: string;
  description: string | null;
  credit: number;
  /** Whole days since it landed. Drives "sitting unexplained for over a week". */
  days_old: number;
};

/**
 * All unreconciled money-IN (credit) lines across the tenant's accounts.
 *
 * ─── THE MIRROR OF useUnmatchedBankDebits, AND THE MORE URGENT HALF ─────────
 * A debit nobody matched is an expense not yet filed — untidy. A CREDIT nobody matched
 * is money in the bank that the books cannot account for, which is a different problem:
 * the cash balance is correct and the ledger is wrong, so every report built on the
 * ledger understates revenue while the bank statement says otherwise.
 *
 * It is also the ordinary case for an Indian reseller, not an edge case. Customers pay
 * by UPI and NEFT straight into the account — increasingly because we now put a UPI link
 * in the reminder — so the deposit routinely arrives BEFORE anybody records a payment.
 *
 * RLS scopes to the tenant. Newest first, matching the debit hook.
 */
export function useUnmatchedBankCredits() {
  return useQuery({
    queryKey: ["bank_transactions", "unmatched-credits"],
    queryFn: async (): Promise<UnmatchedCredit[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("bank_transactions")
        .select("id, bank_account_id, txn_date, description, credit, bank_accounts(name)")
        .is("matched_to_id", null)
        .gt("credit", 0)
        .order("txn_date", { ascending: false })
        .limit(500);
      if (error) throw error;
      /* Age computed once, here, against IST midnight — the same boundary every other
         date rule in this codebase uses (localDateISO). Letting each caller subtract
         Date.now() would give a different answer either side of midnight. */
      const todayMs = Date.parse(`${localDateISO(new Date())}T00:00:00+05:30`);
      return (data ?? []).map((r) => {
        const acc = (r as { bank_accounts?: { name?: string } | { name?: string }[] }).bank_accounts;
        const name = Array.isArray(acc) ? acc[0]?.name : acc?.name;
        const txnDate = r.txn_date as string;
        const txnMs = Date.parse(`${txnDate.slice(0, 10)}T00:00:00+05:30`);
        return {
          id: r.id as string,
          bank_account_id: r.bank_account_id as string,
          account_name: name ?? "Account",
          txn_date: txnDate,
          description: (r.description ?? null) as string | null,
          credit: (r.credit ?? 0) as number,
          days_old: Math.max(0, Math.round((todayMs - txnMs) / 86_400_000)),
        };
      });
    },
    staleTime: 15_000,
  });
}

/**
 * Natural key for a bank line — used to skip a statement row that's already in
 * the books (re-uploaded statement / overlapping date range). A UTR/reference
 * is the most stable; else fall back to date + both amounts + description.
 */
export function bankTxnKey(r: { txn_date?: string | null; debit?: number | null; credit?: number | null; description?: string | null }): string {
  const d = (r.txn_date ?? "").slice(0, 10);
  // date + amount + description only. Reference is NOT used — a re-uploaded
  // statement often omits it while the stored row has one (or vice-versa),
  // which would make the same line look "new". Description is normalised by
  // REMOVING ALL whitespace + lowercasing so re-parsed spacing/masking variants
  // of the SAME line still match — e.g. "EXCEL TECHNO LOGIES" == "EXCEL
  // TECHNOLOGIES" and "ICIC-XX XXXXXX4658" == "ICIC-XXXXXX4658". (Collapsing to a
  // single space, as before, left those different and let duplicates slip in.)
  // A SHORT prefix (first 25 non-space chars) — this captures the stable leading
  // bank txn/UTR number (e.g. "50100784857219-TPT-SALARY", "IMPS-621856395591-")
  // while EXCLUDING the variable tail where re-parses differ: payee name
  // ("...-ABHI" vs "...-ABHISHEK") and masked account digits ("ICIC-XX XXXXXX4658"
  // vs "ICIC-XXXXXX4658"). A longer prefix (60) let those tails break the match
  // and duplicated the line on re-upload. Genuinely different lines still differ
  // in this prefix (different UTR / party), so they stay separate.
  const desc = (r.description ?? "").toLowerCase().replace(/\s+/g, "").slice(0, 25);
  return `${d}|${Math.round(r.debit ?? 0)}|${Math.round(r.credit ?? 0)}|${desc}`;
}

/**
 * Every identity a bank line has: the description key above, plus — when the statement
 * printed a running balance — date + amount + balance. The balance changes after every
 * line, so two different lines never share all three; the same line read twice (CSV once,
 * the AI from a PDF once) always does, however differently its narration came out.
 * A line is a duplicate when ANY of its keys is already known.
 */
export function bankTxnKeys(r: { txn_date?: string | null; debit?: number | null; credit?: number | null; description?: string | null; balance_after?: number | null }): string[] {
  const keys = [bankTxnKey(r)];
  if (r.balance_after != null) {
    keys.push(`bal|${(r.txn_date ?? "").slice(0, 10)}|${Math.round(r.debit ?? 0)}|${Math.round(r.credit ?? 0)}|${Math.round(r.balance_after)}`);
  }
  return keys;
}

/** Existing bank-line keys for an account — to flag/skip duplicate imports. */
export function useExistingTxnKeys(accountId: string | null) {
  return useQuery({
    queryKey: ["bank_transactions", accountId, "keys"],
    enabled: !!accountId,
    queryFn: async (): Promise<Set<string>> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("bank_transactions")
        .select("txn_date, debit, credit, description, reference, balance_after")
        .eq("bank_account_id", accountId as string)
        .limit(5000);
      if (error) throw error;
      return new Set((data ?? []).flatMap((r) => bankTxnKeys(r as never)));
    },
    staleTime: 15_000,
  });
}

/**
 * Bulk insert bank transactions from a parsed CSV/PDF upload.
 * Skips rows where both debit and credit are zero, AND skips DUPLICATES already
 * in the account (same date + amount + description/reference) — so re-uploading
 * a statement, or an overlapping date range, never double-counts. Auto-assigns
 * source='csv_upload' for the whole batch.
 */
export function useImportBankTransactions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      accountId: string;
      rows: Array<Omit<BankTransactionInsert, "bank_account_id" | "source">>;
    }) => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");
      const { data: me, error: meErr } = await supabase
        .from("users")
        .select("tenant_id")
        .eq("id", authData.user.id)
        .single();
      if (meErr) throw meErr;

      const cleaned = input.rows
        .map((r) => {
          // A bank line is debit XOR credit — coerce to non-negative integers so
          // a stray minus/decimal can't break the integer column or the
          // debit_xor_credit CHECK, then keep only clean single-sided rows.
          const debit  = Math.max(0, Math.round(r.debit  ?? 0));
          const credit = Math.max(0, Math.round(r.credit ?? 0));
          return { ...r, debit, credit };
        })
        .filter((r) => (r.debit > 0) !== (r.credit > 0));   // exactly one side positive

      // Skip lines already in this account (re-uploaded / overlapping statement).
      const { data: existing } = await supabase
        .from("bank_transactions")
        .select("txn_date, debit, credit, description, reference, balance_after")
        .eq("bank_account_id", input.accountId)
        .limit(5000);
      const seen = new Set((existing ?? []).flatMap((r) => bankTxnKeys(r as never)));
      const fresh: typeof cleaned = [];
      let duplicates = 0;
      for (const r of cleaned) {
        const keys = bankTxnKeys(r as never);
        if (keys.some((k) => seen.has(k))) { duplicates++; continue; }
        keys.forEach((k) => seen.add(k));   // also dedup within the same batch
        fresh.push(r);
      }

      const validRows = fresh.map((r) => ({
        ...r,
        tenant_id:       me!.tenant_id,
        bank_account_id: input.accountId,
        source:          "csv_upload" as const,
      }));

      if (validRows.length === 0) {
        if (duplicates > 0) return { inserted: 0, duplicates };   // all already imported
        throw new Error("No valid transactions to import (each row needs exactly one of debit or credit > 0)");
      }

      const { data, error } = await supabase
        .from("bank_transactions")
        .insert(validRows)
        .select("id");
      if (error) throw error;
      return { inserted: data?.length ?? 0, duplicates };
    },
    onSuccess: ({ inserted, duplicates }, vars) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions", vars.accountId] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });   // current_balance changed
      const dupMsg = duplicates > 0 ? ` · ${duplicates} duplicate skip` : "";
      if (inserted === 0 && duplicates > 0) toast.success(`Sab ${duplicates} lines pehle se hain — kuch naya nahi mila`);
      else toast.success(`${inserted} transaction${inserted === 1 ? "" : "s"} imported${dupMsg}`);
    },
    // toastError() already digs the message out of non-Error PostgREST objects,
    // so the hand-rolled unwrapping that used to live here is gone.
    onError: (err) => toastError(err, { fallback: "Import failed" }),
  });
}

/**
 * Reconcile a bank transaction against an internal record (payment / expense
 * / vendor_bill / transfer). Setting matched_to_type='manual' marks it as
 * "reconciled but no internal match" — useful for owner's-own transfers,
 * bank charges, etc.
 *
 * Pass matched_to_type=null to UN-reconcile.
 */
/**
 * One-step income booking from a money-IN bank line: a customer paid for a sale
 * that wasn't invoiced yet. Raises the GST invoice (+ its one-off quote) via
 * create_direct_invoice, records the payment against it, then reconciles THIS
 * bank credit to that payment. `taxableAmount` is the ex-GST line value — the
 * RPC adds GST per the customer's place of supply, so the invoice total may be
 * higher than the taxable figure.
 */
export function useBookCreditAsInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      transactionId: string;
      bankAccountId: string;
      customerId: string;
      lineName: string;
      /** Catalog product the line is for, when picked from the catalog. */
      itemId?: string | null;
      taxableAmount: number;   // ex-GST ₹
      reference?: string | null;
    }) => {
      const supabase = createClient();
      // 1. Invoice + one-off quote (atomic). A one-off quote never creates a
      //    subscription on payment (record_payment's is_one_off guard), so linking a
      //    catalog product here cannot start a recurring bill. Cost stays 0: the
      //    receipt tells us the price, not what the sale cost us.
      const line = {
        id: "line-1", name: input.lineName.trim() || "Sale", qty: 1, rate: Math.round(input.taxableAmount), cost: 0,
        ...(input.itemId ? { item_id: input.itemId } : {}),
      };
      const { data: invData, error: e1 } = await supabase.rpc("create_direct_invoice", {
        p_customer_id: input.customerId,
        p_line_items:  [line],
        p_notes:       "Raised from a bank receipt (reconcile)",
        p_recurring:   false,
      });
      if (e1) throw e1;
      const inv = (Array.isArray(invData) ? invData[0] : invData) as { invoice_id: string; quote_id: string; net_payable: number };

      // 2. Record the payment (full) against that quote. record_payment needs a
      //    non-empty reference for bank methods — use the line's UTR, else derive
      //    one from the bank-txn id (also makes the call idempotent per line).
      const ref = (input.reference ?? "").trim() || `BANK-${input.transactionId}`;
      const { data: payData, error: e2 } = await supabase.rpc("record_payment", {
        p_quote_id:  inv.quote_id,
        p_amount:    inv.net_payable,
        p_method:    "bank_transfer",
        p_reference: ref,
        p_notes:     "Reconciled from bank receipt",
      });
      if (e2) throw e2;
      const pay = (Array.isArray(payData) ? payData[0] : payData) as { payment_id?: string };
      if (!pay?.payment_id) throw new Error("Payment record nahi bana.");

      // 3. Tag the receiving account + reconcile THIS bank line to the payment.
      await supabase.from("payments").update({ bank_account_id: input.bankAccountId }).eq("id", pay.payment_id);
      const { data: { user } } = await supabase.auth.getUser();
      const { error: e3 } = await supabase.from("bank_transactions").update({
        matched_to_type:  "payment",
        matched_to_id:    pay.payment_id,
        matched_at:       new Date().toISOString(),
        matched_by:       user?.id ?? null,
        match_confidence: "manual",
      }).eq("id", input.transactionId);
      if (e3) throw e3;
      return inv;
    },
    onSuccess: (inv) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["aging"] });
      toast.success(`Invoice ${inv.invoice_id} bana & reconcile ho gaya`);
    },
    onError: (err) => toastError(err),
  });
}

/**
 * Overpaid-salary split: reconcile ONE money-out line as salary + a recoverable
 * employee advance in one atomic RPC (migration 0186). The salary portion (line
 * − advance) settles the chosen salary; the excess becomes a salary-advance with
 * NO new cash leg (this line is the cash-out). Recover it later via a salary
 * deduction in Loans & Advances.
 */
export function useReconcileSalaryAdvanceSplit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      transactionId: string;
      salaryId: string;
      advanceAmount: number;
      employeeName: string;
      notes?: string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("reconcile_salary_advance_split", {
        p_txn_id:         input.transactionId,
        p_salary_id:      input.salaryId,
        p_advance_amount: Math.round(input.advanceAmount),
        p_employee_name:  input.employeeName,
        p_notes:          input.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["salary-payments"] });
      qc.invalidateQueries({ queryKey: ["employee-loans"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success("Reconciled — salary paid + advance booked");
    },
    onError: (err) => toastError(err),
  });
}

/** Reconcile input shape — shared by the single-match hook and auto-reconcile. */
type ReconcileInput = {
  transactionId: string;
  matchedToType: "payment" | "project" | "expense" | "vendor_bill" | "transfer" | "salary" | "split" | "manual" | null;
  matchedToId:   string | null;
  confidence?:   "exact" | "high" | "low" | "manual";
};

/** Core reconcile write — one call to the `reconcile_bank_txn` RPC, which in a
 *  single transaction sets the match on the bank line AND keeps the reverse
 *  links (project_payments.bank_txn_id, expenses.reconciled_txn_id) + the
 *  statutory / balance-sheet reversals in sync. This is genuinely the single
 *  source of truth: both the manual dialog (useReconcileTransaction) and the
 *  batch auto-reconcile below call THIS, so they can never drift apart — and
 *  because it is one transaction, a failure part-way can no longer leave a
 *  matched line with an unset reverse link (the old chained-writes hazard,
 *  CLAUDE.md §17b). matched_by is auth.uid() set server-side; salary paid_amount
 *  is handled by a DB trigger on the update, so no extra client work is needed. */
async function applyReconcile(
  supabase: ReturnType<typeof createClient>,
  input: ReconcileInput,
): Promise<BankTransactionRow> {
  const { data, error } = await supabase.rpc("reconcile_bank_txn", {
    p_txn_id:           input.transactionId,
    p_matched_to_type:  input.matchedToType,
    p_matched_to_id:    input.matchedToId,
    p_match_confidence: input.confidence ?? "manual",
  });
  if (error) throw error;
  return data as BankTransactionRow;
}

/**
 * Auto-reconcile — for every UNMATCHED line in the account, ask the server for
 * match suggestions and auto-apply ONLY an UNAMBIGUOUS 'exact' one (a single
 * exact candidate — if two records share the amount, it's left for manual review
 * so we never guess wrong on money). Reuses applyReconcile, so the links + salary
 * trigger fire exactly as in the manual flow. Returns how many were reconciled vs
 * left for review.
 */
export function useAutoReconcile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (accountId: string): Promise<{ reconciled: number; review: number }> => {
      const supabase = createClient();
      const { data: txns, error } = await supabase
        .from("bank_transactions")
        .select("id")
        .eq("bank_account_id", accountId)
        .is("matched_to_id", null);
      if (error) throw error;

      let reconciled = 0, review = 0;
      for (const t of txns ?? []) {
        const { data: sugg } = await supabase.rpc("suggest_bank_transaction_matches", { p_bank_txn_id: t.id });
        const list = (sugg ?? []) as MatchSuggestion[];
        const top = list[0];
        // Auto-apply only a CONFIDENT ('exact' or 'high') and UNAMBIGUOUS match —
        // i.e. no second candidate sharing the top confidence. Two records with
        // the same score (e.g. two months' salary of equal amount) are left for
        // manual review so we never guess wrong on money. Everything applied is
        // reversible via Un-reconcile.
        const conf = top?.match_confidence;
        const confident = conf === "exact" || conf === "high";
        const unambiguous = list.length === 1 || list[1]?.match_confidence !== conf;
        if (top && confident && unambiguous) {
          try {
            await applyReconcile(supabase, { transactionId: t.id, matchedToType: top.match_type, matchedToId: top.match_id, confidence: "high" });
            reconciled++;
          } catch { review++; }
        } else {
          review++;
        }
      }
      return { reconciled, review };
    },
    onSuccess: ({ reconciled, review }) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["salary-payments"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      if (reconciled === 0) toast.info(review > 0 ? `Koi pakka (exact) match nahi mila — ${review} manual review ke liye` : "Sab pehle se reconciled");
      else toast.success(`${reconciled} auto-reconcile ho gaye${review > 0 ? ` · ${review} manual review ke liye` : ""}`);
    },
    onError: (err) => toastError(err),
  });
}

export function useReconcileTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      transactionId: string;
      matchedToType: "payment" | "project" | "expense" | "vendor_bill" | "transfer" | "salary" | "split" | "manual" | null;
      matchedToId:   string | null;
      confidence?:   "exact" | "high" | "low" | "manual";
    }) => {
      const supabase = createClient();
      // One atomic RPC does the bank-line match, both reverse links, and the
      // balance-sheet / statutory reversals — the SAME source of truth as the
      // batch path (applyReconcile). See reconcile_bank_txn (migration
      // 20260901160000) and CLAUDE.md §17b. matched_by is set server-side.
      const { data, error } = await supabase.rpc("reconcile_bank_txn", {
        p_txn_id:           input.transactionId,
        p_matched_to_type:  input.matchedToType,
        p_matched_to_id:    input.matchedToId,
        p_match_confidence: input.confidence ?? "manual",
      });
      if (error) throw error;
      return data as BankTransactionRow;
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions", row.bank_account_id] });
      // A salary/expense match (or its reversal) changes payroll paid-status +
      // the balance sheet's salary-payable, so refresh those views too.
      qc.invalidateQueries({ queryKey: ["salary-payments"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      // Un-reconciling a tax line deletes its tax payment (reconcile_bank_txn).
      qc.invalidateQueries({ queryKey: ["tax-payments"] });
      qc.invalidateQueries({ queryKey: ["accounting", "gst"] });
      qc.invalidateQueries({ queryKey: ["itr-pack"] });
      toast.success(row.matched_to_type ? "Reconciled" : "Un-reconciled");
    },
    onError: (err) => {
      toastError(err, { fallback: "Reconcile failed" });
    },
  });
}

/**
 * Match ONE money-out bank line to MULTIPLE expenses that add up to it (e.g.
 * several bills, or 2 months' salary — salaries are booked as expenses — paid
 * in one transfer). Tags the line 'split' and links every selected expense;
 * salary-expenses also flip their salary to paid. Un-reconcile reverts all.
 */
export function useReconcileExpensesToBankTxn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { transactionId: string; expenseIds: string[] }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("reconcile_expenses_to_bank_txn", {
        p_bank_txn_id:  input.transactionId,
        p_expense_ids:  input.expenseIds,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["salary-payments"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success("Expenses matched & reconciled");
    },
    onError: (err) => toastError(err, { fallback: "Reconcile failed" }),
  });
}

/**
 * Book an unmatched money-OUT bank line straight as a company expense (+ mark
 * it reconciled). No new cash leg — the imported line IS the cash movement.
 */
export function useBookTxnAsExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      transactionId: string; accountId: string;
      category: string; vendor?: string | null; gst?: number; notes?: string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("book_bank_txn_as_expense", {
        p_txn_id:   input.transactionId,
        p_category: input.category,
        p_vendor:   input.vendor ?? null,
        p_gst:      input.gst ?? 0,
        p_notes:    input.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: (_d, input) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions", input.accountId] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success("Booked as expense & reconciled");
    },
    onError: (err) => toastError(err, { fallback: "Couldn't book expense" }),
  });
}

/**
 * Book an unmatched money-OUT line as a statutory (TDS/PF/ESI) challan payment,
 * and reconcile it — in one step. Records a statutory_dues_payments row (which
 * reduces the statutory payable) linked to THIS imported line, so no duplicate/
 * phantom bank line is created (unlike the old pay_statutory_dues flow).
 */
export function useBookBankTxnAsStatutory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      transactionId: string; accountId: string;
      kind: "tds" | "pf" | "esi" | "mixed"; notes?: string | null;
      challanNo?: string | null; period?: string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("book_bank_txn_as_statutory", {
        p_txn_id:     input.transactionId,
        p_kind:       input.kind,
        p_notes:      input.notes ?? null,
        p_challan_no: input.challanNo ?? null,
        p_period:     input.period ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, input) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions", input.accountId] });
      qc.invalidateQueries({ queryKey: ["statutory-dues"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success("Booked as statutory payment & reconciled");
    },
    onError: (err) => toastError(err, { fallback: "Couldn't book statutory payment" }),
  });
}

/**
 * Book an unmatched money-OUT line as the payment of a vendor bill, reconciled to
 * THIS imported line (migration 20260927190000). If the Bills page had already paid
 * it (a synthetic line), that line is replaced — the money is never counted twice.
 */
export function useBookBankTxnAsVendorBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { transactionId: string; accountId: string; billId: string; method?: string | null }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("book_bank_txn_as_vendor_bill", {
        p_txn_id: input.transactionId, p_bill_id: input.billId, p_method: input.method ?? null,
      });
      if (error) throw new Error(error.message);
      return data as { bill_id: string; replaced_synthetic: string | null; amount: number };
    },
    onSuccess: (res, input) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions", input.accountId] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["vendor_bills"] });
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success(res?.replaced_synthetic ? "Bill payment reconciled — Bills page ki manual line hata di, ye asli line rahi" : "Bill payment booked & reconciled");
    },
    onError: (err) => toastError(err, { fallback: "Couldn't book bill payment" }),
  });
}

/** Same for a referral commission: the line must equal the commission's net payable. */
export function useBookBankTxnAsCommission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { transactionId: string; accountId: string; commissionId: string }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("book_bank_txn_as_referral_commission", {
        p_txn_id: input.transactionId, p_commission_id: input.commissionId,
      });
      if (error) throw new Error(error.message);
      return data as { commission_id: string; replaced_synthetic: string | null; amount: number };
    },
    onSuccess: (res, input) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions", input.accountId] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["referral-commissions"] });
      qc.invalidateQueries({ queryKey: ["referral_commissions"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success(res?.replaced_synthetic ? "Commission reconciled — manual line hata di, ye asli line rahi" : "Commission paid & reconciled");
    },
    onError: (err) => toastError(err, { fallback: "Couldn't book commission payment" }),
  });
}

/**
 * Book an unmatched money-IN bank line as owner's capital (equity) or a
 * director's loan (liability), and reconcile it — in one step. Adds the matching
 * Balance-Sheet line (linked to this bank txn) so opening deposits / promoter
 * funds are classified correctly instead of leaking into retained earnings.
 */
export function useBookBankCredit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      transactionId: string; accountId: string;
      kind: "capital" | "director_loan"; label: string; notes?: string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("book_bank_credit", {
        p_txn_id: input.transactionId,
        p_kind:   input.kind,
        p_label:  input.label,
        p_notes:  input.notes ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, input) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions", input.accountId] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success(input.kind === "capital" ? "Booked as owner's capital & reconciled" : "Booked as director's loan & reconciled");
    },
    onError: (err) => toastError(err, { fallback: "Couldn't book this credit" }),
  });
}

/**
 * Book a bank line as money GIVEN TO / RETURNED BY a person (a loan/advance) —
 * a balance-sheet asset, NOT income or expense. Works for both money-out
 * (given) and money-in (returned); the RPC picks the direction from the line.
 */
export function useBookBankAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { transactionId: string; accountId: string; counterparty: string; kind: "given" | "received"; notes?: string | null }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("book_bank_advance", {
        p_txn_id:       input.transactionId,
        p_counterparty: input.counterparty,
        p_kind:         input.kind,
        p_notes:        input.notes ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, input) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions", input.accountId] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success("Booked as a loan/advance & reconciled — P&L not affected");
    },
    onError: (err) => toastError(err, { fallback: "Couldn't book this" }),
  });
}

/**
 * Server-side match-suggestion helper. Returns nearest payments/expenses by
 * amount + date proximity. Used in the reconcile picker so the operator
 * sees "Match to TechVista ₹5,21,088 (exact)" without typing.
 */
export type MatchSuggestion = {
  match_type:       "payment" | "project" | "expense" | "salary";
  match_id:         string;
  match_label:      string;
  match_amount:     number;
  match_date:       string;
  match_confidence: "exact" | "high" | "low";
};

export function useSuggestMatches(transactionId: string | null | undefined) {
  return useQuery({
    queryKey: ["bank_txn_matches", transactionId],
    enabled:  Boolean(transactionId),
    queryFn: async (): Promise<MatchSuggestion[]> => {
      if (!transactionId) return [];
      const supabase = createClient();
      const { data, error } = await supabase.rpc("suggest_bank_transaction_matches", {
        p_bank_txn_id: transactionId,
      });
      if (error) throw error;
      return (data ?? []) as MatchSuggestion[];
    },
    staleTime: 60_000,
  });
}

/* ─── R-109: bank credit → open invoice → one-click record payment ─────────────────── */

/**
 * Every open (pending / overdue) invoice as the matcher's input, with what is STILL due
 * computed by invoiceAmountDue (R-371) — never `amount`, which would ask a part-paid
 * invoice for the full sum again. Project-milestone invoices are flagged: their money
 * goes through project_payments, so the drawer must not one-click them via record_payment.
 */
export function useOpenInvoicesForCreditMatch(enabled = true) {
  return useQuery({
    queryKey: ["invoices", "open-for-credit-match"],
    enabled,
    queryFn: async (): Promise<OpenInvoice[]> => {
      const supabase = createClient();
      const rows = await fetchAllRows<{
        id: string; quote_id: string | null; customer_name: string | null; invoice_date: string;
        amount: number | null; net_payable: number | null; paid_amount: number | null;
        status: string | null; taxable_value: number | null;
      }>((from, to) => supabase
        .from("invoices")
        .select("id, quote_id, customer_name, invoice_date, amount, net_payable, paid_amount, status, taxable_value")
        .in("status", ["pending", "overdue"])
        .order("invoice_date", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to));
      const { data: ms, error: e2 } = await supabase
        .from("project_milestones").select("invoice_id").not("invoice_id", "is", null);
      if (e2) throw e2;
      const projectIds = new Set((ms ?? []).map((m) => m.invoice_id as string));
      return rows
        .map((r) => ({
          id: r.id,
          quoteId: r.quote_id,
          customerName: r.customer_name,
          invoiceDate: r.invoice_date,
          amountDue: invoiceAmountDue(r),
          taxableValue: r.taxable_value,
          isProject: projectIds.has(r.id),
        }))
        .filter((r) => r.amountDue > 0);
    },
    staleTime: 30_000,
  });
}

/**
 * The "Match & record payment" click. Two existing money paths, nothing new:
 *   1. record_payment on the invoice's quote (the only way a payment is recorded — it
 *      flips the invoice to paid, issues the receipt, spawns/rolls the subscription).
 *      The reference is the line's UTR, else BANK-<txn id>; record_payment is idempotent
 *      on reference, so a double click cannot record the money twice.
 *   2. reconcile_bank_txn links THIS bank line to that payment.
 * Only called for a candidate the matcher marked oneClick (exact due, not TDS-short, not a
 * project invoice). The caller passes the credit amount, which equals the due.
 */
export function useMatchCreditToInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      transactionId: string;
      bankAccountId: string;
      quoteId: string;
      invoiceId: string;
      amount: number;
      reference: string | null;
    }) => {
      const amount = Math.round(input.amount);
      if (!(amount > 0)) throw new Error("Amount must be more than ₹0.");
      const supabase = createClient();
      const ref = (input.reference ?? "").trim() || `BANK-${input.transactionId}`;
      const { data: payData, error: e1 } = await supabase.rpc("record_payment", {
        p_quote_id:  input.quoteId,
        p_amount:    amount,
        p_method:    "bank_transfer",
        p_reference: ref,
        p_notes:     `Matched from bank credit to ${input.invoiceId}`,
      });
      if (e1) throw e1;
      const pay = (Array.isArray(payData) ? payData[0] : payData) as { payment_id?: string } | null;
      if (!pay?.payment_id) throw new Error("Payment record nahi bana.");

      await supabase.from("payments").update({ bank_account_id: input.bankAccountId }).eq("id", pay.payment_id);
      const { error: e2 } = await supabase.rpc("reconcile_bank_txn", {
        p_txn_id:           input.transactionId,
        p_matched_to_type:  "payment",
        p_matched_to_id:    pay.payment_id,
        p_match_confidence: "manual",
      });
      if (e2) throw e2;
      return { invoiceId: input.invoiceId };
    },
    onSuccess: ({ invoiceId }) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["aging"] });
      toast.success(`Payment recorded on ${invoiceId} & line reconciled`);
    },
    onError: (err) => toastError(err, { fallback: "Match failed" }),
  });
}
