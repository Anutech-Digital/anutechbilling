/**
 * Vendor bills — Phase 1 accounting queries.
 *
 * Used on /accounting/bills, /accounting/pnl, /accounting/gst/input.
 * RLS-scoped to the caller's tenant — no manual tenant filtering needed
 * on reads. Mutations fetch tenant_id from the users table same as the
 * leads/tasks pattern.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { toastDeleteBlocked } from "@/lib/queries/expenses";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { queryKeys } from "@/lib/queries/keys";
import type { Database, VendorBillRow } from "@/lib/supabase/database.types";
import { billItcEligibility } from "@/lib/gst/bill-itc";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { payVendorBillArgs } from "@/lib/accounting/bill-pay-tds";
import { servicePeriodErrorText, type ServicePeriodBasis } from "@/lib/accounting/bill-service-period";

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

/** R-2623: a bill's service period as the database works it out (vendor_bill_service_period). */
export interface BillServicePeriod {
  service_from: string;
  service_to: string;
  basis: ServicePeriodBasis;
}

/**
 * R-2623: the service period of each listed bill — ONE rule, in SQL (`vendor_bills_service_periods`
 * → vendor_bill_service_period, R-2156): the owner's own period, else a month written on the bill,
 * else the month before for Google / Microsoft, else the bill month. Read in chunks of 500 ids.
 */
export function useVendorBillServicePeriods(ids: string[]) {
  const key = React.useMemo(() => [...ids].sort().join(","), [ids]);
  return useQuery({
    queryKey: ["vendor_bills", "service-periods", key],
    enabled: ids.length > 0,
    queryFn: async (): Promise<Map<string, BillServicePeriod>> => {
      const supabase = createClient();
      const out = new Map<string, BillServicePeriod>();
      const all = key ? key.split(",") : [];
      const chunks: string[][] = [];
      for (let i = 0; i < all.length; i += 500) chunks.push(all.slice(i, i + 500));
      const answers = await Promise.all(chunks.map((c) => supabase.rpc("vendor_bills_service_periods", { p_ids: c })));
      for (const { data, error } of answers) {
        if (error) throw error;
        for (const r of data ?? []) {
          out.set(r.id, { service_from: r.service_from, service_to: r.service_to, basis: r.basis as ServicePeriodBasis });
        }
      }
      return out;
    },
  });
}

/**
 * R-2623: the period a NEW bill would get if the owner leaves it on auto — the same SQL rule, fed
 * the form's bill date, category, bill # and notes.
 */
export function useAutoServicePeriod(input: { billDate: string; category: string; billNo: string; notes: string }) {
  const { billDate, category, billNo, notes } = input;
  return useQuery({
    queryKey: ["vendor_bills", "auto-service-period", billDate, category, billNo, notes],
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(billDate),
    staleTime: 60 * 1000,
    placeholderData: (prev) => prev,   // a changed field keeps the last answer on screen until the new one comes
    queryFn: async (): Promise<BillServicePeriod | null> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("vendor_bill_service_period", {
        p_bill_date: billDate, p_category: category, p_bill_no: billNo, p_notes: notes,
        p_service_from: null, p_service_to: null,   // PostgREST matches the function by every argument name
      });
      if (error) throw error;
      const r = (data ?? [])[0];
      return r ? { service_from: r.service_from, service_to: r.service_to, basis: r.basis as ServicePeriodBasis } : null;
    },
  });
}

/**
 * R-2623: set (or clear back to auto, both null) a bill's service period. Writes ONLY
 * service_from / service_to — the books lock lets exactly these through on a filed month (GST and
 * the amounts are untouched).
 */
export function useSetBillServicePeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, service_from, service_to }: { id: string; service_from: string | null; service_to: string | null }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("vendor_bills")
        .update({ service_from, service_to })
        .eq("id", id)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      /* RLS: only owner / manager / accountant / billing may change a bill (vendor_bills_update_roles). */
      if (!data) throw new Error("This bill could not be changed — only the owner, a manager, an accountant or billing can change a bill. Ask one of them, or refresh the list if it was deleted.");
      return id;
    },
    onSuccess: (_id, v) => {
      invalidateBillCost(qc);
      toast.success(v.service_from ? "Service period saved" : "Service period set back to auto");
    },
    onError: (err) => toastServicePeriodError(err),
  });
}

/** R-2623: a bill's cost or period changed → the bills, the P&L card and its drill (R-2622) read again. */
function invalidateBillCost(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["vendor_bills"] });
  qc.invalidateQueries({ queryKey: queryKeys.pnl() });
  qc.invalidateQueries({ queryKey: ["accounting", "pnl-drill"] });
}

