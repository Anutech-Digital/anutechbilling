/**
 * Coupons — TanStack Query hooks.
 *
 * Internal admin panel (/coupons page) reads + mutates via these hooks.
 * The PUBLIC validation flow lives in /api/public/coupons/validate
 * (server-side, hides the codes from cross-tenant snooping).
 */

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { CouponRow, CouponRedemptionRow } from "@/lib/supabase/database.types";

export function useCoupons() {
  return useQuery({
    queryKey: ["coupons"],
    queryFn: async (): Promise<CouponRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("coupons")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CouponRow[];
    },
  });
}

export function useCouponRedemptions(code?: string) {
  return useQuery({
    queryKey: ["coupon_redemptions", code ?? "all"],
    queryFn: async (): Promise<CouponRedemptionRow[]> => {
      const supabase = createClient();
      let q = supabase.from("coupon_redemptions").select("*").order("redeemed_at", { ascending: false });
      if (code) q = q.eq("coupon_code", code);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as CouponRedemptionRow[];
    },
  });
}

interface CreateCouponInput {
  code:              string;
  description?:      string | null;
  discount_type:     "percent" | "flat";
  discount_value:    number;
  applies_to_tier?:  string | null;
  min_seats?:        number;
  max_seats?:        number | null;
  max_redemptions?:  number | null;
  valid_until?:      string | null;
  /** R-1981: the marketing campaign this code was made for (optional). */
  campaign_id?:      string | null;
}

export function useCreateCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCouponInput) => {
      const supabase = createClient();
      const { data: auth }  = await supabase.auth.getUser();
      if (!auth?.user) throw new Error("Not authenticated");
      const { data: me } = await supabase
        .from("users").select("tenant_id").eq("id", auth.user.id).single();
      if (!me?.tenant_id) throw new Error("No tenant context");

      const { data, error } = await supabase
        .from("coupons")
        .insert({
          code:              input.code.toUpperCase().trim(),
          tenant_id:         me.tenant_id,
          description:       input.description ?? null,
          discount_type:     input.discount_type,
          discount_value:    input.discount_value,
          applies_to_tier:   input.applies_to_tier?.toLowerCase() || null,
          applies_to_vendor: "google",  // v1 — only Workspace buy page
          min_seats:         input.min_seats        ?? 1,
          max_seats:         input.max_seats        ?? null,
          max_redemptions:   input.max_redemptions  ?? null,
          valid_until:       input.valid_until      ?? null,
          campaign_id:       input.campaign_id      ?? null,
          is_active:         true,
          created_by:        auth.user.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data as CouponRow;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coupons"] }),
  });
}

export function useToggleCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ code, is_active }: { code: string; is_active: boolean }) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("coupons")
        .update({ is_active })
        .eq("code", code);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coupons"] }),
  });
}

export function useDeleteCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("coupons").delete().eq("code", code);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coupons"] }),
  });
}
