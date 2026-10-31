/**
 * Subscriptions — TanStack Query hooks.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queries/keys";
import { invalidateReceivables } from "@/lib/queries/receivables-refresh";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { guardErrorToast } from "@/lib/ui/guard-toast";
import { createClient } from "@/lib/supabase/client";
import type { BillingCycle, Subscription } from "@/lib/supabase/database.types";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { rupee } from "@/lib/utils";

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * R-1121: the PostgREST `or=(…)` for the subscriptions one quote page needs — the quote's own
 * (quote_id), the one it renews (renewal_subscription_id / renewal_quote_id), and the customer's
 * others (their domains prefill the payment dialog). Ids that are not uuids are left out, so a
 * typed value can never widen the filter. The quote id is a text id ("Q-…") and is quoted.
 */
export function quoteSubscriptionsOr(q: {
  id: string; customer_id?: string | null; renewal_subscription_id?: string | null;
}): string {
  const qid = `"${q.id.replace(/["\\]/g, "")}"`;
  const parts = [`quote_id.eq.${qid}`, `renewal_quote_id.eq.${qid}`];
  if (q.renewal_subscription_id && UUID_RE.test(q.renewal_subscription_id)) parts.push(`id.eq.${q.renewal_subscription_id}`);
  if (q.customer_id && UUID_RE.test(q.customer_id)) parts.push(`customer_id.eq.${q.customer_id}`);
  return parts.join(",");
}

/**
 * R-1121: only the subscriptions a quote page uses (quoteSubscriptionsOr), not the whole table
 * — /quotes/[id] used to read every subscription in the workspace to find two or three.
 * Under ["subscriptions"], so every subscription mutation's invalidation reaches it.
 */
export function useQuoteSubscriptions(q: {
  id: string; customer_id?: string | null; renewal_subscription_id?: string | null;
} | null | undefined) {
  return useQuery({
    queryKey: ["subscriptions", "quote", q?.id, q?.customer_id ?? null, q?.renewal_subscription_id ?? null],
    enabled: !!q?.id,
    queryFn: async (): Promise<Subscription[]> => {
      const { data, error } = await createClient()
        .from("subscriptions")
        .select("*")
        .or(quoteSubscriptionsOr(q!))
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      return data ?? [];
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
        /** R-2095: correct a mistyped domain (Correct details). */
        domain?: string | null;
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
 * R-1684: seats / plan / price go through correct_subscription_terms — reason required (kept on
 * the change history), seat cut / plan change owner or manager only, plan = a catalog row.
 * No toast here: the edit dialog saves the rest of the record after it and toasts once.
 */
export function useCorrectSubscriptionTerms() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; itemId: string | null; seats: number; mrr: number; reason: string }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("correct_subscription_terms", {
        p_subscription_id: input.id,
        p_item_id: input.itemId,
        p_seats: input.seats,
        p_mrr: input.mrr,
        p_reason: input.reason,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
    },
    onError: (err) => toastError(err),
  });
}

/**
 * R-2095: change an existing subscription's COMMITMENT (term_months: 1 Flexible / 12 Annual / 36) and
 * PAYMENT FREQUENCY (billing_cycle) through correct_subscription_commitment — reason, role, no annual
 * reduction mid-term, licence cost from the catalogue tier, change history (migration 20261030164727).
 */
export function useCorrectSubscriptionCommitment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; termMonths: number; billingCycle: BillingCycle; renewalDate: string | null; reason: string }) => {
      const supabase = createClient();
      const rpc = supabase.rpc as unknown as (
        fn: "correct_subscription_commitment",
        args: { p_subscription_id: string; p_term_months: number; p_billing_cycle: BillingCycle; p_renewal_date: string | null; p_reason: string },
      ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
      const { error } = await rpc.call(supabase, "correct_subscription_commitment", {
        p_subscription_id: input.id,
        p_term_months: input.termMonths,
        p_billing_cycle: input.billingCycle,
        p_renewal_date: input.renewalDate,
        p_reason: input.reason,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
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
      invalidateReceivables(qc);   // R-1634: its dues leave /collections too
      qc.invalidateQueries({ queryKey: queryKeys.purchaseOrders() });
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
      // R-489: typed straight from database.generated.ts (regenerated after 20261009151000).
      const { data, error } = await supabase.rpc("cancel_subscription", {
        p_subscription_id: args.id,
        p_last_day:        args.lastDay,
        p_reason:          args.reason,
        p_clear_due:       args.clearDue,
      });
      if (error) throw new Error(error.message);
      return data as { due_cleared: number; last_day: string; due_kept?: number; open_invoices?: string[] };
    },
    onSuccess: (r) => {
      invalidateReceivables(qc);   // R-1634: a cleared due leaves /collections too
      /* R-1711: a due an open invoice asks for is kept — say where it still is. */
      const kept = (r.due_kept ?? 0) > 0
        ? ` ${rupee(r.due_kept ?? 0)} is still due on ${(r.open_invoices ?? []).join(", ")} — a credit note on that invoice reduces it.`
        : "";
      toast.success("Subscription cancelled", {
        description: (r.due_cleared > 0
          ? `Out of MRR and renewals. ₹${r.due_cleared.toLocaleString("en-IN")} due cleared.`
          : "Out of MRR and renewals. Nothing was deleted.") + kept,
      });
    },
    onError: (err) => toastError(err, { fallback: "Could not cancel the subscription." }),
  });
}

