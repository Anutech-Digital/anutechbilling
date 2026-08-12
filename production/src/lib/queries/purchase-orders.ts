/**
 * Purchase Orders — TanStack Query hooks.
 *
 * Buy-side counterpart of quotes/invoices. Auto-created by record_payment
 * RPC; operator finalizes via the list page (mark placed → provisioned →
 * closed) once the order is actually executed with Google CSP / Microsoft
 * Partner / Zoho.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type {
  Database,
  PurchaseOrderRow,
  PurchaseOrderStatus,
  PoBillAllocationRow,
  VendorBillRow,
} from "@/lib/supabase/database.types";

type POUpdate = Database["public"]["Tables"]["purchase_orders"]["Update"];

/**
 * Per-PO rollup from the purchase_order_summary view. Includes expected
 * vs allocated cost + variance for the Phase 2 procurement reconciliation.
 */
export interface PurchaseOrderSummary {
  purchase_order_id: string;
  tenant_id:         string;
  subscription_id:   string | null;
  customer_id:       string | null;
  customer_name:     string;
  vendor:            "google" | "microsoft" | "zoho" | "other";
  plan:              string;
  seats:             number;
  term_months:       number;
  unit_cost_pm:      number;
  expected_cost:     number;
  status:            PurchaseOrderStatus;
  placed_at:         string | null;
  provisioned_at:    string | null;
  closed_at:         string | null;
  allocated_total:   number;
  allocation_count:  number;
  variance_amount:   number;  // expected - allocated; positive = under-billed, negative = over-billed
}

