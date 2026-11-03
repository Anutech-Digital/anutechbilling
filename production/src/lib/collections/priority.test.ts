/**
 * R-2409 — Today view, the priority order and one stage per row (priority.ts), and the same
 * through buildCollectionRows (lib/queries/collections.ts), so the list really gets them.
 */
import { describe, expect, it } from "vitest";
import {
  comparePriority, contactSince, isTodayWork, priorityScore, priorityTier, rowStage, todayCounts, wasReminded,
  STAGES, STAGE_LABEL, type PriorityRow,
} from "./priority";
import { buildCollectionRows, filterCollectionRows, type CollectionsInput, type CollectionFollowup } from "@/lib/queries/collections";

const TODAY = "2026-11-03";

const pr = (name: string, o: Partial<PriorityRow> = {}): PriorityRow => ({
  customerName: name, amountDue: 0, daysOverdue: 0, followUpDue: false, promiseStatus: null, promiseBroken: false, priorityScore: 0, ...o,
});

describe("R-2409 priority score = overdue ₹ × days late", () => {
  it("adds ₹ × days over the late lines only; not-due lines add 0", () => {
    expect(priorityScore([{ amountDue: 100_000, daysOverdue: 10 }, { amountDue: 5_000, daysOverdue: 0 }, { amountDue: 7_000, daysOverdue: -4 }])).toBe(1_000_000);
    expect(priorityScore([{ amountDue: 20_000, daysOverdue: 30 }, { amountDue: 1_000, daysOverdue: 2 }])).toBe(602_000);
    expect(priorityScore([])).toBe(0);
  });

  it("whole rupees: paise are rounded before multiplying", () => {
    expect(priorityScore([{ amountDue: 999.6, daysOverdue: 2 }])).toBe(2000);
  });
});

describe("R-2409 Today's work first", () => {
  it("broken promises first, then follow-ups / promises due today, then the rest — each by score", () => {
    const rows = [
      pr("Big late, nothing today", { priorityScore: 9_000_000, daysOverdue: 90, amountDue: 100_000 }),
      pr("Follow-up due, small", { followUpDue: true, priorityScore: 10_000, daysOverdue: 5, amountDue: 2_000 }),
      pr("Promise due today", { promiseStatus: "due", priorityScore: 500_000, daysOverdue: 10, amountDue: 50_000 }),
      pr("Broken, small", { promiseBroken: true, promiseStatus: "broken", priorityScore: 1_000, daysOverdue: 1, amountDue: 1_000 }),
      pr("Broken, big", { promiseBroken: true, promiseStatus: "broken", priorityScore: 2_000_000, daysOverdue: 40, amountDue: 50_000 }),
      pr("Not due", { priorityScore: 0, amountDue: 80_000, daysOverdue: -5 }),
    ];
    expect([...rows].sort(comparePriority).map((r) => r.customerName)).toEqual([
      "Broken, big", "Broken, small", "Promise due today", "Follow-up due, small", "Big late, nothing today", "Not due",
    ]);
  });

  it("₹1,00,000 × 10 days beats ₹20,000 × 30 days; equal scores → more days late, bigger amount, name", () => {
    const a = pr("A", { priorityScore: priorityScore([{ amountDue: 100_000, daysOverdue: 10 }]) });
    const b = pr("B", { priorityScore: priorityScore([{ amountDue: 20_000, daysOverdue: 30 }]) });
    expect([b, a].sort(comparePriority).map((r) => r.customerName)).toEqual(["A", "B"]);
    const c = pr("C", { daysOverdue: 3, amountDue: 10 });
    const d = pr("D", { daysOverdue: 3, amountDue: 20 });
    const e = pr("E", { daysOverdue: 3, amountDue: 20 });
    expect([e, c, d].sort(comparePriority).map((r) => r.customerName)).toEqual(["D", "E", "C"]);
  });

  it("tiers and the Today test", () => {
    expect(priorityTier(pr("x", { promiseBroken: true }))).toBe(0);
    expect(priorityTier(pr("x", { followUpDue: true }))).toBe(1);
    expect(priorityTier(pr("x", { promiseStatus: "due" }))).toBe(1);
    expect(priorityTier(pr("x", { promiseStatus: "open" }))).toBe(2);
    expect(isTodayWork(pr("x", { promiseStatus: "kept" }))).toBe(false);
  });

  it("todayCounts: each Today row counted once, with its reasons", () => {
    const c = todayCounts([
      pr("a", { followUpDue: true }),
      pr("b", { promiseStatus: "due", followUpDue: true }),
      pr("c", { promiseBroken: true, promiseStatus: "broken" }),
      pr("d", { promiseStatus: "open" }),
    ]);
    expect(c).toEqual({ total: 3, followUps: 2, promisesToday: 1, broken: 1 });
  });
});

