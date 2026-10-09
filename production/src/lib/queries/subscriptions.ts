/**
 * Subscriptions — TanStack Query hooks.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { guardErrorToast } from "@/lib/ui/guard-toast";
import { createClient } from "@/lib/supabase/client";
import type { Subscription } from "@/lib/supabase/database.types";
import { fetchAllRows } from "@/lib/ops/fetch-all";

export function useSubscriptions() {
  return useQuery({
    queryKey: ["subscriptions"],
    queryFn: async (): Promise<Subscription[]> => {
      const supabase = createClient();
      /* R-046: PostgREST answers at most 1000 rows (supabase/config.toml max_rows) and says
         NOTHING when it cut the answer short. At 1001 subscriptions this list silently lost the
         rest — no error, no warning, just a page that looks complete and is not. That is
         the worst shape a data bug takes (AGENTS.md §2).

         fetchAllRows pages until a short page comes back. The order ENDS ON id because an
         offset page over an order with ties can repeat or skip a row across a page
         boundary — see the helper header; renewal_date alone is not a total order. */
      return await fetchAllRows<Subscription>((from, to) =>
        supabase
          .from("subscriptions")
          .select("*")
          .order("renewal_date", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to));
    },
  });
}

/**
 * Inline-edit hook for setting the domain on an existing subscription.
 * Used by Subscriptions page when an older row was created before the
 * structured `domain` flow existed and lacks the value.
 *
 * Also bubbles the domain up to the customer record (when one is linked)
 * so future leads/quotes auto-populate it.
 */
export function useSetSubscriptionDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, domain }: { id: string; domain: string }) => {
      const clean = domain
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "")
        .trim();
      if (!clean) throw new Error("Domain required");

      const supabase = createClient();

      // Update subscription
      const { data: subRow, error: subErr } = await supabase
        .from("subscriptions")
        .update({ domain: clean })
        .eq("id", id)
        .select("id, customer_id, domain")
        .single();
      if (subErr) throw subErr;

      // Best-effort: keep customer.domain in sync (don't overwrite if customer
      // already has one — operator may have entered a different identity domain).
      if (subRow?.customer_id) {
        const { data: cust } = await supabase
          .from("customers")
          .select("domain")
          .eq("id", subRow.customer_id)
          .maybeSingle();
        if (cust && !cust.domain) {
          await supabase
            .from("customers")
            .update({ domain: clean })
            .eq("id", subRow.customer_id);
        }
      }
      return subRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Domain saved");
    },
    onError: (e) => toastError(e, { fallback: "Domain not saved." }),
  });
}

/**
 * Correct a subscription's details (data-entry fix). Touches only the
 * subscription record's own fields — it does NOT re-bill or alter the linked
 * payment/quote/invoice (those are separate money artifacts). Use it to fix a
 * mis-typed plan / seats / price / dates / status on a manual or imported sub.
 */
export function useUpdateSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      patch: {
        plan?: string;
        vendor?: Subscription["vendor"];
        seats?: number;
        mrr?: number;
        start_date?: string | null;
        renewal_date?: string | null;
        /** Postpaid credit clock (migration 20260910060000). Null clears it, which means
         *  "no agreed date" and shows no countdown — see the edit dialog. */
        payment_due_date?: string | null;
        status?: Subscription["status"];
      };
    }) => {
      const supabase = createClient();
      const { error } = await supabase.from("subscriptions").update(input.patch).eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Subscription corrected");
    },
    onError: (err) => toastError(err),
  });
}

/**
 * Delete a manual / imported subscription (correct a mistake). Guarded RPC:
 * blocks if it came from a paid quote (delete that payment instead) or a linked
 * PO has progressed past draft. Drops draft POs, then the subscription.
 */
export function useDeleteSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_subscription", { p_subscription_id: id });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["outstanding-receivables"] });
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success("Subscription deleted");
    },
    // Blocked (came from a paid quote)? Point to where the fix happens.
    onError: (err) => guardErrorToast(err, { label: "Open Payments", href: "/payments" }),
  });
}

/**
 * R-455: END a real subscription (customer left) — cancel_subscription RPC. Not delete:
 * the subscription, quote, payments and invoices all stay; it leaves MRR and renewals.
 * `clearDue` closes what is still shown as due (e.g. the payment was refunded).
 */
export function useCancelSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; lastDay: string; reason: string; clearDue: boolean }) => {
      const supabase = createClient();
      /* cancel_subscription (20261009151000) is not in database.generated.ts yet — that file
         was locked by another worker (R-482) when this shipped. Narrow, explicit signature
         instead of `any`; drop it after `node scripts/check-db-types.mjs --write`. */
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: "cancel_subscription",
        params: { p_subscription_id: string; p_last_day: string; p_reason: string; p_clear_due: boolean },
      ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
      const { data, error } = await rpc("cancel_subscription", {
        p_subscription_id: args.id,
        p_last_day:        args.lastDay,
        p_reason:          args.reason,
        p_clear_due:       args.clearDue,
      });
      if (error) throw new Error(error.message);
      return data as { due_cleared: number; last_day: string };
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["outstanding-receivables"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success("Subscription cancelled", {
        description: r.due_cleared > 0
          ? `Out of MRR and renewals. ₹${r.due_cleared.toLocaleString("en-IN")} due cleared.`
          : "Out of MRR and renewals. Nothing was deleted.",
      });
    },
    onError: (err) => toastError(err, { fallback: "Could not cancel the subscription." }),
  });
}

