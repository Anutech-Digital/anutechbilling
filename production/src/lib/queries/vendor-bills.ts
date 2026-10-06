/**
 * Vendor bills — Phase 1 accounting queries.
 *
 * Used on /accounting/bills, /accounting/pnl, /accounting/gst/input.
 * RLS-scoped to the caller's tenant — no manual tenant filtering needed
 * on reads. Mutations fetch tenant_id from the users table same as the
 * leads/tasks pattern.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { Database, VendorBillRow } from "@/lib/supabase/database.types";

type VendorBillInsert = Database["public"]["Tables"]["vendor_bills"]["Insert"];
type VendorBillUpdate = Database["public"]["Tables"]["vendor_bills"]["Update"];

export type VendorBill = VendorBillRow;

/** Common categories surfaced in the form. Free-text still allowed. */
export const VENDOR_BILL_CATEGORIES = [
  "COGS-Workspace",
  "COGS-M365",
  "COGS-Zoho",
  "COGS-Other",
] as const;

// ────────────────────────────────────────────────────────────────
// Reads
// ────────────────────────────────────────────────────────────────

export function useVendorBills(opts?: {
  /** ISO YYYY-MM-DD inclusive. Filters bill_date >= from. */
  from?: string;
  /** ISO YYYY-MM-DD inclusive. Filters bill_date <= to. */
  to?:   string;
  /** Filter by status (default: all). */
  status?: "unpaid" | "paid" | "partial" | "owed";
}) {
  const { from, to, status } = opts ?? {};
  return useQuery({
    queryKey: ["vendor_bills", { from, to, status }],
    queryFn: async (): Promise<VendorBill[]> => {
      const supabase = createClient();
      /* R-264: paged past the silent 1000-row cap; id last makes the order total. */
      return await fetchAllRows<VendorBill>((rFrom, rTo) => {
        let q = supabase.from("vendor_bills").select("*")
          .order("bill_date", { ascending: false })
          .order("id", { ascending: true });
        if (from)   q = q.gte("bill_date", from);
        if (to)     q = q.lte("bill_date", to);
        /* "owed" = unpaid + partial: the Outstanding tile's bills (R-118). */
        if (status === "owed") q = q.in("status", ["unpaid", "partial"]);
        else if (status) q = q.eq("status", status);
        return q.range(rFrom, rTo);
      });
    },
  });
}

/** Tiny aggregate used by dashboard widgets. */
export function useVendorBillsTotals(opts: { from: string; to: string }) {
  return useQuery({
    queryKey: ["vendor_bills", "totals", opts],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("vendor_bills")
        .select("total, paid_amount, cgst, sgst, igst, category")
        .gte("bill_date", opts.from)
        .lte("bill_date", opts.to);
      if (error) throw error;

      const rows = data ?? [];
      const totals = {
        count:         rows.length,
        total:         0,
        paid:          0,
        outstanding:   0,
        inputGst:      0,    // CGST + SGST + IGST — claimable as input tax credit
        cogs:          0,    // any category starting with COGS-
      };
      for (const r of rows) {
        totals.total       += r.total       ?? 0;
        totals.paid        += r.paid_amount ?? 0;
        totals.outstanding += (r.total ?? 0) - (r.paid_amount ?? 0);
        totals.inputGst    += (r.cgst ?? 0) + (r.sgst ?? 0) + (r.igst ?? 0);
        if (typeof r.category === "string" && r.category.startsWith("COGS-")) {
          totals.cogs += r.total ?? 0;
        }
      }
      return totals;
    },
  });
}

// ────────────────────────────────────────────────────────────────
// Mutations
// ────────────────────────────────────────────────────────────────

/** ID generator — `BILL-{base36 timestamp}-{2 random hex}`. Short, sortable. */
function newBillId(): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand  = Math.floor(Math.random() * 256).toString(16).padStart(2, "0").toUpperCase();
  return `BILL-${stamp}-${rand}`;
}

export function useCreateVendorBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<VendorBillInsert, "id" | "tenant_id">) => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");

      const { data: me, error: meErr } = await supabase
        .from("users")
        .select("tenant_id")
        .eq("id", authData.user.id)
        .single();
      if (meErr || !me) throw new Error("User not linked to a tenant");

      const { data, error } = await supabase
        .from("vendor_bills")
        .insert({
          ...input,
          id:        newBillId(),
          tenant_id: me.tenant_id,
        })
        .select()
        .single();
      if (error) throw error;
      return data as VendorBill;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vendor_bills"] });
      toast.success("Bill added");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

export function useUpdateVendorBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: VendorBillUpdate }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("vendor_bills")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as VendorBill;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vendor_bills"] });
      toast.success("Bill updated");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

/** Record a payment against a bill → paid_amount↑, status flips, bank debited. */
export function usePayVendorBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { billId: string; amount: number; paidOn: string; bankAccountId: string; method?: string | null }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("pay_vendor_bill", {
        p_bill_id:         input.billId,
        p_amount:          Math.round(input.amount),
        p_paid_on:         input.paidOn,
        p_bank_account_id: input.bankAccountId,
        p_method:          input.method ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vendor_bills"] });
      qc.invalidateQueries({ queryKey: ["vendors"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success("Payment recorded");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

const BILL_BUCKET = "employee-docs";   // reuse the tenant-scoped private bucket

/** Upload a bill file (photo/PDF); returns the storage path for attachment_url. */
export async function uploadBillAttachment(file: File): Promise<string> {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) throw new Error("Not authenticated");
  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", authData.user.id).single();
  if (!me) throw new Error("No tenant");
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
  const path = `${me.tenant_id}/vendor-bills/${crypto.randomUUID()}-${safe}`;
  const { error } = await supabase.storage.from(BILL_BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw new Error(error.message);
  return path;
}

/** Short-lived signed URL to view a bill attachment. */
export async function getBillAttachmentUrl(path: string): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.storage.from(BILL_BUCKET).createSignedUrl(path, 60 * 5);
  return data?.signedUrl ?? null;
}

export function useDeleteVendorBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("vendor_bills").delete().eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vendor_bills"] });
      toast.success("Bill deleted");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}