describe("R-2409 one stage per row", () => {
  const dispute = { kind: "dispute" as const, since: TODAY, reason: "wrong rate", entryId: "f1" };
  const promise = { kind: "promise" as const, until: "2026-11-05", amount: 5000 };

  it("the six stages, in this order of precedence", () => {
    expect(STAGES.map((s) => STAGE_LABEL[s])).toEqual(["Not contacted", "Reminded", "Promised", "Broken", "Disputed", "Part-paid"]);
    expect(rowStage({ hold: dispute, promiseBroken: true, partPaid: true, reminded: true })).toBe("disputed");
    expect(rowStage({ hold: null, promiseBroken: true, partPaid: true, reminded: true })).toBe("broken");
    expect(rowStage({ hold: promise, promiseBroken: false, partPaid: true, reminded: true })).toBe("promised");
    expect(rowStage({ hold: null, promiseBroken: false, partPaid: true, reminded: true })).toBe("partPaid");
    expect(rowStage({ hold: null, promiseBroken: false, partPaid: false, reminded: true })).toBe("reminded");
    expect(rowStage({ hold: null, promiseBroken: false, partPaid: false, reminded: false })).toBe("notContacted");
  });

  it("Reminded: a contact since a week before the oldest line fell due, or a delivered auto reminder; a note is not contact", () => {
    // oldest line 10 days late → due 24 Oct → contacts from 17 Oct count
    expect(contactSince(TODAY, 10)).toBe("2026-10-17");
    expect(contactSince(TODAY, -3)).toBe("2026-10-30");
    expect(contactSince(TODAY, -30)).toBe(TODAY);
    const fu = (kind: string, created_at: string) => ({ kind, created_at });
    expect(wasReminded({ today: TODAY, daysOverdue: 10, followups: [fu("whatsapp", "2026-10-20T06:00:00Z")], autoReminders: 0 })).toBe(true);
    expect(wasReminded({ today: TODAY, daysOverdue: 10, followups: [fu("call", "2026-09-01T06:00:00Z")], autoReminders: 0 })).toBe(false);
    expect(wasReminded({ today: TODAY, daysOverdue: 10, followups: [fu("note", "2026-11-01T06:00:00Z")], autoReminders: 0 })).toBe(false);
    expect(wasReminded({ today: TODAY, daysOverdue: 10, followups: [], autoReminders: 1 })).toBe(true);
  });
});

// ─── Through buildCollectionRows ─────────────────────────────────────────────

const inv = (id: string, customer: string, o: Partial<CollectionsInput["invoices"][number]> = {}) => ({
  id, customer_id: customer, customer_name: customer, amount: 10_000, net_payable: 10_000, paid_amount: 0, status: "overdue",
  invoice_date: "2026-10-01", due_date: "2026-10-01", quote_id: null, taxable_value: null, tax_amount: null, tax_rate: null, ...o,
});
const fu = (id: string, customer: string, o: Partial<CollectionFollowup> = {}): CollectionFollowup => ({
  id, customer_id: customer, kind: "call", note: null, promised_amount: null, promised_on: null,
  next_follow_up_on: "2026-11-10", assigned_to: null, created_at: "2026-10-20T06:00:00Z", outcome: null, ...o,
});
const cust = (id: string) => ({ id, name: id, display_name: null, account_manager_id: null });

