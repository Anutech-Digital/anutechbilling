/**
 * Quotes — TanStack Query hooks.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows, errorMessage } from "@/lib/ops/fetch-all";
import type { Quote, Database } from "@/lib/supabase/database.types";

type QuoteInsert = Database["public"]["Tables"]["quotes"]["Insert"];
type QuoteStatus = Quote["status"];

// ============================================================
// List
// ============================================================
export function useQuotes(filter?: { status?: QuoteStatus | "all" }) {
  return useQuery({
    queryKey: ["quotes", filter?.status ?? "all"],
    queryFn: async (): Promise<Quote[]> => {
      const supabase = createClient();
      /* R-264: page past PostgREST's silent 1000-row cap; order ends on id (total order). */
      try {
        return await fetchAllRows<Quote>((from, to) => {
          let query = supabase
            .from("quotes")
            .select("*")
            .order("created_at", { ascending: false, nullsFirst: false })
            .order("id", { ascending: true });
          if (filter?.status && filter.status !== "all") {
            query = query.eq("status", filter.status);
          }
          return query.range(from, to);
        });
      } catch (error) {
        console.warn("Supabase quotes query error:", errorMessage(error));
        return [];
      }
    },
  });
}

// ============================================================
// Single
// ============================================================
export function useQuote(id: string | undefined) {
  return useQuery({
    queryKey: ["quotes", id],
    enabled: !!id,
    queryFn: async (): Promise<Quote | null> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .select("*")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

// ============================================================
// Quote linked to a given invoice — reverse lookup via quotes.invoice_id.
// Used by TaxInvoiceDialog to fetch line items, discount, tax of the parent quote.
// ============================================================
export function useQuoteByInvoiceId(invoiceId: string | undefined) {
  return useQuery({
    queryKey: ["quotes", "by-invoice", invoiceId],
    enabled: !!invoiceId,
    queryFn: async (): Promise<Quote | null> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .select("*")
        .eq("invoice_id", invoiceId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

// ============================================================
// Quotes for a specific lead (history of quotes sent to a prospect)
// ============================================================
export function useQuotesByLead(leadId: string | null | undefined) {
  return useQuery({
    queryKey: ["quotes", "by-lead", leadId],
    enabled: !!leadId,
    queryFn: async (): Promise<Quote[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .select("*")
        .eq("lead_id", leadId!)
        .order("created_at", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// ============================================================
// Create
// ============================================================
export function useCreateQuote() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: Omit<QuoteInsert, "tenant_id">) => {
      const supabase = createClient();

      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");

      const { data: me, error: meErr } = await supabase
        .from("users")
        .select("tenant_id")
        .eq("id", authData.user.id)
        .single();
      if (meErr || !me) throw new Error("User not linked to a tenant");

      // Builder may save the same quote twice — "Save as draft" first,
      // then "Send via WhatsApp" / "Finalize". The quote id was allocated
      // up-front via next_document_number; if a row already exists with
      // that id (in OUR tenant), update it. Otherwise insert fresh.
      //
      // We do this as INSERT-then-UPDATE-on-conflict explicitly (not
      // .upsert()) because supabase-js's upsert hits an awkward RLS path
      // that evaluates UPDATE's USING expression even for first-time
      // inserts, causing false "row-level security policy" failures.
      const payload = { ...input, tenant_id: me.tenant_id };
      const insertRes = await supabase
        .from("quotes")
        .insert(payload)
        .select()
        .single();
      // PostgreSQL unique-violation = 23505
      if (insertRes.error?.code === "23505" && payload.id) {
        const { id, tenant_id: _ignore, ...patch } = payload;
        void _ignore;
        const updateRes = await supabase
          .from("quotes")
          .update(patch)
          .eq("id", id)
          .select()
          .single();
        if (updateRes.error) throw updateRes.error;
        return updateRes.data;
      }
      if (insertRes.error) throw insertRes.error;
      return insertRes.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quote"] });
      toast.success("Quote saved");
    },
    onError: (err) => toastError(err),
  });
}

// ============================================================
// Delete — permanently remove a quote
// ============================================================
// The money-correctness guard lives in a pure, unit-tested module so it can be
// tested without pulling in the Supabase client. See src/lib/quotes/deletable.ts.
import { quoteDeleteBlockReason } from "@/lib/quotes/deletable";
export { quoteDeleteBlockReason };

export function useDeleteQuote() {
  const qc = useQueryClient();

  return useMutation({
    // Takes the whole quote (not just the id) so the guard can inspect
    // payment_status before any destructive write.
    mutationFn: async (quote: Pick<Quote, "id" | "payment_status">) => {
      const blocked = quoteDeleteBlockReason(quote);
      if (blocked) throw new Error(blocked);
      const supabase = createClient();
      const { error } = await supabase.from("quotes").delete().eq("id", quote.id);
      if (error) throw error;
      return quote.id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      toast.success("Quote deleted");
    },
    onError: (err) => toastError(err),
  });
}

// ============================================================
// Update status
// ============================================================
export function useUpdateQuoteStatus() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: QuoteStatus }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .update({ status })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
    },
    onError: (err) => toastError(err),
  });
}

// ============================================================
// Discount / margin approval
//
// The matrix itself is in lib/quotes/approval.ts and is NOT duplicated here —
// these hooks only record decisions. The signed-off discount and margin are
// written alongside the status so a later edit cannot leave a stale approval
// silently covering numbers nobody agreed to.
// ============================================================

/** Push a quote into the approvals queue. */
export function useRequestApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, tier, userId }: { id: string; tier: "manager" | "owner"; userId: string }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .update({
          approval_status: "pending",
          approval_tier: tier,
          approval_requested_by: userId,
          approval_requested_at: new Date().toISOString(),
          // A fresh request clears any previous verdict — otherwise a rejected
          // quote resubmitted still carries the old rejection reason on screen.
          approved_by: null,
          approved_at: null,
          approved_discount_bps: null,
          approved_margin_bps: null,
          approval_rejection_reason: null,
        })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["quotes"] }),
    onError: (err) => toastError(err),
  });
}

/**
 * Record an approval or a rejection.
 *
 * `discountBps` / `marginBps` are the numbers being signed off — the caller reads
 * them from the quote as it stands right now, so what is stored is what was seen.
 */
export function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      decision: "approved" | "rejected";
      userId: string;
      discountBps: number | null;
      marginBps: number | null;
      rejectionReason?: string;
    }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .update(
          input.decision === "approved"
            ? {
                approval_status: "approved",
                approved_by: input.userId,
                approved_at: new Date().toISOString(),
                approved_discount_bps: input.discountBps,
                approved_margin_bps: input.marginBps,
                approval_rejection_reason: null,
              }
            : {
                approval_status: "rejected",
                approved_by: input.userId,
                approved_at: new Date().toISOString(),
                approval_rejection_reason: input.rejectionReason ?? null,
              },
        )
        .eq("id", input.id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["quotes"] }),
    onError: (err) => toastError(err),
  });
}
