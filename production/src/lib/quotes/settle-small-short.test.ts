/**
 * R-2606 — the quote's "Settle ₹X as round-off" button: who sees it, what it says, and how a
 * refusal from settle_quote_part_short (R-2595) reaches the owner.
 */
import { describe, it, expect } from "vitest";
import {
  maySettleSmallShort, settleShortLabel, settleShortRefusal, SETTLE_SHORT_GENERIC,
  isRoundOffReceipt, pickOpenPart, settleShortPreview,
} from "./settle-small-short";

const rupee = (n: number) => `₹${n.toLocaleString("en-IN")}`;

describe("maySettleSmallShort (R-2606)", () => {
  it("owner and accountant only — as R-2595's RPC", () => {
    expect(maySettleSmallShort("owner")).toBe(true);
    expect(maySettleSmallShort("accountant")).toBe(true);
    for (const r of ["manager", "billing", "sales", "sales_senior", "support", "delivery", null, undefined]) {
      expect(maySettleSmallShort(r)).toBe(false);
    }
  });
});

describe("settleShortLabel", () => {
  it("names the amount as a round-off, never a bank charge (R-2577)", () => {
    expect(settleShortLabel(60, rupee)).toBe("Settle ₹60 as round-off");
    expect(settleShortLabel(60, rupee)).not.toMatch(/bank charge/i);
  });
});

describe("settleShortRefusal", () => {
  it("role refusal → 403 with the database's own sentence", () => {
    expect(settleShortRefusal({ code: "42501", message: "Only the owner or the accountant can settle a small difference." }))
      .toEqual({ status: 403, error: "Only the owner or the accountant can settle a small difference." });
  });
  it("a rule refusal (22023) → 400 with the plain sentence as is", () => {
    const m = "Match this receipt to its bank line first (Banking → Reconcile) — then settle the ₹60 difference.";
    expect(settleShortRefusal({ code: "22023", message: m })).toEqual({ status: 400, error: m });
  });
  it("'nothing was saved' (P0001) and no-company (28000) pass through", () => {
    expect(settleShortRefusal({ code: "P0001", message: "The small difference was not recorded — nothing was saved. Refresh the page and try again." }).status).toBe(400);
    expect(settleShortRefusal({ code: "28000", message: "No company on this login — sign in again." }))
      .toEqual({ status: 401, error: "No company on this login — sign in again." });
  });
  it("anything else → a generic sentence, never raw SQL", () => {
    expect(settleShortRefusal({ code: "42883", message: "function public.settle_quote_part_short(text, text) does not exist" }))
      .toEqual({ status: 500, error: SETTLE_SHORT_GENERIC });
    expect(settleShortRefusal({ message: "fetch failed" })).toEqual({ status: 500, error: SETTLE_SHORT_GENERIC });
  });
});

describe("isRoundOffReceipt", () => {
  it("the BANKCHG-<line> receipt is the round-off, not customer money", () => {
    expect(isRoundOffReceipt({ reference: "BANKCHG-c2606000" })).toBe(true);
    expect(isRoundOffReceipt({ reference: "CTUTR2606" })).toBe(false);
    expect(isRoundOffReceipt({ reference: null })).toBe(false);
  });
});

describe("pickOpenPart — the same invoice the RPC picks", () => {
  const b = (invoice_id: string | null, term_start: string, period_index: number) => ({ invoice_id, term_start, period_index });
  const i = (id: string, status: string, net_payable: number, paid_amount: number) => ({ id, status, net_payable, amount: net_payable, paid_amount });
  it("earliest pending/overdue part by term, then period; paid and void parts skipped", () => {
    expect(pickOpenPart(
      [b("INV-3", "2026-08-01", 3), b("INV-1", "2026-08-01", 1), b("INV-2", "2026-08-01", 2), b(null, "2026-08-01", 4)],
      [i("INV-1", "paid", 95993, 95993), i("INV-2", "pending", 95993, 95933), i("INV-3", "pending", 95993, 0)],
    )).toEqual({ invoiceId: "INV-2", amount: 60 });
    expect(pickOpenPart([b("INV-1", "2026-08-01", 1)], [i("INV-1", "void", 95993, 0)])).toBeNull();
  });
  it("uses net_payable, else amount", () => {
    expect(pickOpenPart([b("INV-1", "2026-08-01", 1)], [{ id: "INV-1", status: "overdue", net_payable: null, amount: 1000, paid_amount: 990 }]))
      .toEqual({ invoiceId: "INV-1", amount: 10 });
  });
});

describe("settleShortPreview", () => {
  function reader(t: Record<string, Record<string, unknown>[]>) {
    return {
      from: (name: string) => ({
        select: () => ({
          eq: (k: string, v: unknown) => Promise.resolve({ data: (t[name] ?? []).filter((r) => r[k] === v), error: null }),
          in: (k: string, v: readonly unknown[]) => Promise.resolve({ data: (t[name] ?? []).filter((r) => v.includes(r[k])), error: null }),
        }),
      }),
    };
  }
  const base = {
    subscriptions: [{ id: "S1", quote_id: "Q-1" }],
    subscription_billings: [
      { subscription_id: "S1", invoice_id: "INV-1", term_start: "2026-08-01", period_index: 1 },
      { subscription_id: "S1", invoice_id: null, term_start: "2026-08-01", period_index: 2 },
    ],
    invoices: [{ id: "INV-1", status: "pending", net_payable: 95993, amount: 95993, paid_amount: 95933 }],
    payments: [
      { id: "P0", quote_id: "Q-1", status: "reversed", received_at: "2026-11-04", created_at: "x" },
      { id: "P1", quote_id: "Q-1", status: "received", received_at: "2026-11-03", created_at: "x" },
    ],
    bank_transactions: [{ matched_to_id: "P1", matched_to_type: "payment", credit: 95933, txn_date: "2026-11-03" }],
  };
  it("the part's ₹60 and the latest receipt's bank line", async () => {
    expect(await settleShortPreview(reader(base) as never, "Q-1"))
      .toEqual({ amount: 60, invoiceId: "INV-1", bankLine: { credit: 95933, txnDate: "2026-11-03" } });
  });
  it("receipt not matched yet → bankLine null", async () => {
    expect((await settleShortPreview(reader({ ...base, bank_transactions: [] }) as never, "Q-1"))?.bankLine).toBeNull();
  });
  it("no subscription / nothing short → null", async () => {
    expect(await settleShortPreview(reader({ ...base, subscriptions: [] }) as never, "Q-1")).toBeNull();
    expect(await settleShortPreview(reader({ ...base, invoices: [{ ...base.invoices[0], paid_amount: 95993, status: "paid" }] }) as never, "Q-1")).toBeNull();
  });
});
