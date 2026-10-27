/**
 * Project receipts from the bank — a customer's money-in line booked as a project
 * milestone payment, straight from the reconcile dialog.
 *
 * Reuses the project module's own RPCs, unchanged:
 *   create_project_quote + accept_project_quote — only for "Naya project": the project is
 *                                    born as a quotation (line item, public quote link) and
 *                                    accepted at once, so it has the same quote record as a
 *                                    project sold the normal way
 *   split_project_milestone        — a part payment to be invoiced: carve it out first, so the
 *                                    invoice is for the money received, not the whole milestone
 *   add_project_receipt_milestone  — a receipt on a project already paid in full (or an
 *                                    extra payment): one new milestone, project value grows
 *   record_project_payment         — writes project_payments AND reconciles the bank line
 *   raise_project_milestone_invoice — optional tax invoice for that milestone
 *
 *   record_project_receipt_with_tds — when the customer withheld TDS: bank payment + TDS
 *                                    payment + invoice + tds_receivable row, in one transaction
 *
 * Order matters: the payment is recorded BEFORE the invoice is raised, so a fully-paid
 * milestone's invoice is dated on the day the money arrived and born "paid".
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";

export interface OpenMilestone {
  id: string;
  seq: number;
  label: string;
  total: number;
  paid: number;
  remaining: number;
  invoiceId: string | null;
}

export interface OpenProject {
  id: string;
  title: string;
  customerName: string;
  customerId: string | null;
  total: number;
  paid: number;
  gstRate: number;
  /** Unpaid milestones only. Empty when the project is paid in full. */
  milestones: OpenMilestone[];
}

/**
 * Projects that can still receive money: everything not completed / cancelled. A project
 * paid in full is included too — a second payment on it becomes a new milestone.
 */
