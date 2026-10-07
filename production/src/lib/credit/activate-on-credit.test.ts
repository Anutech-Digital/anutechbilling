import { describe, it, expect, vi } from "vitest";
import {
  CREDIT_DEFAULT_DAYS, CREDIT_DEFAULT_LIMIT,
  defaultCreditDays, validCreditDays, effectiveCreditLimit,
  showActivateOnCredit, customerCreditEligibility, splitBillingCreditEligibility, hasRecurringLine, onTrial,
  owedOnInvoices, creditExposure, overLimitDecision,
  planCredit, creditTaskInstant, quoteCreditState, creditSummary,
  isMissingDbObject, activateQuoteOnCredit, NeedsDatabaseUpdateError,
  type CreditQuoteFacts, type OpenInvoice,
} from "./activate-on-credit";

const fmt = (n: number) => `₹${n}`;
// 7 Oct 2026, 11:00 IST
const NOW = new Date("2026-10-07T05:30:00Z");

const accepted: CreditQuoteFacts = {
  status: "accepted", payment_status: "awaiting", received: 0,
  line_items: [{ commitment: "annual_yearly" }],
};

describe("defaults", () => {
  it("credit days = customer terms, else 15 (due-on-receipt is not credit)", () => {
    expect(defaultCreditDays(30)).toBe(30);
    expect(defaultCreditDays(45)).toBe(45);
    expect(defaultCreditDays(null)).toBe(CREDIT_DEFAULT_DAYS);
    expect(defaultCreditDays(undefined)).toBe(15);
    expect(defaultCreditDays(0)).toBe(15);
  });
  it("valid days are whole 1–180", () => {
    expect(validCreditDays(1)).toBe(true);
    expect(validCreditDays(180)).toBe(true);
    expect(validCreditDays(0)).toBe(false);
    expect(validCreditDays(181)).toBe(false);
    expect(validCreditDays(2.5)).toBe(false);
  });
  it("empty limit = ₹50,000; 0 is a real limit", () => {
    expect(effectiveCreditLimit(null)).toBe(CREDIT_DEFAULT_LIMIT);
    expect(effectiveCreditLimit(undefined)).toBe(50_000);
    expect(effectiveCreditLimit(0)).toBe(0);
    expect(effectiveCreditLimit(200_000)).toBe(200_000);
  });
});

