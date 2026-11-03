/**
 * R-2376 — TDS on loan interest to a non-bank lender: the interest already booked to each lender,
 * the owner's answers (tenants.loan_interest_tds) and the one writer (set_loan_interest_tds).
 * The rule itself is pure: lib/accounting/loan-interest-tds.ts.
 *
 * Interest is read from every place the app books it:
 *   business_loan_payments.interest_part / tds_part — term-loan EMI (record_loan_emi), credit-line
 *     and loan repayments (reconcile_bank_debit_to_business_loan, R-2374);
 *   emi_payments.interest_part — EMI loans (R-2323) and assets on EMI (R-1864);
 *   emi_purchases.processing_fee — a loan processing fee is interest (s.2(28A)), WITHOUT its GST.
 * Read-only: nothing here posts an entry.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows, type PageQuery } from "@/lib/ops/fetch-all";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { istToday } from "@/lib/dates/ist";
import {
  readLoanTdsSettings, emptyLoanTdsSettings, fyStartOf, type InterestEvent, type LoanTdsSettings, type LenderType,
} from "@/lib/accounting/loan-interest-tds";

type Client = ReturnType<typeof createClient> | SupabaseClient;
const untyped = (c: Client) => c as unknown as SupabaseClient;

/** Every interest / fee booking to a lender on or after `fromISO`. */
export async function fetchLoanInterestEvents(supabase: Client, fromISO: string): Promise<InterestEvent[]> {
  const db = untyped(supabase);
  const [loans, pays, emis, emiPays] = await Promise.all([
    fetchAllRows<{ id: string; lender: string | null; director_id: string | null }>((from, to) => db
      .from("business_loans").select("id, lender, director_id")
      .order("id", { ascending: true }).range(from, to) as unknown as PageQuery<{ id: string; lender: string | null; director_id: string | null }>),
    fetchAllRows<{ loan_id: string; interest_part: number | null; tds_part: number | null; paid_on: string }>((from, to) => db
      .from("business_loan_payments").select("loan_id, interest_part, tds_part, paid_on").gte("paid_on", fromISO)
      .order("id", { ascending: true }).range(from, to) as unknown as PageQuery<{ loan_id: string; interest_part: number | null; tds_part: number | null; paid_on: string }>),
    fetchAllRows<{ id: string; lender: string | null; processing_fee: number | null; purchased_on: string }>((from, to) => db
      .from("emi_purchases").select("id, lender, processing_fee, purchased_on")
      .order("id", { ascending: true }).range(from, to) as unknown as PageQuery<{ id: string; lender: string | null; processing_fee: number | null; purchased_on: string }>),
    fetchAllRows<{ purchase_id: string; interest_part: number | null; paid_on: string }>((from, to) => db
      .from("emi_payments").select("purchase_id, interest_part, paid_on").gte("paid_on", fromISO)
      .order("id", { ascending: true }).range(from, to) as unknown as PageQuery<{ purchase_id: string; interest_part: number | null; paid_on: string }>),
  ]);

  const out: InterestEvent[] = [];
  const loanById = new Map(loans.map((l) => [l.id, l]));
  for (const p of pays) {
    const l = loanById.get(p.loan_id);
    const lender = l?.lender?.trim();
    if (!lender) continue;
    const amount = Math.max(0, Math.round(Number(p.interest_part) || 0));
    const tdsKept = Math.max(0, Math.round(Number(p.tds_part) || 0));
    if (amount <= 0 && tdsKept <= 0) continue;
    /* A director is never a bank. */
    const lenderType: LenderType | null = l?.director_id ? "non_bank" : null;
    out.push({ lender, on: p.paid_on, amount, kind: "interest", tdsKept, lenderType });
  }
  const emiById = new Map(emis.map((e) => [e.id, e]));
  for (const e of emis) {
    const lender = e.lender?.trim();
    const fee = Math.max(0, Math.round(Number(e.processing_fee) || 0));
    if (!lender || fee <= 0 || e.purchased_on < fromISO) continue;
    out.push({ lender, on: e.purchased_on, amount: fee, kind: "fee", tdsKept: 0, lenderType: null });
  }
  for (const p of emiPays) {
    const lender = emiById.get(p.purchase_id)?.lender?.trim();
    const amount = Math.max(0, Math.round(Number(p.interest_part) || 0));
    if (!lender || amount <= 0) continue;
    out.push({ lender, on: p.paid_on, amount, kind: "interest", tdsKept: 0, lenderType: null });
  }
  return out.sort((a, b) => a.on.localeCompare(b.on));
}

/** The owner's answers. ready = false before the migration (the screen then shows nothing). */
export async function fetchLoanTdsSettings(supabase: Client, tenantId: string): Promise<{ ready: boolean; settings: LoanTdsSettings }> {
  const { data, error } = await untyped(supabase).from("tenants").select("loan_interest_tds").eq("id", tenantId).maybeSingle();
  if (error) {
    const m = String(error.message ?? "");
    if ((error as { code?: string }).code === "42703" || (/loan_interest_tds/.test(m) && /(does not exist|could not find)/i.test(m))) {
      return { ready: false, settings: emptyLoanTdsSettings() };
    }
    throw new Error(m);
  }
  return { ready: true, settings: readLoanTdsSettings((data as { loan_interest_tds?: unknown } | null)?.loan_interest_tds) };
}

/** From 1 April of the PREVIOUS FY — last year's dues still show until settled. */
export function loanTdsWindowStart(todayISO: string = istToday()): string {
  return `${fyStartOf(todayISO) - 1}-04-01`;
}

export function useLoanInterestTds() {
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  return useQuery({
    queryKey: ["loan-interest-tds", tenantId],
    enabled: Boolean(tenantId),
    queryFn: async () => {
      const supabase = createClient();
      const [s, events] = await Promise.all([
        fetchLoanTdsSettings(supabase, tenantId as string),
        fetchLoanInterestEvents(supabase, loanTdsWindowStart()),
      ]);
      return { ...s, events };
    },
    staleTime: 30_000,
  });
}

/** set_loan_interest_tds — what 'off' | 'audited' | 'lender'; value null forgets the answer. */
export function useSetLoanInterestTds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { what: "off" | "audited" | "lender"; key: string | null; value: string | null }) => {
      const { error } = await untyped(createClient()).rpc("set_loan_interest_tds", {
        p_what: input.what, p_key: input.key, p_value: input.value,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["loan-interest-tds"] }); toast.success("Saved"); },
    onError: (err) => toastError(err),
  });
}
