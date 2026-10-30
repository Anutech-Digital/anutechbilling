/**
 * Vendors master (migration 0134) — suppliers you buy from (Google CSP,
 * Microsoft, Zoho, etc.). Each vendor rolls up its bills: total billed +
 * outstanding + bill count, so you see "kisko kitna dena" on the buy side.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { gstStateFromGstin } from "@/lib/utils";
import { fetchAllRows, fetchAllRowsIn, type PageQuery } from "@/lib/ops/fetch-all";
import type { VendorRow, ExpenseRow } from "@/lib/supabase/database.types";
import type { VendorBill } from "@/lib/queries/vendor-bills";
import {
  expenseBillDue, advanceLeft, vendorPaymentRows, NOT_VENDOR_BILL_METHODS,
  type ExpenseBillLike, type AdvanceLike, type VendorBankLine, type VendorPayLine, type VendorPaymentRow,
} from "@/lib/accounting/vendor-account";

export type Vendor = VendorRow & {
  /** COGS bills (resale purchases). */
  billCount:   number;
  totalBilled: number;
  /** R-1868: everything still owed = billsOutstanding + expenseBillsOutstanding. */
  outstanding: number;
  /** COGS bills still due. */
  billsOutstanding: number;
  /** Unpaid expense bills (rent, fees, contractors), less the TDS already on them. */
  expenseBillsOutstanding: number;
  /** Advance paid to the vendor, not yet adjusted against a bill (Prepaid). */
  advance: number;
  /** Operating expenses invoiced by this vendor. */
  expenseCount: number;
  expenseTotal: number;
  /** Everything transacted with this supplier = COGS bills + expenses. */
  totalSpend:  number;
  docCount:    number;
  lastBillDate: string | null;
  /** Common foreign currency across ALL this vendor's COGS bills (e.g. "USD"),
   *  or null when domestic or mixed — then only ₹ is meaningful. */
  billCurrency:        string | null;
  foreignBilled:       number;
  foreignOutstanding:  number;
};

// Minimal shapes the rollup needs (keeps the pure fn independent of full rows).
type RollupBill    = { vendor_id: string | null; total: number | null; paid_amount: number | null; bill_date: string | null; currency?: string | null; fx_rate?: number | null };
type RollupExpense = { vendor_id: string | null; amount: number | null; expense_date: string | null; currency?: string | null; fx_rate?: number | null }
  & Partial<Pick<ExpenseBillLike, "paid" | "tds_amount" | "reconciled_txn_id" | "category" | "payment_method" | "prepaid_advance_id" | "advance_applied" | "paid_amount">>;
type RollupAdvance = { vendor_id: string | null; vendor_name: string | null } & AdvanceLike;

/**
 * Pure rollup — folds COGS bills + operating expenses into each vendor.
 * A vendor is anyone who invoices us, so their "total spend" spans both.
 * R-1868: outstanding = COGS bills still due + unpaid expense BILLS (paid = false, the same rule
 * as the bank "This payment is for:" step — lib/accounting/vendor-account.ts); `advance` = what
 * is left of advances paid to the vendor (Prepaid; by vendor id, else by name). Exported for tests.
 */