export function useOpenProjects(enabled: boolean) {
  return useQuery({
    queryKey: ["project_sales", "open_for_receipt"],
    enabled,
    queryFn: async (): Promise<OpenProject[]> => {
      const supabase = createClient();
      const [{ data: projects, error: e1 }, { data: ms, error: e2 }, { data: pays, error: e3 }] = await Promise.all([
        supabase.from("project_sales")
          .select("id, title, customer_name, customer_id, total_amount, gst_rate, status, created_at")
          .not("status", "in", "(completed,cancelled)")
          .order("created_at", { ascending: false }),
        supabase.from("project_milestones").select("id, project_id, seq, label, total_amount, status, invoice_id"),
        supabase.from("project_payments").select("milestone_id, amount"),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      if (e3) throw e3;

      const paidByMs = new Map<string, number>();
      for (const p of pays ?? []) if (p.milestone_id) paidByMs.set(p.milestone_id, (paidByMs.get(p.milestone_id) ?? 0) + (p.amount ?? 0));

      return (projects ?? []).map((p) => {
        const all = (ms ?? [])
          .filter((m) => m.project_id === p.id)
          .map((m) => {
            const paid = paidByMs.get(m.id) ?? 0;
            return {
              id: m.id, seq: m.seq, label: m.label, total: m.total_amount, paid,
              remaining: Math.max(0, m.total_amount - paid), invoiceId: m.invoice_id,
            };
          })
          .sort((a, b) => a.seq - b.seq);
        return {
          id: p.id, title: p.title, customerName: p.customer_name, customerId: p.customer_id,
          total: p.total_amount, gstRate: p.gst_rate ?? 18, paid: all.reduce((s, m) => s + m.paid, 0),
          milestones: all.filter((m) => m.remaining > 0),
        };
      });
    },
    staleTime: 15_000,
  });
}

/**
 * Place of supply for a new project: inter-state (IGST) when the customer's state differs
 * from the seller's. Both come from records, never a constant — a hard-coded state is
 * silently wrong for every other tenant. When either state is missing the answer is not
 * known; that is surfaced to the caller rather than guessed.
 */
export function isInterState(sellerState: string | null | undefined, customerState: string | null | undefined): boolean | null {
  const a = (sellerState ?? "").trim(), b = (customerState ?? "").trim();
  if (!a || !b) return null;
  return a !== b;
}

/**
 * The milestones a NEW project starts with when it is created from a bank receipt:
 * one "Full payment" when the receipt is the whole value, else "Advance" (this receipt)
 * + "Balance" (the rest). GST-inclusive rupees, like every milestone.
 */
export function receiptMilestones(totalInclusive: number, received: number) {
  if (received >= totalInclusive) return [{ label: "Full payment", total_amount: totalInclusive, due_date: null }];
  return [
    { label: "Advance", total_amount: received, due_date: null },
    { label: "Balance", total_amount: totalInclusive - received, due_date: null },
  ];
}

export type ProjectReceiptTarget =
  /** milestoneId null = add a new milestone for this receipt (label: newMilestoneLabel). */
  | { kind: "existing"; projectId: string; milestoneId: string | null; newMilestoneLabel?: string }
  | {
      kind: "new";
      customerId: string | null;
      customerName: string;
      title: string;
      /** GST-inclusive project value. */
      totalInclusive: number;
      gstRate: number;
    };

export function useBookBankCreditAsProjectPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      bankTxnId: string;
      /** ₹ that reached the bank. */
      amount: number;
      /** Set when the customer withheld TDS — the milestone is settled by amount + tds.amount. */
      tds?: { amount: number; section: string; ratePct: number; base: number } | null;
      receivedAt: string;
      reference: string | null;
      target: ProjectReceiptTarget;
      raiseInvoice: boolean;
    }): Promise<{ projectId: string; invoiceId: string | null }> => {
      const supabase = createClient();
      let projectId: string;
      let milestoneId: string;
      /* What the receipt settles: the bank amount plus any TDS the customer paid to the
         government for us. Milestones are sized on this, never on the bank amount alone. */
      const settled = input.amount + (input.tds?.amount ?? 0);

      if (input.target.kind === "new") {
        const t = input.target;
        const taxable = Math.round((t.totalInclusive * 100) / (100 + t.gstRate));
        const { data: auth } = await supabase.auth.getUser();
        if (!auth?.user) throw new Error("Not signed in");
        const { data: me, error: meErr } = await supabase.from("users").select("tenant_id").eq("id", auth.user.id).single();
        if (meErr) throw meErr;
        const [{ data: tenant }, { data: cust }] = await Promise.all([
          supabase.from("tenants").select("state_code").eq("id", me.tenant_id).single(),
          t.customerId ? supabase.from("customers").select("state_code").eq("id", t.customerId).maybeSingle() : Promise.resolve({ data: null }),
        ]);
        const interState = isInterState(tenant?.state_code, cust?.state_code);
        if (interState === null) {
          throw new Error("The state of the customer or your company is not recorded — GST (IGST or CGST+SGST) cannot be decided. Fill in the customer's state, then try again.");
        }
        /* Quotation first, then accepted: the money has arrived, so the customer has
           agreed — but the project keeps a real quote (its line item and customer link),
           exactly like one sold from Project Sales → New quotation. */
        const { data: pid, error } = await supabase.rpc("create_project_quote", {
          p_customer_id: t.customerId,
          p_customer_name: t.customerName,
          p_title: t.title,
          p_description: null,
          p_line_items: [{ name: t.title, qty: 1, rate: taxable, amount: taxable }],
          p_gst_rate: t.gstRate,
          p_inter_state: interState,
          p_milestones: receiptMilestones(t.totalInclusive, settled),
        });
        if (error) throw error;
        projectId = pid as string;
        const { error: accErr } = await supabase.rpc("accept_project_quote", { p_project_id: projectId });
        if (accErr) throw accErr;
        const { data: first, error: mErr } = await supabase
          .from("project_milestones").select("id").eq("project_id", projectId).order("seq").limit(1).single();
        if (mErr) throw mErr;
        milestoneId = first.id;
      } else if (input.target.milestoneId) {
        projectId = input.target.projectId;
        milestoneId = input.target.milestoneId;
        /* A part payment that is to be invoiced: split the milestone first, so the invoice is
           for the money received — raise_project_milestone_invoice bills the WHOLE milestone,
           which gave a ₹23,60,000 invoice for a ₹5,90,000 instalment (26 Sep 2026). */
        if (input.raiseInvoice) {
          const [{ data: ms, error: msErr }, { data: pays, error: pErr }] = await Promise.all([
            supabase.from("project_milestones").select("label, total_amount, invoice_id").eq("id", milestoneId).single(),
            supabase.from("project_payments").select("amount").eq("milestone_id", milestoneId),
          ]);
          if (msErr) throw msErr;
          if (pErr) throw pErr;
          const paid = (pays ?? []).reduce((s, p) => s + (p.amount ?? 0), 0);
          if (!ms.invoice_id && paid === 0 && settled < ms.total_amount) {
            const { data: part, error: splitErr } = await supabase.rpc("split_project_milestone", {
              p_milestone_id: milestoneId,
              p_amount: settled,
              p_label: `${ms.label} — kist ${input.receivedAt}`,
            });
            if (splitErr) throw splitErr;
            milestoneId = part as string;
          }
        }
      } else {
        projectId = input.target.projectId;
        const { data: mid, error: addErr } = await supabase.rpc("add_project_receipt_milestone", {
          p_project_id: projectId,
          p_amount: settled,
          p_label: input.target.newMilestoneLabel ?? null,
        });
        if (addErr) throw addErr;
        milestoneId = mid as string;
      }

      if (input.tds && input.tds.amount > 0) {
        const { data: res, error: tdsErr } = await supabase.rpc("record_project_receipt_with_tds", {
          p_milestone_id: milestoneId,
          p_net: input.amount,
          p_tds: input.tds.amount,
          p_section: input.tds.section,
          p_rate_pct: input.tds.ratePct,
          p_tds_base: input.tds.base,
          p_received_at: input.receivedAt,
          p_bank_txn_id: input.bankTxnId,
          p_reference: input.reference,
          p_raise_invoice: input.raiseInvoice,
        });
        if (tdsErr) throw tdsErr;
        const r = res as { invoice_id: string | null } | null;
        return { projectId, invoiceId: r?.invoice_id ?? null };
      }

      const { error: payErr } = await supabase.rpc("record_project_payment", {
        p_milestone_id: milestoneId,
        p_amount: input.amount,
        p_method: "bank_transfer",
        p_reference: input.reference,
        p_received_at: input.receivedAt,
        p_bank_txn_id: input.bankTxnId,
      });
      if (payErr) throw payErr;

      let invoiceId: string | null = null;
      if (input.raiseInvoice) {
        const { data: ms } = await supabase.from("project_milestones").select("invoice_id").eq("id", milestoneId).single();
        if (!ms?.invoice_id) {
          const { data: inv, error: invErr } = await supabase.rpc("raise_project_milestone_invoice", { p_milestone_id: milestoneId });
          /* The payment and the reconcile are already done — a failed invoice must not
             read as a failed booking. Say so; it can be raised from the project page. */
          if (invErr) toastError(invErr, { fallback: "Payment booked, but the invoice could not be raised — raise it from the project page" });
          else invoiceId = inv as string;
        }
      }
      return { projectId, invoiceId };
    },
    onSuccess: ({ invoiceId }) => {
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      qc.invalidateQueries({ queryKey: ["project_milestones"] });
      qc.invalidateQueries({ queryKey: ["project_payments"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["accounting"] });
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success(invoiceId ? `Project payment booked · invoice ${invoiceId} raised` : "Project payment booked & reconciled");
    },
    onError: (err) => toastError(err, { fallback: "Could not book the project payment" }),
  });
}