/**
 * R-1711: every invoice of a subscription — its own quote's, its renewal quote's and its
 * instalments (the same match as cancel_subscription / write_off_subscription) — with the
 * money columns the cancel dialog needs to split the due (lib/subscriptions/cancel-due.ts)
 * and to open a credit note on one of them.
 */
export interface SubscriptionInvoice {
  id: string;
  status: string | null;
  amount: number | null;
  net_payable: number | null;
  paid_amount: number | null;
  written_off_at: string | null;
  customer_name: string | null;
  tax_rate: number | null;
  inter_state: boolean | null;
  invoice_date: string | null;
}

export function useSubscriptionInvoices(
  sub: Pick<Subscription, "id" | "quote_id" | "renewal_quote_id"> | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["subscriptions", "invoices", sub?.id, sub?.quote_id, sub?.renewal_quote_id],
    enabled: enabled && !!sub?.id,
    queryFn: async (): Promise<SubscriptionInvoice[]> => {
      const supabase = createClient();
      const cols = "id, status, amount, net_payable, paid_amount, written_off_at, customer_name, tax_rate, inter_state, invoice_date";
      const { data: bills, error: bErr } = await supabase
        .from("subscription_billings").select("invoice_id").eq("subscription_id", sub!.id);
      if (bErr) throw new Error(bErr.message);
      const instalmentIds = Array.from(new Set((bills ?? []).map((b) => b.invoice_id).filter((x): x is string => !!x)));
      const quoteIds = [sub!.quote_id, sub!.renewal_quote_id].filter((x): x is string => !!x);
      const out = new Map<string, SubscriptionInvoice>();
      if (quoteIds.length > 0) {
        const { data, error } = await supabase.from("invoices").select(cols).in("quote_id", quoteIds);
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as SubscriptionInvoice[]) out.set(r.id, r);
      }
      if (instalmentIds.length > 0) {
        const { data, error } = await supabase.from("invoices").select(cols).in("id", instalmentIds);
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as SubscriptionInvoice[]) out.set(r.id, r);
      }
      return Array.from(out.values());
    },
  });
}

/**
 * R-1683: the quotes that billed a subscription — its sale quote, its renewal quotes and its
 * add-seats quotes — as a PostgREST or= filter (quote id quoted, like quoteSubscriptionsOr).
 */