export function rollupVendors(vendors: VendorRow[], bills: RollupBill[], expenses: RollupExpense[], advances: RollupAdvance[] = []): Vendor[] {
  type Agg = { count: number; total: number; out: number; expOut: number; adv: number; last: string | null; curs: Set<string>; fBilled: number; fOut: number; expCount: number; expTotal: number };
  const blank = (): Agg => ({ count: 0, total: 0, out: 0, expOut: 0, adv: 0, last: null, curs: new Set<string>(), fBilled: 0, fOut: 0, expCount: 0, expTotal: 0 });
  const agg = new Map<string, Agg>();

  for (const b of bills) {
    if (!b.vendor_id) continue;
    const a = agg.get(b.vendor_id) ?? blank();
    const total = b.total ?? 0;
    const out   = Math.max(0, total - (b.paid_amount ?? 0));
    a.count += 1; a.total += total; a.out += out;
    if (b.bill_date && (!a.last || b.bill_date > a.last)) a.last = b.bill_date;
    const code = (b.currency || "INR").toUpperCase();
    const rate = Number(b.fx_rate) || 1;
    a.curs.add(code);
    if (code !== "INR" && rate > 0) { a.fBilled += total / rate; a.fOut += out / rate; }
    agg.set(b.vendor_id, a);
  }
  for (const e of expenses) {
    if (!e.vendor_id) continue;
    const a = agg.get(e.vendor_id) ?? blank();
    const amt = e.amount ?? 0;
    a.expCount += 1; a.expTotal += amt;
    if (e.paid === false) a.expOut += expenseBillDue({
      amount: amt, paid: e.paid, tds_amount: e.tds_amount ?? 0, reconciled_txn_id: e.reconciled_txn_id ?? null,
      category: e.category ?? null, payment_method: e.payment_method ?? null, prepaid_advance_id: e.prepaid_advance_id ?? null,
      advance_applied: e.advance_applied ?? 0,   // R-1913
      paid_amount: e.paid_amount ?? 0,           // R-1915: part paid from the bank
    });
    if (e.expense_date && (!a.last || e.expense_date > a.last)) a.last = e.expense_date;
    const code = (e.currency || "INR").toUpperCase();
    const rate = Number(e.fx_rate) || 1;
    a.curs.add(code);
    if (code !== "INR" && rate > 0) a.fBilled += amt / rate;   // foreign spend (no outstanding on expenses)
    agg.set(e.vendor_id, a);
  }

  const byName = new Map(vendors.map((v) => [v.name.trim().toLowerCase(), v.id]));
  for (const p of advances) {
    const id = p.vendor_id ?? byName.get((p.vendor_name ?? "").trim().toLowerCase());
    if (!id) continue;
    const a = agg.get(id) ?? blank();
    a.adv += advanceLeft(p);
    agg.set(id, a);
  }

  return vendors.map((v) => {
    const a = agg.get(v.id) ?? blank();
    const billCurrency = a.curs.size === 1 && !a.curs.has("INR") ? [...a.curs][0] : null;
    return {
      ...(v as VendorRow),
      billCount: a.count, totalBilled: a.total, outstanding: a.out + a.expOut,
      billsOutstanding: a.out, expenseBillsOutstanding: a.expOut, advance: a.adv,
      expenseCount: a.expCount, expenseTotal: a.expTotal,
      totalSpend: a.total + a.expTotal, docCount: a.count + a.expCount,
      lastBillDate: a.last,
      billCurrency,
      foreignBilled:      billCurrency ? Math.round(a.fBilled * 100) / 100 : 0,
      foreignOutstanding: billCurrency ? Math.round(a.fOut * 100) / 100 : 0,
    };
  });
}

export function useVendors() {
  return useQuery({
    queryKey: ["vendors"],
    queryFn: async (): Promise<Vendor[]> => {
      const supabase = createClient();
      /* R-264: the vendor list AND the bills/expenses its totals are summed from are paged
         past PostgREST's silent 1000-row cap — a capped rollup shows a wrong 'outstanding'
         with no error. Each order ends on id so offset pages never repeat or skip a row. */
      const vendors = await fetchAllRows<VendorRow>((from, to) =>
        supabase.from("vendors").select("*")
          .order("name", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to));
      const bills = await fetchAllRows<RollupBill>((from, to) =>
        supabase
          .from("vendor_bills").select("vendor_id, total, paid_amount, bill_date, currency, fx_rate")
          .order("id", { ascending: true })
          .range(from, to));
      const expenses = await fetchAllRows<RollupExpense>((from, to) =>
        supabase
          .from("expenses").select("vendor_id, amount, expense_date, currency, fx_rate, paid, tds_amount, reconciled_txn_id, category, payment_method, prepaid_advance_id, advance_applied, paid_amount")
          .order("id", { ascending: true })
          .range(from, to));
      // R-1868: what is left of advances paid to vendors (Prepaid).
      const advances = await fetchAllRows<RollupAdvance>((from, to) =>
        supabase
          .from("prepaid_advances").select("id, vendor_id, vendor_name, total_amount, consumed_amount, closed_at")
          .is("closed_at", null)
          .order("id", { ascending: true })
          .range(from, to));

      return rollupVendors(vendors, bills, expenses, advances);
    },
    staleTime: 30_000,
  });
}

