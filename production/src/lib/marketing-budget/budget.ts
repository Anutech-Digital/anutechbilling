/**
 * Marketing budget & payments (R-1792, Abhishek 23 Oct 2026) — the parts with no database:
 * what each channel is called, how much is left on a budget, and which expense a paid request
 * becomes. The database enforces the same limits (migration 20261023120000); these are for
 * showing them before anyone presses a button.
 */
import type { UserRole } from "@/lib/auth/roles";

export const BUDGET_CHANNELS = [
  { value: "google-ads", label: "Google Ads" },
  { value: "meta-ads", label: "Facebook / Instagram Ads" },
  { value: "linkedin-ads", label: "LinkedIn Ads" },
  { value: "trade-show", label: "Event / trade show" },
  { value: "other", label: "Other marketing" },
] as const;
export type BudgetChannel = (typeof BUDGET_CHANNELS)[number]["value"];

export function isBudgetChannel(v: unknown): v is BudgetChannel {
  return typeof v === "string" && BUDGET_CHANNELS.some((c) => c.value === v);
}

export function channelLabel(v: string): string {
  return BUDGET_CHANNELS.find((c) => c.value === v)?.label ?? v;
}

/** Who opens the page, and what each may do there. */
export const BUDGET_ROLES: readonly UserRole[] = ["owner", "marketing", "billing", "accountant"];
export const canAskBudget = (role: string | null | undefined) => role === "marketing" || role === "owner";
export const canApproveBudget = (role: string | null | undefined) => role === "owner";
export const canPay = (role: string | null | undefined) => role === "owner" || role === "billing" || role === "accountant";

export type PaymentStatus = "pending" | "paid" | "rejected" | "cancelled";

/** Approved amount minus every payment still asked for or already paid. Never below zero. */
export function budgetLeft(approved: number | null, payments: readonly { amount: number; status: string }[]): number {
  if (!approved) return 0;
  const used = payments.filter((p) => p.status === "pending" || p.status === "paid").reduce((s, p) => s + p.amount, 0);
  return Math.max(0, approved - used);
}

export function budgetPaid(payments: readonly { amount: number; status: string }[]): number {
  return payments.filter((p) => p.status === "paid").reduce((s, p) => s + p.amount, 0);
}

/** Why a payment request cannot go to billing, or null when it can. */
export function paymentProblem(amount: number, left: number, budgetStatus: string): string | null {
  if (budgetStatus !== "approved") return "This budget is not approved yet — wait for the owner.";
  if (!Number.isInteger(amount) || amount <= 0) return "Enter the amount in whole rupees.";
  if (amount > left) return `Only ₹${left.toLocaleString("en-IN")} is left on this budget — ask the owner for more budget.`;
  return null;
}

/**
 * The expense a paid request becomes, so it shows in Marketing → Spend and ROAS: ads go under
 * "Advertising" with their channel, events and the rest under "Marketing".
 */
export function expenseFor(budget: { channel: string; product_name: string | null }, payment: { pay_to: string; purpose: string | null }): {
  category: "Advertising" | "Marketing"; channel: string | null; vendor_name: string; description: string;
} {
  const ads = budget.channel === "google-ads" || budget.channel === "meta-ads" || budget.channel === "linkedin-ads";
  const what = [channelLabel(budget.channel), budget.product_name, payment.purpose].filter(Boolean).join(" · ");
  return {
    category: ads ? "Advertising" : "Marketing",
    channel: budget.channel === "other" ? null : budget.channel,
    vendor_name: payment.pay_to.trim(),
    description: `Marketing budget payment — ${what}`.slice(0, 500),
  };
}

/** "2026-11" → first of that month; anything else → null. */
export function monthStart(ym: string): Date | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(ym.trim());
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)) : null;
}