/* ── R-1995: one bank receipt → many instalments, one atomic RPC ────────────────────────────── */

/** One ticked instalment: how much of the receipt goes on it (GST-inclusive ₹). */
export interface ProjectReceiptAllocation {
  milestoneId: string;
  amount: number;
  /** Raise the tax invoice for this instalment (a part payment is split first, so the invoice is for the money received). */
  raiseInvoice: boolean;
}

export interface AllocateProjectReceiptInput {
  bankTxnId: string;
  projectId: string;
  /** In the order to book them — the instalment list sends oldest first (FIFO, R-1998). */
  allocations: ProjectReceiptAllocation[];
  /** Defaults to the bank line's date on the server. */
  receivedAt?: string | null;
  /** Defaults to the bank line's UTR on the server. */
  reference?: string | null;
  /** R-1998: the customer withheld TDS — then the kists add up to bank line + TDS (R-1996). */
  tds?: { section: string; ratePct: number; amount: number } | null;
}

export interface AllocateProjectReceiptResult {
  bank_txn_id: string;
  project_id: string;
  total: number;
  allocations: { milestone_id: string; from_milestone_id: string; amount: number; payment_id: string; invoice_id: string | null }[];
}

/**
 * The RPC's arguments. Only ticked lines with money go; the server still checks everything
 * (line not already reconciled, total = the line, no instalment above its balance).
 */