/** Expenses invoiced by one vendor (for the vendor detail view — full rows so
 *  a row can open the Edit/Detail expense dialog). */
export function useExpensesByVendor(vendorId: string | null | undefined) {
  return useQuery({
    queryKey: ["expenses", "by-vendor", vendorId],
    enabled: Boolean(vendorId),
    queryFn: async (): Promise<ExpenseRow[]> => {
      const supabase = createClient();
      // R-1582: a regular vendor (AWS, Google) has more than a page of expenses.
      return (await fetchAllRows((from, to) => supabase
        .from("expenses").select("*")
        .eq("vendor_id", vendorId!).order("expense_date", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to))) as ExpenseRow[];
    },
  });
}

/**
 * R-1868: payments made to one vendor — the bank lines reconciled to it (a vendor payment from
 * the bank step, a COGS bill, an expense bill, an advance) with the TDS withheld, plus expense
 * bills marked paid without a bank line. Reads the bills / expenses the popup already loaded.
 */
export function useVendorPayments(vendorId: string | null | undefined, bills: VendorBill[] | undefined, expenses: ExpenseRow[] | undefined) {
  return useQuery({
    queryKey: ["vendor-payments", vendorId, bills?.length ?? -1, expenses?.length ?? -1],
    enabled: Boolean(vendorId) && bills !== undefined && expenses !== undefined,
    queryFn: async (): Promise<VendorPaymentRow[]> => {
      const supabase = createClient();
      const cols = "id, txn_date, debit, reference, matched_to_type, matched_to_id, bank_account_id";
      const billIds = (bills ?? []).map((b) => b.id);
      const expIds = (expenses ?? []).map((e) => e.id);
      type Prep = { id: string; paid_date: string | null; total_amount: number | null; payment_method: string | null; bank_txn_id: string | null };
      const prep = await fetchAllRows<Prep>((from, to) => supabase
        .from("prepaid_advances").select("id, paid_date, total_amount, payment_method, bank_txn_id")
        .eq("vendor_id", vendorId!).order("id", { ascending: true }).range(from, to));
      const [direct, byBill, byExp, byPrep, { data: accounts, error: accErr }] = await Promise.all([
        fetchAllRows<VendorBankLine>((from, to) => supabase.from("bank_transactions").select(cols)
          /* R-1866's type, not yet in the generated types. */
          .eq("matched_to_type", "vendor_payment" as never).eq("matched_to_id", vendorId!).order("id", { ascending: true }).range(from, to)),
        fetchAllRowsIn<VendorBankLine, string>(billIds, (run, from, to) => supabase.from("bank_transactions").select(cols)
          .eq("matched_to_type", "vendor_bill").in("matched_to_id", run).order("id", { ascending: true }).range(from, to)),
        fetchAllRowsIn<VendorBankLine, string>(expIds, (run, from, to) => supabase.from("bank_transactions").select(cols)
          .eq("matched_to_type", "expense").in("matched_to_id", run).order("id", { ascending: true }).range(from, to)),
        fetchAllRowsIn<VendorBankLine, string>(prep.map((p) => p.id), (run, from, to) => supabase.from("bank_transactions").select(cols)
          .eq("matched_to_type", "prepaid").in("matched_to_id", run).order("id", { ascending: true }).range(from, to)),
        supabase.from("bank_accounts").select("id, name"),
      ]);
      if (accErr) throw accErr;
      /* R-1866's table (not yet in the generated types): what each of those bank lines paid. */
      const paymentLines = await fetchAllRowsIn<VendorPayLine & { prepaid_advance_id: string | null }, string>(direct.map((t) => t.id), (run, from, to) => supabase
        .from("bank_vendor_payment_lines" as never)
        .select("id, bank_txn_id, kind, cash, tds_amount, expense_id, vendor_bill_id, prepaid_advance_id")
        .in("bank_txn_id", run).order("id", { ascending: true }).range(from, to) as unknown as PageQuery<VendorPayLine & { prepaid_advance_id: string | null }>);
      /* An advance is a payment of its own only when no bank line carries it already. */
      const advViaBank = new Set<string>([
        ...byPrep.map((t) => t.matched_to_id ?? ""),
        ...paymentLines.map((l) => l.prepaid_advance_id ?? ""),
      ]);
      const advancesOutsideBank = prep.filter((p) => !p.bank_txn_id && !advViaBank.has(p.id));
      const docNo = new Map<string, string | null>([
        ...(bills ?? []).map((b) => [b.id, b.bill_no] as [string, string | null]),
        ...(expenses ?? []).map((e) => [e.id, e.bill_no] as [string, string | null]),
      ]);
      const viaBankExp = new Set(byExp.map((t) => t.matched_to_id));
      const paidOutsideBank = (expenses ?? []).filter((e) => e.paid && !e.reconciled_txn_id && !viaBankExp.has(e.id)
        && e.category !== "Salaries" && !NOT_VENDOR_BILL_METHODS.includes(e.payment_method ?? ""));
      return vendorPaymentRows({
        bankLines: [...direct, ...byBill, ...byExp, ...byPrep],
        paymentLines,
        docNo,
        paidOutsideBank: paidOutsideBank.map((e) => ({
          id: e.id, bill_no: e.bill_no, paid_date: e.paid_date ?? e.expense_date, amount: e.amount, tds_amount: e.tds_amount, payment_method: e.payment_method,
        })),
        advancesOutsideBank,
        accounts: new Map((accounts ?? []).map((a) => [a.id, a.name])),
      });
    },
    staleTime: 30_000,
  });
}

