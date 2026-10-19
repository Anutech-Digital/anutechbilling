/**
 * Month-end close — the facts for one month, and the stored manual ticks.
 * The reasoning lives in lib/accounting/month-close.ts; this file only reads.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { itcEligibility } from "@/lib/gst/itc";
import { billItcEligibility } from "@/lib/gst/bill-itc";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { evaluateMonthClose, monthEndOf, MANUAL_STEPS, compliancePeriodKey, type MonthClose, type MonthCloseFacts } from "@/lib/accounting/month-close";

function todayIso(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function useMonthClose(period: string) {
  return useQuery({
    queryKey: ["month-close", period],
    enabled: /^\d{4}-\d{2}$/.test(period),
    queryFn: async (): Promise<{ facts: MonthCloseFacts; close: MonthClose }> => {
      const supabase = createClient();
      const from = `${period}-01`, to = monthEndOf(period);
      const [
        { data: bankAccounts }, { data: unmatched }, { data: emps }, { data: sal }, { data: expTds },
        { data: dues }, { data: inv }, { data: cn }, { data: dn }, { data: gstPay }, { data: drafts },
        { data: exps }, { data: vendors }, { data: tenant }, { data: manual }, { data: filedLog }, { data: bills },
      ] = await Promise.all([
        supabase.from("bank_accounts").select("id").eq("is_active", true).neq("account_type", "cash"),
        supabase.from("bank_transactions").select("id").in("source", ["csv_upload", "api_fetch"]).is("matched_to_type", null).gte("txn_date", from).lte("txn_date", to),
        supabase.from("employees").select("id").eq("is_active", true),
        supabase.from("salary_payments").select("tds, pf, esi, pf_employer, esi_employer, paid_status").eq("period", period),
        supabase.from("expenses").select("tds_amount").gte("expense_date", from).lte("expense_date", to).gt("tds_amount", 0),
        supabase.from("statutory_dues_payments").select("kind").eq("period", period),
        supabase.from("invoices").select("tax_amount").gte("invoice_date", from).lte("invoice_date", to).in("status", ["pending", "paid", "overdue"]),
        supabase.from("credit_notes").select("tax_amount").gte("credit_date", from).lte("credit_date", to),
        supabase.from("debit_notes").select("tax_amount").gte("debit_date", from).lte("debit_date", to),
        supabase.from("tax_payments").select("id").eq("kind", "gst").eq("period", period),
        supabase.from("invoices").select("id").eq("status", "draft").lte("invoice_date", to),
        supabase.from("expenses").select("gst_paid, bill_type, category, vendor_id").gte("expense_date", from).lte("expense_date", to).gt("gst_paid", 0),
        supabase.from("vendors").select("id, gstin"),
        supabase.from("tenants").select("books_locked_until, state_code, gstin").limit(1).maybeSingle(),
        supabase.from("month_close_checks").select("key, done_at, done_by").eq("period", period),
        supabase.from("compliance_log").select("obligation_key, period_key, filed_date").in("obligation_key", MANUAL_STEPS.map((m) => m.complianceKey)),
        /* R-1576: bills this month with GST — the same credit rule as the GST page. */
        supabase.from("vendor_bills").select("cgst, sgst, igst, category, document_type, vendor_gstin").gte("bill_date", from).lte("bill_date", to),
      ]);
      const vendorGstin = new Map((vendors ?? []).map((v) => [v.id, v.gstin ?? null]));
      const blockedItcCount = (exps ?? []).filter((e) => !itcEligibility({
        gst_paid: e.gst_paid, bill_type: e.bill_type, category: e.category,
        vendorGstin: e.vendor_id ? vendorGstin.get(e.vendor_id) ?? null : null,
      }).eligible).length;
      const ownStateCode = tenant?.state_code?.trim() || stateCodeFromGstin(tenant?.gstin ?? null);
      const blockedBillItcCount = (bills ?? []).filter((b) =>
        (b.cgst ?? 0) + (b.sgst ?? 0) + (b.igst ?? 0) > 0 && !billItcEligibility({ ...b, ownStateCode }).eligible).length;
      const sum = <T extends object>(rows: T[] | null | undefined, k: keyof T) => (rows ?? []).reduce((s, r) => s + (Number(r[k] ?? 0) || 0), 0);
      const kinds = new Set((dues ?? []).map((d) => d.kind));
      const facts: MonthCloseFacts = {
        period, monthEnd: to, today: todayIso(),
        unreconciledBankLines: (unmatched ?? []).length,
        bankAccounts: (bankAccounts ?? []).length,
        activeEmployees: (emps ?? []).length,
        salariesRun: (sal ?? []).length,
        salariesUnpaid: (sal ?? []).filter((s) => s.paid_status !== "paid").length,
        withheld: {
          tds: sum(sal, "tds") + sum(expTds, "tds_amount"),
          pf: sum(sal, "pf") + sum(sal, "pf_employer"),
          esi: sum(sal, "esi") + sum(sal, "esi_employer"),
        },
        challans: { tds: kinds.has("tds"), pf: kinds.has("pf"), esi: kinds.has("esi"), mixed: kinds.has("mixed") },
        outputGst: sum(inv, "tax_amount") - sum(cn, "tax_amount") + sum(dn, "tax_amount"),
        gstPaid: (gstPay ?? []).length > 0,
        draftInvoices: (drafts ?? []).length,
        blockedItcCount,
        blockedBillItcCount,
        booksLockedUntil: (tenant as { books_locked_until?: string | null } | null)?.books_locked_until ?? null,
        manual: {
          /* Filed on the Compliance Calendar counts; a tick here on top of it wins the date. */
          ...Object.fromEntries(MANUAL_STEPS.flatMap((s) => {
            const hit = (filedLog ?? []).find((f) => f.obligation_key === s.complianceKey && f.period_key === compliancePeriodKey(s.key, period));
            return hit ? [[s.key, { done_at: hit.filed_date, done_by: null, via: "calendar" as const }]] : [];
          })),
          ...Object.fromEntries((manual ?? []).map((m) => [m.key, { done_at: m.done_at, done_by: m.done_by }])),
        },
      };
      return { facts, close: evaluateMonthClose(facts) };
    },
    staleTime: 30_000,
  });
}

/** Tick / untick a manual step for a month. */
export function useSetManualCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { period: string; key: string; done: boolean }) => {
      const supabase = createClient();
      if (input.done) {
        const { data: auth } = await supabase.auth.getUser();
        const { data: me } = await supabase.from("users").select("tenant_id").eq("id", auth.user?.id ?? "").maybeSingle();
        if (!me?.tenant_id) throw new Error("Company pata nahi chali — dobara login karo.");
        const { error } = await supabase.from("month_close_checks").insert({ tenant_id: me.tenant_id, period: input.period, key: input.key, done_by: auth.user?.id ?? null });
        if (error) throw error;
      } else {
        const { error } = await supabase.from("month_close_checks").delete().eq("period", input.period).eq("key", input.key);
        if (error) throw error;
      }
    },
    onSuccess: (_d, input) => { qc.invalidateQueries({ queryKey: ["month-close", input.period] }); },
    onError: (err) => toastError(err, { fallback: "Tick save nahi hua" }),
  });
}
