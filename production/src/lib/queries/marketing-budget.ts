"use client";
/**
 * Marketing budget & payments (R-1793) — TanStack Query hooks over /api/marketing-budget/*.
 * The routes do the work (withTenant + database rules); these fetch, cache and invalidate.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface BudgetPayment {
  id: string; budgetId: string; amount: number; payTo: string; purpose: string | null; billLink: string | null;
  dueOn: string | null; status: "pending" | "paid" | "rejected" | "cancelled"; requestedBy: string; requestedByName: string;
  createdAt: string; paidOn: string | null; paidByName: string | null; paymentMode: string | null; reference: string | null;
  expenseId: string | null; decisionNote: string | null;
}

export interface Budget {
  id: string; channel: string; channelLabel: string; productName: string | null; month: string;
  amountRequested: number; amountApproved: number | null; note: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requestedBy: string; requestedByName: string; decidedByName: string | null; decidedAt: string | null;
  decisionNote: string | null; createdAt: string; left: number; paid: number; payments: BudgetPayment[];
}

export class BudgetError extends Error {
  constructor(message: string, readonly detail: string | null, readonly status: number) { super(message); }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new BudgetError(
      typeof body.error === "string" ? body.error : "Something went wrong.",
      typeof body.detail === "string" ? body.detail : null,
      res.status,
    );
  }
  return body as T;
}

const KEY = ["marketing-budget"] as const;

export function useBudgets() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<{ role: string; me: string; budgets: Budget[] }>("/api/marketing-budget"),
    refetchInterval: 30_000,
  });
}

function useAct<I>(fn: (input: I) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

const post = (url: string, body: unknown) => api(url, { method: "POST", body: JSON.stringify(body) });

export const useAskBudget = () => useAct((i: {
  channel: string; productItemId: string | null; productName: string | null; month: string; amount: number; note: string | null;
}) => post("/api/marketing-budget", i));

export const useDecideBudget = () => useAct(({ id, ...i }: { id: string; decision: "approve" | "reject"; amount: number | null; note: string | null }) =>
  post(`/api/marketing-budget/${id}/decide`, i));

export const useCancelBudget = () => useAct((id: string) => post(`/api/marketing-budget/${id}/cancel`, {}));

export const useAskPayment = () => useAct((i: {
  budgetId: string; amount: number; payTo: string; purpose: string | null; billLink: string | null; dueOn: string | null;
}) => post("/api/marketing-budget/payments", i));

export const useMarkPaid = () => useAct(({ id, ...i }: { id: string; paidOn: string; mode: string | null; reference: string | null }) =>
  post(`/api/marketing-budget/payments/${id}/paid`, i));

export const useClosePayment = () => useAct(({ id, ...i }: { id: string; status: "rejected" | "cancelled"; note: string | null }) =>
  post(`/api/marketing-budget/payments/${id}/close`, i));