/** Bills belonging to one vendor (for the detail view). */
export function useBillsByVendor(vendorId: string | null | undefined) {
  return useQuery({
    queryKey: ["vendor_bills", "by-vendor", vendorId],
    enabled: Boolean(vendorId),
    queryFn: async (): Promise<VendorBill[]> => {
      const supabase = createClient();
      // R-1582: every bill of the vendor, paged past the gateway's 1000-row cap.
      return (await fetchAllRows((from, to) => supabase
        .from("vendor_bills").select("*").eq("vendor_id", vendorId!).order("bill_date", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to))) as VendorBill[];
    },
  });
}

/**
 * Find-or-create a vendor and return its id. Used when saving a bill so every
 * bill links to the master — no orphan text names, and a new supplier is
 * auto-added to Vendors.
 *
 * Dedup identity: **GSTIN first, then name.** GSTIN is the stable tax identity,
 * so multiple invoices from the same supplier map to ONE vendor even when the
 * printed/OCR'd name varies slightly ("Anthropic, PBC" vs "Anthropic PBC").
 * Only when there's no GSTIN do we fall back to a case-insensitive name match.
 * Backfills a missing gstin/category onto the matched vendor.
 */
export async function ensureVendor(input: { name: string; gstin?: string | null; defaultCategory?: string | null }): Promise<string | null> {
  const name = input.name.trim();
  if (!name) return null;
  const gstin = input.gstin?.trim().toUpperCase() || null;
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return null;
  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", authData.user.id).single();
  if (!me) return null;

  const findByGstin = async () => {
    if (!gstin) return null;
    const { data } = await supabase.from("vendors").select("id, gstin, default_category").ilike("gstin", gstin).limit(1);
    return data?.[0] ?? null;
  };
  const findByName = async () => {
    const { data } = await supabase.from("vendors").select("id, gstin, default_category").ilike("name", name).limit(1);
    return data?.[0] ?? null;
  };
  // GSTIN match wins; name match is the fallback for GSTIN-less suppliers.
  const findExisting = async () => (await findByGstin()) ?? (await findByName());

  const existing = await findExisting();
  if (existing) {
    const patch: { gstin?: string; default_category?: string; state?: string } = {};
    if (!existing.gstin && gstin) {
      patch.gstin = gstin;
      const st = gstStateFromGstin(gstin).name;
      if (st) patch.state = st;
    }
    if (!existing.default_category && input.defaultCategory) patch.default_category = input.defaultCategory;
    if (Object.keys(patch).length) await supabase.from("vendors").update(patch).eq("id", existing.id);
    return existing.id;
  }

  const { data: created, error } = await supabase
    .from("vendors")
    /* R-2095: the state follows the GSTIN (its first two digits). */
    .insert({ tenant_id: me.tenant_id, name, gstin, default_category: input.defaultCategory || null,
              ...(gstin && gstStateFromGstin(gstin).name ? { state: gstStateFromGstin(gstin).name } : {}) })
    .select("id").single();
  if (error) {
    // Likely a concurrent insert hit the unique index — re-find and use it.
    const again = await findExisting();
    return again?.id ?? null;
  }
  return created?.id ?? null;
}