function input(o: Partial<CollectionsInput>): CollectionsInput {
  return { invoices: [], subscriptions: [], quoteSubscriptions: [], invoicedQuoteIds: new Set(), customers: [], followups: [], payments: [], ...o };
}

describe("R-2409 buildCollectionRows fills stage, score and order", () => {
  const rows = buildCollectionRows(input({
    customers: ["nc", "rem", "auto", "part", "prom", "brk", "disp"].map(cust),
    invoices: [
      inv("I-NC", "nc", { amount: 50_000, net_payable: 50_000, due_date: "2026-10-24" }),            // 10 days late
      inv("I-REM", "rem", { amount: 20_000, net_payable: 20_000, due_date: "2026-10-04" }),          // 30 days late
      inv("I-AUTO", "auto", { due_date: "2026-11-01" }),
      inv("I-PART", "part", { amount: 30_000, net_payable: 30_000, paid_amount: 10_000 }),
      inv("I-PROM", "prom", { due_date: "2026-10-30" }),
      inv("I-BRK", "brk", { amount: 1_000, net_payable: 1_000, due_date: "2026-11-02" }),
      inv("I-DISP", "disp"),
    ],
    followups: [
      fu("f-rem", "rem", { kind: "whatsapp", created_at: "2026-10-28T06:00:00Z" }),
      fu("f-prom", "prom", { kind: "promise", promised_on: "2026-11-03", promised_amount: 10_000 }),
      fu("f-brk", "brk", { kind: "promise", promised_on: "2026-11-02", promised_amount: 1_000, created_at: "2026-11-01T06:00:00Z" }),
      fu("f-disp", "disp", { kind: "note", note: "Rate is wrong", outcome: "disputed" }),
      fu("f-nc", "nc", { kind: "note", note: "internal", next_follow_up_on: TODAY }),
    ],
    dunningSent: [{ invoice_id: "I-AUTO" }],
  }), TODAY);
  const by = (k: string) => rows.find((r) => r.customerId === k)!;

  it("one stage per row from the real data", () => {
    expect(by("nc").stage).toBe("notContacted");
    expect(by("rem").stage).toBe("reminded");
    expect(by("auto").stage).toBe("reminded");
    expect(by("part").stage).toBe("partPaid");
    expect(by("prom").stage).toBe("promised");
    expect(by("brk").stage).toBe("broken");
    expect(by("disp").stage).toBe("disputed");
    expect(by("disp").hold?.kind).toBe("dispute");
  });

  it("score = ₹ due × days late", () => {
    expect(by("nc").priorityScore).toBe(50_000 * 10);
    expect(by("rem").priorityScore).toBe(20_000 * 30);
    expect(by("part").priorityScore).toBe(20_000 * 33);
  });

  it("the list is built in Today's-work-first order: broken, then today (promise due / follow-up due), then by score", () => {
    const order = rows.map((r) => r.customerId);
    expect(order[0]).toBe("brk");
    expect(order.slice(1, 3)).toEqual(["nc", "prom"]);
    expect(order.slice(3)).toEqual(["part", "rem", "disp", "auto"]);
  });

  it("the Today view = follow-ups due + promises due today + broken promises, and its counts match", () => {
    const todayRows = filterCollectionRows(rows, "today", null);
    expect(todayRows.map((r) => r.customerId)).toEqual(["brk", "nc", "prom"]);
    expect(todayCounts(rows)).toEqual({ total: 3, followUps: 1, promisesToday: 1, broken: 1 });
  });
});