describe("who sees the button", () => {
  it("accepted + unpaid + recurring line → shown", () => {
    expect(showActivateOnCredit(accepted, null)).toBe(true);
  });
  it("trial quote → no button (running or ended unpaid); converted trial → shown", () => {
    expect(showActivateOnCredit(accepted, { trial_started_at: "2026-10-01T00:00:00Z", trial_converted_at: null })).toBe(false);
    expect(onTrial({ trial_started_at: "2026-10-01T00:00:00Z", trial_converted_at: "2026-10-05T00:00:00Z" })).toBe(false);
  });
  it("not accepted, money in, already on credit, one-off, add-seats or nothing recurring → hidden", () => {
    expect(showActivateOnCredit({ ...accepted, status: "sent" }, null)).toBe(false);
    expect(showActivateOnCredit({ ...accepted, received: 100 }, null)).toBe(false);
    expect(showActivateOnCredit({ ...accepted, payment_status: "partial" }, null)).toBe(false);
    expect(showActivateOnCredit({ ...accepted, credit_activated_at: "2026-10-07T05:00:00Z" }, null)).toBe(false);
    expect(showActivateOnCredit({ ...accepted, is_one_off: true }, null)).toBe(false);
    expect(showActivateOnCredit({ ...accepted, is_add_seats: true }, null)).toBe(false);
    expect(showActivateOnCredit({ ...accepted, line_items: [{ commitment: null }] }, null)).toBe(false);
  });
  it("an invoiced-but-unpaid accepted quote can still go on credit", () => {
    expect(showActivateOnCredit({ ...accepted, payment_status: "invoiced" }, null)).toBe(true);
  });
  it("monthly and any annual tier count as recurring", () => {
    expect(hasRecurringLine([{ commitment: "monthly" }])).toBe(true);
    expect(hasRecurringLine([{}, { commitment: "annual_monthly" }])).toBe(true);
    expect(hasRecurringLine([])).toBe(false);
  });
  it("Pay later off → a reason that names the fix", () => {
    const r = customerCreditEligibility({ name: "Acme", allow_pay_later: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Pay later is off for Acme/);
    expect(customerCreditEligibility({ name: "Acme", allow_pay_later: true }).ok).toBe(true);
    expect(customerCreditEligibility(null).ok).toBe(false);
  });
});

describe("credit limit", () => {
  const inv = (o: Partial<OpenInvoice>): OpenInvoice => ({ id: "I", status: "pending", amount: 0, net_payable: null, paid_amount: null, ...o });

  it("owed = net payable − paid, pending/overdue only", () => {
    expect(owedOnInvoices([
      inv({ amount: 20_000, paid_amount: 5_000 }),
      inv({ status: "overdue", amount: 10_000, net_payable: 9_000 }),
      inv({ status: "paid", amount: 99_999 }),
      inv({ status: "void", amount: 99_999 }),
    ])).toBe(15_000 + 9_000);
  });

  it("owed + this invoice above the limit → over", () => {
    const e = creditExposure({ openInvoices: [inv({ amount: 40_000 })], quoteAmount: 11_800, quoteInvoiceId: null, creditLimit: null });
    expect(e).toEqual({ owed: 40_000, thisInvoice: 11_800, total: 51_800, limit: 50_000, over: true });
  });

  it("exactly at the limit is allowed", () => {
    expect(creditExposure({ openInvoices: [], quoteAmount: 50_000, quoteInvoiceId: null, creditLimit: null }).over).toBe(false);
  });

  it("an invoice already raised on the quote is not counted twice", () => {
    const e = creditExposure({ openInvoices: [inv({ id: "INV-1", amount: 11_800 })], quoteAmount: 11_800, quoteInvoiceId: "INV-1", creditLimit: 12_000 });
    expect(e.thisInvoice).toBe(0);
    expect(e.total).toBe(11_800);
    expect(e.over).toBe(false);
  });

  it("over the limit: owner gets approve, everyone else a plain no with the numbers", () => {
    const e = creditExposure({ openInvoices: [], quoteAmount: 60_000, quoteInvoiceId: null, creditLimit: null });
    expect(overLimitDecision(e, "owner", fmt)).toEqual({ kind: "owner-approve" });
    for (const role of ["manager", "sales", "billing", null]) {
      const d = overLimitDecision(e, role, fmt);
      expect(d.kind).toBe("refused");
      if (d.kind === "refused") expect(d.reason).toBe("Over the credit limit: ₹0 already owed + ₹60000 this invoice = ₹60000, limit ₹50000. Only the owner can approve this.");
    }
    const within = creditExposure({ openInvoices: [], quoteAmount: 1_000, quoteInvoiceId: null, creditLimit: null });
    expect(overLimitDecision(within, "sales", fmt)).toEqual({ kind: "within" });
  });
});

describe("plan (same dates the database writes)", () => {
  it("due = today + days; link task due − 3; stop task due + 15", () => {
    const p = planCredit(NOW, 15);
    expect(p.dueDate).toBe("2026-10-22");
    expect(p.tasks.map((t) => t.day)).toEqual(["2026-10-07", "2026-10-19", "2026-11-06"]);
    expect(p.tasks[0].title).toBe("Set up seats (DNS, users)");
    expect(p.tasks[1].title).toBe("Credit: send payment link");
    expect(p.tasks[2].title).toBe("Credit: payment not in — stop service?");
  });
  it("short credit: the link task is never before today", () => {
    expect(planCredit(NOW, 2).tasks[1].day).toBe("2026-10-07");
  });
  it("uses the IST day, not UTC (23:00 IST is still the same day)", () => {
    expect(planCredit(new Date("2026-10-07T17:30:00Z"), 15).dueDate).toBe("2026-10-22");
    expect(planCredit(new Date("2026-10-07T18:31:00Z"), 15).dueDate).toBe("2026-10-23");
  });
  it("tasks fall at 10:00 IST", () => {
    expect(creditTaskInstant("2026-10-19").toISOString()).toBe("2026-10-19T04:30:00.000Z");
  });
  it("rejects bad days", () => {
    expect(() => planCredit(NOW, 0)).toThrow();
  });
});

describe("quote banner", () => {
  const onCredit = { credit_activated_at: "2026-10-07T05:30:00Z", credit_due_date: "2026-10-22" };
  const invoice = { id: "INV-1", status: "pending", amount: 11_800, net_payable: 11_800, paid_amount: 1_800, due_date: "2026-10-22" };
  it("due: amount left and days left", () => {
    expect(quoteCreditState(onCredit, invoice, NOW)).toEqual({ kind: "due", amountDue: 10_000, dueDate: "2026-10-22", daysLeft: 15 });
  });
  it("overdue: days late", () => {
    expect(quoteCreditState(onCredit, invoice, new Date("2026-10-25T05:00:00Z"))).toEqual({ kind: "overdue", amountDue: 10_000, dueDate: "2026-10-22", daysLate: 3 });
  });
  it("paid → paid; not on credit → null", () => {
    expect(quoteCreditState(onCredit, { ...invoice, status: "paid" }, NOW)).toEqual({ kind: "paid" });
    expect(quoteCreditState({ credit_activated_at: null }, invoice, NOW)).toBeNull();
    expect(quoteCreditState({}, invoice, NOW)).toBeNull();
  });
});

describe("receivables summary", () => {
  it("counts active subscriptions of credit quotes whose invoice is unpaid, and the ₹ due", () => {
    const s = creditSummary(
      [{ id: "Q1", invoice_id: "I1" }, { id: "Q2", invoice_id: "I2" }, { id: "Q3", invoice_id: null }],
      [
        { id: "I1", status: "pending", amount: 12_390, net_payable: 12_390, paid_amount: 0 },
        { id: "I2", status: "paid", amount: 5_000, net_payable: 5_000, paid_amount: 5_000 },
      ],
      [
        { quote_id: "Q1", status: "active" }, { quote_id: "Q1", status: "active" },
        { quote_id: "Q1", status: "cancelled" }, { quote_id: "Q2", status: "active" },
      ],
    );
    expect(s).toEqual({ subscriptions: 2, amountDue: 12_390 });
  });
});

describe("database not updated yet", () => {
  it("recognises PostgREST's missing function / column", () => {
    expect(isMissingDbObject({ code: "PGRST202", message: "Could not find the function public.activate_quote_on_credit" })).toBe(true);
    expect(isMissingDbObject({ code: "42703", message: "column quotes.credit_activated_at does not exist" })).toBe(true);
    expect(isMissingDbObject({ code: "P0001", message: "Over the credit limit" })).toBe(false);
    expect(isMissingDbObject(null)).toBe(false);
  });

  it("the writer turns it into a 'needs a database update' error, not a crash", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }));
    await expect(activateQuoteOnCredit({ rpc } as never, { quoteId: "Q1", days: 15, approveOverLimit: false }))
      .rejects.toBeInstanceOf(NeedsDatabaseUpdateError);
  });

  it("passes the database's own refusal through word for word", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "42501", message: "Over the credit limit: … Only the owner can approve this." } }));
    await expect(activateQuoteOnCredit({ rpc } as never, { quoteId: "Q1", days: 15, approveOverLimit: false }))
      .rejects.toThrow("Only the owner can approve this.");
  });

  it("calls the one RPC with the days and the approval, and maps the result", async () => {
    const rpc = vi.fn(async () => ({
      data: { already_active: false, invoice_id: "INV-1", due_date: "2026-10-22", amount_due: 12390, subscriptions_created: 2, tasks_created: 3, over_limit: false },
      error: null,
    }));
    const r = await activateQuoteOnCredit({ rpc } as never, { quoteId: "Q1", days: 15, approveOverLimit: true });
    expect(rpc).toHaveBeenCalledWith("activate_quote_on_credit", { p_quote_id: "Q1", p_credit_days: 15, p_approve_over_limit: true });
    expect(r).toEqual({ alreadyActive: false, invoiceId: "INV-1", dueDate: "2026-10-22", amountDue: 12390, subscriptionsCreated: 2, tasksCreated: 3, overLimit: false });
  });

  it("refuses bad days before calling the database", async () => {
    const rpc = vi.fn();
    await expect(activateQuoteOnCredit({ rpc } as never, { quoteId: "Q1", days: 0, approveOverLimit: false })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});

// R-370 (P0 money): credit invoice + instalment invoices = billed twice. Refused, with the reason.
describe("splitBillingCreditEligibility", () => {
  const MSG = /^This quote is billed in instalments \((monthly|quarterly|half-yearly)\) — record the first instalment instead, or switch billing to yearly\.$/;

  it.each(["quarterly", "half_yearly", "monthly"])("%s is refused with the reason", (cycle) => {
    const r = splitBillingCreditEligibility(cycle);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(MSG);
      expect(r.reason).toContain(cycle.replace("_", "-"));
    }
  });

  it.each(["yearly", null, undefined, ""])("%s is allowed (one invoice for the term)", (cycle) => {
    expect(splitBillingCreditEligibility(cycle)).toEqual({ ok: true });
  });

  it("keeps the menu item visible for a split-billed quote, so the reason can be shown", () => {
    // showActivateOnCredit does not look at billing_cycle; the click explains the refusal.
    expect(showActivateOnCredit(accepted, null)).toBe(true);
  });
});