export function usePurchaseOrders() {
  return useQuery({
    queryKey: ["purchase_orders"],
    queryFn: async (): Promise<PurchaseOrderRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Filter POs for a specific subscription */
export function useSubscriptionPurchaseOrders(subscriptionId: string | undefined) {
  return useQuery({
    queryKey: ["purchase_orders", "subscription", subscriptionId],
    enabled:  !!subscriptionId,
    queryFn: async (): Promise<PurchaseOrderRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("*")
        .eq("subscription_id", subscriptionId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

interface UpdatePOInput {
  id:               string;
  status?:          PurchaseOrderStatus;
  vendor_order_id?: string | null;
  unit_cost_pm?:    number;
  notes?:           string | null;
}

/**
 * Update a PO. Handles status transitions cleanly:
 *   - placed       → sets placed_at = now()
 *   - provisioned  → sets provisioned_at = now()
 *   - closed       → sets closed_at = now()
 *   - cancelled    → sets closed_at = now() (terminal)
 */
export function useUpdatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdatePOInput) => {
      const supabase = createClient();
      const patch: POUpdate = {};
      if (input.status !== undefined) {
        patch.status = input.status;
        if (input.status === "placed")      patch.placed_at = new Date().toISOString();
        if (input.status === "provisioned") patch.provisioned_at = new Date().toISOString();
        if (input.status === "closed")      patch.closed_at = new Date().toISOString();
        if (input.status === "cancelled")   patch.closed_at = new Date().toISOString();
      }
      if (input.vendor_order_id !== undefined) patch.vendor_order_id = input.vendor_order_id;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.unit_cost_pm !== undefined) {
        patch.unit_cost_pm = input.unit_cost_pm;
      }

      const { data, error } = await supabase
        .from("purchase_orders")
        .update(patch)
        .eq("id", input.id)
        .select("*")
        .single();
      if (error) throw error;
      return data as PurchaseOrderRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase_orders"] });
      toast.success("Purchase order updated");
    },
    onError: (e) => toast.error((e as Error).message || "Purchase order update nahi hua"),
  });
}

/**
 * Recompute total_cost client-side and persist with the patch.
 * Used when operator edits unit_cost_pm.
 */
/**
 * View-backed rollup of expected vs allocated cost across all POs.
 * Used by the Procurement page variance card + per-row variance badges.
 */
export function usePurchaseOrderSummaries() {
  return useQuery({
    queryKey: ["purchase_orders", "summary"],
    queryFn: async (): Promise<PurchaseOrderSummary[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("purchase_order_summary" as never)
        .select("*");
      if (error) throw error;
      return (data as PurchaseOrderSummary[]) ?? [];
    },
  });
}

export type POAllocationWithBill =
  Pick<PoBillAllocationRow, "id" | "allocated_amount" | "notes" | "created_at"> & {
    vendor_bill: Pick<VendorBillRow, "id" | "vendor_name" | "bill_no" | "bill_date" | "total" | "status"> | null;
  };

/**
 * Allocations for a specific PO — used by PlaceOrderDialog "Linked bills"
 * section. We fetch allocations + bills in 2 round-trips (no implicit FK
 * join — Supabase can't auto-detect the relationship for tables that don't
 * share a typed FK schema entry yet).
 */
export function usePOAllocations(purchaseOrderId: string | undefined) {
  return useQuery({
    queryKey: ["po_allocations", purchaseOrderId],
    enabled:  !!purchaseOrderId,
    queryFn: async (): Promise<POAllocationWithBill[]> => {
      const supabase = createClient();
      const { data: allocs, error: aErr } = await supabase
        .from("po_bill_allocations")
        .select("id, allocated_amount, notes, created_at, vendor_bill_id")
        .eq("purchase_order_id", purchaseOrderId!)
        .order("created_at", { ascending: false });
      if (aErr) throw aErr;
      if (!allocs || allocs.length === 0) return [];

      const billIds = Array.from(new Set(allocs.map((a) => a.vendor_bill_id)));
      const { data: bills } = await supabase
        .from("vendor_bills")
        .select("id, vendor_name, bill_no, bill_date, total, status")
        .in("id", billIds);
      const byId = new Map((bills ?? []).map((b) => [b.id, b] as const));

      return allocs.map((a) => ({
        id:               a.id,
        allocated_amount: a.allocated_amount,
        notes:            a.notes,
        created_at:       a.created_at,
        vendor_bill:      byId.get(a.vendor_bill_id) ?? null,
      }));
    },
  });
}

/** Unallocated bills available for matching to a PO (same tenant). */
export function useUnallocatedVendorBills() {
  return useQuery({
    queryKey: ["vendor_bills", "unallocated"],
    queryFn: async (): Promise<VendorBillRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("vendor_bills")
        .select("*")
        .order("bill_date", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

interface AllocateInput {
  purchase_order_id: string;
  vendor_bill_id:    string;
  allocated_amount:  number;
  notes?:            string;
}

/**
 * Allocate (a portion of) a vendor bill to a PO. UNIQUE constraint on
 * (po, bill) means re-allocating the same pair updates the amount.
 */
export function useAllocateBillToPO() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AllocateInput) => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");
      const { data: me }       = await supabase
        .from("users").select("tenant_id").eq("id", authData.user.id).single();
      if (!me?.tenant_id) throw new Error("No tenant context");

      const { data, error } = await supabase
        .from("po_bill_allocations")
        .upsert({
          tenant_id:         me.tenant_id,
          purchase_order_id: input.purchase_order_id,
          vendor_bill_id:    input.vendor_bill_id,
          allocated_amount:  Math.max(1, Math.round(input.allocated_amount)),
          notes:             input.notes ?? null,
          created_by:        authData.user.id,
        }, { onConflict: "purchase_order_id,vendor_bill_id" })
        .select("*")
        .single();
      if (error) throw error;
      return data as PoBillAllocationRow;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["po_allocations", vars.purchase_order_id] });
      qc.invalidateQueries({ queryKey: ["purchase_orders", "summary"] });
      qc.invalidateQueries({ queryKey: ["purchase_orders"] });
      toast.success("Bill allocated to PO");
    },
    onError: (e) => toast.error((e as Error).message || "Bill allocate nahi hua"),
  });
}

export function useDeallocate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (allocationId: string) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("po_bill_allocations")
        .delete()
        .eq("id", allocationId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["po_allocations"] });
      qc.invalidateQueries({ queryKey: ["purchase_orders", "summary"] });
      qc.invalidateQueries({ queryKey: ["purchase_orders"] });
      toast.success("Bill unlinked from PO");
    },
    onError: (e) => toast.error((e as Error).message || "Unlink nahi hua"),
  });
}

export function useUpdatePurchaseOrderCost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string; unit_cost_pm: number; seats: number; term_months: number;
    }) => {
      const supabase = createClient();
      const total_cost = input.unit_cost_pm * input.seats * input.term_months;
      const { data, error } = await supabase
        .from("purchase_orders")
        .update({ unit_cost_pm: input.unit_cost_pm, total_cost })
        .eq("id", input.id)
        .select("*")
        .single();
      if (error) throw error;
      return data as PurchaseOrderRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase_orders"] });
      toast.success("PO cost updated");
    },
    onError: (e) => toast.error((e as Error).message || "Cost update nahi hua"),
  });
}