/**
 * R-451: the tax invoices behind a subscription's Billing schedule — the sale quote's
 * whole-term invoice and the per-period instalment invoices — so the schedule can say
 * "Invoiced · INV-… · paid" instead of calling a paid term the "next" bill.
 */
export function useScheduleInvoices(sub: Pick<Subscription, "id" | "quote_id"> | null) {
  return useQuery({
    queryKey: ["subscriptions", "schedule-invoices", sub?.id, sub?.quote_id],
    enabled: !!sub?.id,
    queryFn: async () => {
      const supabase = createClient();
      let sale: { invoiceId: string; status: string } | null = null;
      if (sub!.quote_id) {
        const { data: q, error: qErr } = await supabase
          .from("quotes").select("invoice_id").eq("id", sub!.quote_id).maybeSingle();
        if (qErr) throw new Error(qErr.message);
        if (q?.invoice_id) {
          const { data: inv, error: iErr } = await supabase
            .from("invoices").select("id, status").eq("id", q.invoice_id).maybeSingle();
          if (iErr) throw new Error(iErr.message);
          if (inv && inv.status !== "void") sale = { invoiceId: inv.id, status: inv.status };
        }
      }
      const { data: rows, error: bErr } = await supabase
        .from("subscription_billings")
        .select("term_start, period_index, invoice_id")
        .eq("subscription_id", sub!.id);
      if (bErr) throw new Error(bErr.message);
      const ids = Array.from(new Set((rows ?? []).map((r) => r.invoice_id).filter((x): x is string => !!x)));
      const statusById = new Map<string, string>();
      if (ids.length > 0) {
        const { data: invs, error: sErr } = await supabase.from("invoices").select("id, status").in("id", ids);
        if (sErr) throw new Error(sErr.message);
        for (const i of invs ?? []) statusById.set(i.id, i.status);
      }
      return {
        sale,
        instalments: (rows ?? []).map((r) => ({
          term_start: r.term_start,
          period_index: r.period_index,
          invoice_id: r.invoice_id,
          invoice_status: r.invoice_id ? statusById.get(r.invoice_id) ?? null : null,
        })),
      };
    },
  });
}

/**
 * R-453: renewal quotes that are still open (not paid yet) — id + notes, which name the
 * subscription. The Renewals page uses it so a row never offers "Generate quote" for a
 * subscription that already has one (app/(app)/renewals/open-renewal-quotes.ts).
 */
export function useOpenRenewalQuotes() {
  return useQuery({
    queryKey: ["quotes", "open-renewal"],
    queryFn: async (): Promise<Array<{ id: string; notes: string | null }>> => {
      const supabase = createClient();
      return fetchAllRows((from, to) => supabase
        .from("quotes")
        .select("id, notes")
        .eq("is_renewal", true)
        .in("status", ["draft", "sent", "viewed", "accepted"])
        .in("payment_status", ["none", "awaiting", "partial"])
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to));
    },
  });
}

/** Filter subscriptions for a specific customer */
export function useCustomerSubscriptions(customerId: string | undefined) {
  return useQuery({
    queryKey: ["subscriptions", "customer", customerId],
    enabled: !!customerId,
    queryFn: async (): Promise<Subscription[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("customer_id", customerId!)
        .order("start_date", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Rebuild the subscriptions a paid quote lost.
 *
 * ─── NOT OPTIMISTIC, AND NOT SILENT ─────────────────────────────────────────
 * This creates future revenue and a renewal obligation. The screen waits for the server,
 * and the toast NAMES what was created rather than saying "done" — an operator repairing
 * money needs to see the seats and the renewal date, because a wrong renewal date is the
 * difference between chasing in April and chasing in August.
 */
export function useRecreateSubscription() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (quoteId: string) => {
      const res = await fetch(`/api/quotes/${quoteId}/recreate-subscription`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not rebuild the subscription");
      return json as { ok: true; created: { id: string; plan: string; seats: number; mrr: number; renewal_date: string }[] };
    },
    onSuccess: ({ created }) => {
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      const first = created[0];
      toast.success(
        created.length === 1
          ? `Rebuilt: ${first.plan} · ${first.seats} seats · renews ${first.renewal_date}`
          : `Rebuilt ${created.length} subscriptions from this quote`,
        {
          description: created.length > 1
            ? created.map((c) => `${c.plan} — ${c.seats} seats, renews ${c.renewal_date}`).join(" · ")
            : "Check the renewal date is the one you expect — it is backdated to the quote's start, not today.",
        },
      );
    },
    onError: (e: Error) => guardErrorToast(e),
  });
}