export function allocateProjectReceiptArgs(input: AllocateProjectReceiptInput) {
  return {
    p_bank_txn_id: input.bankTxnId,
    p_project_id: input.projectId,
    p_allocations: input.allocations
      .filter((a) => a.amount > 0)
      .map((a) => ({ milestone_id: a.milestoneId, amount: Math.round(a.amount), raise_invoice: a.raiseInvoice })),
    p_received_at: input.receivedAt ?? null,
    p_reference: input.reference?.trim() ? input.reference.trim() : null,
  };
}

/**
 * R-1998: which RPC Save calls. No TDS → allocate_project_receipt (R-1995, 5 arguments); TDS →
 * allocate_project_receipt_with_tds (R-1996), which splits the TDS pro-rata across the kists.
 */
export function allocateProjectReceiptCall(input: AllocateProjectReceiptInput) {
  const args = allocateProjectReceiptArgs(input);
  if (input.tds && input.tds.amount > 0) {
    return {
      fn: "allocate_project_receipt_with_tds" as const,
      args: {
        ...args,
        p_tds: { section: input.tds.section, rate_pct: input.tds.ratePct, amount: Math.round(input.tds.amount) },
      },
    };
  }
  return { fn: "allocate_project_receipt" as const, args };
}

/**
 * Save one receipt across many instalments — payments, splits, invoices and the bank line
 * reconcile in ONE transaction (allocate_project_receipt): all of it, or nothing.
 * The instalment list in the reconcile dialog calls it (R-1998, project-payment-section.tsx).
 */
export function useAllocateProjectReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AllocateProjectReceiptInput): Promise<AllocateProjectReceiptResult> => {
      const supabase = createClient();
      const call = allocateProjectReceiptCall(input);
      const { data, error } = await supabase.rpc(call.fn as never, call.args as never);
      if (error) throw error;
      return data as unknown as AllocateProjectReceiptResult;
    },
    onSuccess: (res) => {
      for (const k of ["project_sales", "project_milestones", "project_payments", "invoices", "bank_transactions",
                       "bank_accounts", "accounting", "balance-sheet", "tds_receivable"]) {
        qc.invalidateQueries({ queryKey: [k] });
      }
      const invoices = res.allocations.filter((a) => a.invoice_id).length;
      toast.success(`Receipt booked on ${res.allocations.length} instalment${res.allocations.length === 1 ? "" : "s"}`
        + (invoices ? ` · ${invoices} invoice${invoices === 1 ? "" : "s"} raised` : "") + " & reconciled");
    },
    onError: (err) => toastError(err, { fallback: "Could not book the project receipt" }),
  });
}
