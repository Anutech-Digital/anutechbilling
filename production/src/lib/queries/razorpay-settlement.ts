/**
 * R-2099 — Banking → Reconcile → "Razorpay settlement": the read (what the settlement carried,
 * matched to the app's payments) and the one-click reconcile. Both are one call to
 * /api/banking/razorpay-settlement; the server re-reads Razorpay on Reconcile, so the browser
 * never supplies a number.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidateReceivables } from "@/lib/queries/receivables-refresh";
import type { SettlementLookup } from "@/lib/razorpay/settlement-match";

export type { SettlementLookup };

export interface SettlementReconciled {
  settlement_id: string;
  payments: number;
  gross: number;
  refunds: number;
  fee: number;
  fee_booked_now: number;
  fee_gst_now: number;
  fee_expense_id: string | null;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!res.ok || !body || body.ok === false) {
    throw new Error(body?.error ?? `The server answered ${res.status} — try again.`);
  }
  return body;
}

export const razorpaySettlementKey = (txnId: string | null, settlementId: string | null) =>
  ["razorpay_settlement", txnId, settlementId] as const;

/** Fetched only when the user asks (enabled) — every read is a call to Razorpay. */
export function useRazorpaySettlement(txnId: string | null, settlementId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: razorpaySettlementKey(txnId, settlementId),
    enabled: Boolean(txnId) && enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const qs = new URLSearchParams({ txnId: txnId as string });
      if (settlementId) qs.set("settlementId", settlementId);
      const body = await call<{ result: SettlementLookup }>(`/api/banking/razorpay-settlement?${qs.toString()}`);
      return body.result;
    },
  });
}

export function useReconcileRazorpaySettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { txnId: string; settlementId: string | null; picks: Record<string, string> }) => {
      const body = await call<{ reconciled: SettlementReconciled }>("/api/banking/razorpay-settlement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txnId: input.txnId,
          ...(input.settlementId ? { settlementId: input.settlementId } : {}),
          picks: input.picks,
        }),
      });
      return body.reconciled;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["razorpay_settlement"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      invalidateReceivables(qc);
    },
  });
}