export function scheduleQuotesOr(sub: { id: string; quote_id: string | null }): string {
  const parts: string[] = [];
  if (sub.quote_id) parts.push(`id.eq."${sub.quote_id.replace(/["\\]/g, "")}"`);
  if (UUID_RE.test(sub.id)) {
    parts.push(`renewal_subscription_id.eq.${sub.id}`, `add_seats_subscription_id.eq.${sub.id}`);
  }
  return parts.length > 0 ? parts.join(",") : `id.eq."__none__"`;
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
      /* R-1683: every quote that billed this subscription — the sale quote, its renewal quotes
         and its add-seats quotes — so the schedule lists all of their invoices, not only the
         sale's and the instalments'. */
      const { data: qs, error: qErr } = await supabase
        .from("quotes")
        .select("id, invoice_id, is_add_seats, renewal_subscription_id, renewal_term_date, add_seats_subscription_id")
        .or(scheduleQuotesOr(sub!))
        .not("invoice_id", "is", null);
      if (qErr) throw new Error(qErr.message);
      const { data: rows, error: bErr } = await supabase
        .from("subscription_billings")
        .select("term_start, period_index, invoice_id, taxable_amount")
        .eq("subscription_id", sub!.id);
      if (bErr) throw new Error(bErr.message);
      /* R-2101: the sale quote's lines — the parts not invoiced yet show the quote's own period
         figure (quoteTermAmount), not one from the rounded mrr. */
      let saleQuote: { discount_pct: number | null; line_items: unknown } | null = null;
      if (sub!.quote_id) {
        const { data: sq, error: sqErr } = await supabase
          .from("quotes").select("discount_pct, line_items").eq("id", sub!.quote_id).maybeSingle();
        if (sqErr) throw new Error(sqErr.message);
        saleQuote = sq ? { discount_pct: sq.discount_pct ?? null, line_items: sq.line_items } : null;
      }
      const ids = Array.from(new Set([
        ...(rows ?? []).map((r) => r.invoice_id),
        ...(qs ?? []).map((q) => q.invoice_id),
      ].filter((x): x is string => !!x)));
      const byId = new Map<string, { status: string; exGst: number; date: string | null }>();
      if (ids.length > 0) {
        const { data: invs, error: sErr } = await supabase
          .from("invoices").select("id, status, invoice_date, amount, tax_amount, taxable_value").in("id", ids);
        if (sErr) throw new Error(sErr.message);
        for (const i of invs ?? []) {
          byId.set(i.id, {
            status: i.status,
            exGst: i.taxable_value ?? Math.max(0, (i.amount ?? 0) - (i.tax_amount ?? 0)),
            date: i.invoice_date,
          });
        }
      }
      const inv = (id: string | null) => (id ? byId.get(id) : undefined);

      type Inv = { invoiceId: string; status: string; exGst: number };
      let sale: Inv | null = null;
      const renewals: Array<Inv & { termDate: string | null }> = [];
      const addSeats: Array<Inv & { invoiceDate: string | null }> = [];
      for (const q of qs ?? []) {
        const i = inv(q.invoice_id);
        if (!i || !q.invoice_id) continue;
        const base = { invoiceId: q.invoice_id, status: i.status, exGst: i.exGst };
        if (q.id === sub!.quote_id) {
          if (i.status !== "void") sale = base;
        } else if (q.is_add_seats && q.add_seats_subscription_id === sub!.id) {
          addSeats.push({ ...base, invoiceDate: i.date });
        } else if (q.renewal_subscription_id === sub!.id) {
          renewals.push({ ...base, termDate: q.renewal_term_date });
        }
      }
      return {
        sale,
        renewals,
        addSeats,
        instalments: (rows ?? []).map((r) => ({
          term_start: r.term_start,
          period_index: r.period_index,
          invoice_id: r.invoice_id,
          invoice_status: inv(r.invoice_id)?.status ?? null,
          invoice_ex_gst: inv(r.invoice_id)?.exGst ?? null,
          part_ex_gst: r.taxable_amount ?? null,   // R-2101: this subscription's share of a combined invoice
        })),
        saleQuote,
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
