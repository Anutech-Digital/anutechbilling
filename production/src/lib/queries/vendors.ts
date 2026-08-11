/**
 * Vendors master (migration 0134) — suppliers you buy from (Google CSP,
 * Microsoft, Zoho, etc.). Each vendor rolls up its bills: total billed +
 * outstanding + bill count, so you see "kisko kitna dena" on the buy side.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { VendorRow, ExpenseRow } from "@/lib/supabase/database.types";
import type { VendorBill } from "@/lib/queries/vendor-bills";

export type Vendor = VendorRow & {
  /** COGS bills (resale purchases). */
  billCount:   number;
  totalBilled: number;
  outstanding: number;
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
type RollupExpense = { vendor_id: string | null; amount: number | null; expense_date: string | null; currency?: string | null; fx_rate?: number | null };

/**
 * Pure rollup — folds COGS bills + operating expenses into each vendor.
 * A vendor is anyone who invoices us, so their "total spend" spans both.
 * Outstanding stays from COGS bills (expenses are recorded costs, settled via
 * bank reconciliation — no separate payable balance). Exported for unit tests.
 */
export function rollupVendors(vendors: VendorRow[], bills: RollupBill[], expenses: RollupExpense[]): Vendor[] {
  type Agg = { count: number; total: number; out: number; last: string | null; curs: Set<string>; fBilled: number; fOut: number; expCount: number; expTotal: number };
  const blank = (): Agg => ({ count: 0, total: 0, out: 0, last: null, curs: new Set<string>(), fBilled: 0, fOut: 0, expCount: 0, expTotal: 0 });
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
    if (e.expense_date && (!a.last || e.expense_date > a.last)) a.last = e.expense_date;
    const code = (e.currency || "INR").toUpperCase();
    const rate = Number(e.fx_rate) || 1;
    a.curs.add(code);
    if (code !== "INR" && rate > 0) a.fBilled += amt / rate;   // foreign spend (no outstanding on expenses)
    agg.set(e.vendor_id, a);
  }

  return vendors.map((v) => {
    const a = agg.get(v.id) ?? blank();
    const billCurrency = a.curs.size === 1 && !a.curs.has("INR") ? [...a.curs][0] : null;
    return {
      ...(v as VendorRow),
      billCount: a.count, totalBilled: a.total, outstanding: a.out,
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
      const { data: vendors, error } = await supabase.from("vendors").select("*").order("name", { ascending: true });
      if (error) throw error;
      const { data: bills, error: bErr } = await supabase
        .from("vendor_bills").select("vendor_id, total, paid_amount, bill_date, currency, fx_rate");
      if (bErr) throw bErr;
      const { data: expenses, error: eErr } = await supabase
        .from("expenses").select("vendor_id, amount, expense_date, currency, fx_rate");
      if (eErr) throw eErr;

      return rollupVendors((vendors ?? []) as VendorRow[], (bills ?? []) as RollupBill[], (expenses ?? []) as RollupExpense[]);
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
      const { data, error } = await supabase
        .from("expenses").select("*")
        .eq("vendor_id", vendorId!).order("expense_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ExpenseRow[];
    },
  });
}

/** Bills belonging to one vendor (for the detail view). */
export function useBillsByVendor(vendorId: string | null | undefined) {
  return useQuery({
    queryKey: ["vendor_bills", "by-vendor", vendorId],
    enabled: Boolean(vendorId),
    queryFn: async (): Promise<VendorBill[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("vendor_bills").select("*").eq("vendor_id", vendorId!).order("bill_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as VendorBill[];
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
    const patch: { gstin?: string; default_category?: string } = {};
    if (!existing.gstin && gstin) patch.gstin = gstin;
    if (!existing.default_category && input.defaultCategory) patch.default_category = input.defaultCategory;
    if (Object.keys(patch).length) await supabase.from("vendors").update(patch).eq("id", existing.id);
    return existing.id;
  }

  const { data: created, error } = await supabase
    .from("vendors")
    .insert({ tenant_id: me.tenant_id, name, gstin, default_category: input.defaultCategory || null })
    .select("id").single();
  if (error) {
    // Likely a concurrent insert hit the unique index — re-find and use it.
    const again = await findExisting();
    return again?.id ?? null;
  }
  return created?.id ?? null;
}

export function useUpsertVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id?: string; name: string; gstin?: string | null;
      contactName?: string | null; contactEmail?: string | null; contactPhone?: string | null;
      defaultCategory?: string | null; notes?: string | null;
      address?: string | null; city?: string | null; state?: string | null; pincode?: string | null;
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
        notes:            input.notes?.trim() || null,
      };
      if (input.id) {
        const { error } = await supabase.from("vendors").update(row).eq("id", input.id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.from("vendors").insert({ ...row, tenant_id: me.tenant_id });
        if (error) throw new Error(error.message.includes("vendors_tenant_name_uniq") ? "A vendor with this name already exists." : error.message);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vendors"] });
      toast.success("Vendor saved");
    },
    onError: (err) => toast.error((err as Error).message),
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
    onError: (err) => toast.error((err as Error).message),
  });
}