/** The DB's bank-detail checks (R-163), in words a person can act on. */
function bankMessage(m: string): string {
  if (m.includes("vendors_bank_ifsc_format")) return "IFSC looks wrong — 11 characters, 5th is zero (e.g. HDFC0001234).";
  if (m.includes("vendors_bank_account_no_format")) return "Account number should be 6–18 digits.";
  if (m.includes("vendors_upi_id_format")) return "UPI ID looks wrong (e.g. name@okhdfcbank).";
  return m;
}

export function useUpsertVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id?: string; name: string; gstin?: string | null;
      contactName?: string | null; contactEmail?: string | null; contactPhone?: string | null;
      defaultCategory?: string | null; notes?: string | null;
      address?: string | null; city?: string | null; state?: string | null; pincode?: string | null;
      pan?: string | null;
      /** MSME (S33). `undefined` = mat chhuo — sirf jo form ye field dikhata hai wahi bheje. */
      udyam?: string | null;
      msmeCategory?: "micro" | "small" | "medium" | null;
      /** Bank details for payment runs (R-163). `undefined` = mat chhuo, same as MSME. */
      bank?: { accountName: string | null; accountNo: string | null; ifsc: string | null; upiId: string | null };
    }) => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");
      const { data: me, error: meErr } = await supabase
        .from("users").select("tenant_id").eq("id", authData.user.id).single();
      if (meErr || !me) throw new Error("User not linked to a tenant");

      const row = {
        name:             input.name.trim(),
        gstin:            input.gstin?.trim() || null,
        contact_name:     input.contactName?.trim() || null,
        contact_email:    input.contactEmail?.trim() || null,
        contact_phone:    input.contactPhone?.trim() || null,
        default_category: input.defaultCategory || null,
        address:          input.address?.trim() || null,
        city:             input.city?.trim() || null,
        state:            input.state?.trim() || null,
        pincode:          input.pincode?.trim() || null,
        pan:              input.pan?.trim().toUpperCase() || null,
        notes:            input.notes?.trim() || null,
        /* Jo caller ye fields nahi bhejta (quick-add, bill se bana vendor) wo MSME data mita na de. */
        ...(input.udyam !== undefined ? { udyam: input.udyam?.trim().toUpperCase() || null } : {}),
        ...(input.msmeCategory !== undefined ? { msme_category: input.msmeCategory } : {}),
        ...(input.bank !== undefined ? {
          bank_account_name: input.bank.accountName?.trim() || null,
          bank_account_no:   input.bank.accountNo?.replace(/[\s-]/g, "") || null,
          bank_ifsc:         input.bank.ifsc?.trim().toUpperCase() || null,
          upi_id:            input.bank.upiId?.trim() || null,
        } : {}),
      };
      if (input.id) {
        const { error } = await supabase.from("vendors").update(row).eq("id", input.id);
        if (error) throw new Error(bankMessage(error.message));
      } else {
        const { error } = await supabase.from("vendors").insert({ ...row, tenant_id: me.tenant_id });
        if (error) throw new Error(error.message.includes("vendors_tenant_name_uniq") ? "A vendor with this name already exists." : bankMessage(error.message));
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vendors"] });
      toast.success("Vendor saved");
    },
    onError: (err) => toastError(err),
  });
}

export function useDeleteVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      // Bills keep their text name; the FK is set null on delete (migration 0134).
      const { error } = await supabase.from("vendors").delete().eq("id", id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vendors"] });
      qc.invalidateQueries({ queryKey: ["vendor_bills"] });
      toast.success("Vendor removed");
    },
    onError: (err) => toastError(err),
  });
}
