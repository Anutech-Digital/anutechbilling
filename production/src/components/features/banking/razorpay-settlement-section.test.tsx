// @vitest-environment jsdom
/**
 * R-2099 — the "Razorpay settlement" box: closed until asked (each fetch calls Razorpay), the
 * missing-key message links to Settings, and an unmatched payment stops the click until picked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { SettlementPlan } from "@/lib/razorpay/settlement-match";

const state = vi.hoisted(() => ({ data: undefined as unknown, enabledSeen: [] as boolean[] }));
vi.mock("@/lib/queries/razorpay-settlement", () => ({
  useRazorpaySettlement: (_t: string, _s: string | null, enabled: boolean) => {
    state.enabledSeen.push(enabled);
    return { data: enabled ? state.data : undefined, isLoading: false, isError: false, refetch: vi.fn() };
  },
  useReconcileRazorpaySettlement: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { RazorpaySettlementSection, remainingBlockers } from "./razorpay-settlement-section";

const unmatchedProblem = "Razorpay payment pay_2 (₹2,360) is not in the app. Pick the app payment it is, or record it first on its quote with reference pay_2, then fetch again.";
const plan: SettlementPlan = {
  settlement: { id: "setl_A", utr: "AXIS1", amount: 9251, createdAt: 1792474200 },
  payments: [
    { rzpId: "pay_1", amount: 1180, fee: 24, tax: 4, orderId: null, createdAt: null, paymentIds: ["a1"], matchedBy: "reference", customer: "Acme", quoteId: "Q-1", candidates: [], problem: null },
    { rzpId: "pay_2", amount: 2360, fee: 47, tax: 7, orderId: null, createdAt: null, paymentIds: [], matchedBy: null, customer: null, quoteId: null,
      candidates: [{ id: "p9", amount: 2360, received_at: "2026-10-18T10:00:00Z", customer_name: "Beta", quote_id: "Q-9", reference: null }], problem: unmatchedProblem },
  ],
  refunds: [],
  totals: { gross: 3540, refunds: 0, fee: 71, feeGst: 11, other: 0, net: 3469, bank: 3469 },
  blockers: [unmatchedProblem],
  ready: false,
  rpcArg: null,
};

beforeEach(() => { cleanup(); state.data = undefined; state.enabledSeen = []; });

describe("remainingBlockers", () => {
  it("an unmatched payment blocks until picked; other blockers stay", () => {
    expect(remainingBlockers(plan, {})).toEqual([unmatchedProblem]);
    expect(remainingBlockers(plan, { pay_2: "p9" })).toEqual([]);
    expect(remainingBlockers({ ...plan, blockers: [unmatchedProblem, "adjustments"] }, { pay_2: "p9" })).toEqual(["adjustments"]);
  });
});

describe("RazorpaySettlementSection", () => {
  it("does not call Razorpay until asked", () => {
    render(<RazorpaySettlementSection line={{ id: "L1", credit: 3469 }} onDone={vi.fn()} />);
    expect(state.enabledSeen.every((e) => e === false)).toBe(true);
    expect(screen.getByRole("button", { name: /Fetch settlement/ })).toBeTruthy();
  });

  it("no keys → message + link to Settings → Integrations", () => {
    state.data = { state: "no_keys", message: "Add your Razorpay API key in Settings → Integrations to fetch settlements from Razorpay." };
    render(<RazorpaySettlementSection line={{ id: "L1", credit: 3469 }} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Fetch settlement/ }));
    expect(screen.getByText(/Add your Razorpay API key in Settings → Integrations/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open Settings → Integrations/ }).getAttribute("href")).toBe("/settings?tab=integrations");
  });

  it("unmatched payment: says why, no Reconcile button until a payment is picked", () => {
    state.data = { state: "plan", plan };
    render(<RazorpaySettlementSection line={{ id: "L1", credit: 3469 }} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Fetch settlement/ }));
    expect(screen.getByText(unmatchedProblem)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reconcile settlement/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("App payment for pay_2"), { target: { value: "p9" } });
    expect(screen.getByRole("button", { name: /Reconcile settlement/ })).toBeTruthy();
    expect(screen.getByText(/Razorpay fee \(incl\. GST ₹11\)/)).toBeTruthy();
  });
});