/** R-2623: the period check's raw error → the rule in words; anything else as usual. */
function toastServicePeriodError(err: unknown) {
  const plain = servicePeriodErrorText(err);
  if (plain) toast.error("Service period not saved", { description: plain });
  else toastError(err);
}

/** Our own GST state code ("07") — the tenant's state_code, else its GSTIN's first two digits. */
async function fetchOwnStateCode(): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.from("tenants").select("state_code, gstin").limit(1).maybeSingle();
  return data?.state_code?.trim() || stateCodeFromGstin(data?.gstin ?? null) || null;
}

/** R-1576: our state, for the bill ITC state check (Add Bill dialog). */
export function useOwnStateCode() {
  return useQuery({ queryKey: ["tenant", "own-state-code"], queryFn: fetchOwnStateCode, staleTime: 10 * 60 * 1000 });
}

/** Tiny aggregate used by dashboard widgets. */
export function useVendorBillsTotals(opts: { from: string; to: string }) {
  return useQuery({
    queryKey: ["vendor_bills", "totals", opts],
    queryFn: async () => {
      const supabase = createClient();
      const [{ data, error }, ownStateCode] = await Promise.all([
        supabase
          .from("vendor_bills")
          .select("total, paid_amount, cgst, sgst, igst, category, document_type, vendor_gstin")
          .gte("bill_date", opts.from)
          .lte("bill_date", opts.to),
        fetchOwnStateCode(),
      ]);
      if (error) throw error;

      const rows = data ?? [];
      const totals = {
        count:         rows.length,
        total:         0,
        paid:          0,
        outstanding:   0,
        /* R-1576: only GST that IS credit (tax invoice, vendor GSTIN, right head, not s.17(5)). */
        inputGst:      0,
        /** GST on these bills that gives no credit — it is cost. */
        gstNoCredit:   0,
        cogs:          0,    // any category starting with COGS-
      };
      for (const r of rows) {
        totals.total       += r.total       ?? 0;
        totals.paid        += r.paid_amount ?? 0;
        totals.outstanding += (r.total ?? 0) - (r.paid_amount ?? 0);
        const gst = (r.cgst ?? 0) + (r.sgst ?? 0) + (r.igst ?? 0);
        if (billItcEligibility({ ...r, ownStateCode }).eligible) totals.inputGst += gst;
        else totals.gstNoCredit += gst;
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
      invalidateBillCost(qc);   // R-2623: a set period moves the management P&L too
      toast.success("Bill added");
    },
    onError: (err) => toastServicePeriodError(err),
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
    onError: (err) => toastError(err),
  });
}

/** Record a payment against a bill → paid_amount↑, status flips, bank debited. */
export function usePayVendorBill() {
  const qc = useQueryClient();
  return useMutation({
    /* R-2335: `amount` leaves the bank; the bill is settled by amount + TDS (the 8-argument
       pay_vendor_bill, migration 20261101071500 — same rules as Reconcile, R-2320). */
    mutationFn: async (input: {
      billId: string; amount: number; paidOn: string; bankAccountId: string; method?: string | null;
      tds?: number; tdsSection?: string | null; tdsOverride?: string | null;
    }) => {
      const supabase = createClient();
      const args = payVendorBillArgs({ ...input, tds: input.tds ?? 0, tdsSection: input.tdsSection ?? null });
      /* The 8-argument form is not in the generated types yet. */
      const { error } = await supabase.rpc("pay_vendor_bill", args as never);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vendor_bills"] });
      qc.invalidateQueries({ queryKey: ["expenses", "vendor-tds-fy"] });
      qc.invalidateQueries({ queryKey: ["vendors"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success("Payment recorded");
    },
    onError: (err) => toastError(err),
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

/**
 * R-2005: attach a bill file to a bill / expense that a server transaction just created (the bank
 * Reconcile "record the bill now" — reconcile_bank_debit_to_vendor returns its id). Same storage
 * and the same `attachment_url` column Add COGS Bill / Add expense write; only that column changes.
 */
export async function attachBillFile(source: "vendor_bill" | "expense", id: string, file: File): Promise<string> {
  const path = await uploadBillAttachment(file);
  const supabase = createClient();
  const { error } = source === "vendor_bill"
    ? await supabase.from("vendor_bills").update({ attachment_url: path }).eq("id", id)
    : await supabase.from("expenses").update({ attachment_url: path }).eq("id", id);
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
    /* R-1577: one transaction in the database (delete_vendor_bill). A bill whose payment is
       still matched to a bank line, or that sits in an open payment run, is refused with the
       page to fix it — un-reconcile in Banking first, the delete_payment rule. */
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_vendor_bill", { p_id: id });
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vendor_bills"] });
      toast.success("Bill deleted");
    },
    onError: (err) => toastDeleteBlocked(err, "This bill cannot be removed here — use the button below to go to the page where it is corrected."),
  });
}
