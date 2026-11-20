import { describe, it, expect, vi } from "vitest";
import {
  CREDIT_DEFAULT_DAYS, CREDIT_DEFAULT_LIMIT,
  defaultCreditDays, validCreditDays, effectiveCreditLimit,
  showActivateOnCredit, customerCreditEligibility, splitBillingCreditEligibility, hasRecurringLine, onTrial,
  owedOnInvoices, creditExposure, overLimitDecision,
  planCredit, creditTaskInstant, quoteCreditState, creditSummary,
  isMissingDbObject, activateQuoteOnCredit, NeedsDatabaseUpdateError,
  maxCreditDays, CREDIT_MAX_DAYS, CREDIT_MAX_DAYS_NO_INVOICE,
  uninvoicedCreditDues, issueInvoiceTaskDay, CREDIT_ISSUE_INVOICE_TASK, CREDIT_TASK_PREFIX,
  type CreditQuoteFacts, type OpenInvoice, type UninvoicedCreditQuote,
} from "./activate-on-credit";
import { fetchUninvoicedCreditDues } from "./queries";

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
    // R-2950: all five arguments, always — the flag says "with the GST invoice" unless the caller leaves it out.
    expect(rpc).toHaveBeenCalledWith("activate_quote_on_credit", {
      p_quote_id: "Q1", p_credit_days: 15, p_approve_over_limit: true, p_annual_override_reason: null, p_issue_invoice: true,
    });
    expect(r).toEqual({ alreadyActive: false, invoiceId: "INV-1", dueDate: "2026-10-22", amountDue: 12390, subscriptionsCreated: 2, tasksCreated: 3, overLimit: false });
  });

  it("refuses bad days before calling the database", async () => {
    const rpc = vi.fn();
    await expect(activateQuoteOnCredit({ rpc } as never, { quoteId: "Q1", days: 0, approveOverLimit: false })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});

// R-2950: the same RPC can leave the GST invoice out. Nothing changes unless the caller says so.
describe("activateQuoteOnCredit — issueInvoice (R-2950)", () => {
  const ok = (data: Record<string, unknown>) => vi.fn(async () => ({ data, error: null }));
  const WITH_INVOICE = { already_active: false, invoice_id: "INV-1", due_date: "2026-10-22", amount_due: 590, subscriptions_created: 1, tasks_created: 3, over_limit: false };
  const NO_INVOICE = { ...WITH_INVOICE, invoice_id: null };

  it("left out or true → p_issue_invoice: true is sent (the invoice is raised, as before)", async () => {
    for (const issueInvoice of [undefined, true]) {
      const rpc = ok(WITH_INVOICE);
      const r = await activateQuoteOnCredit({ rpc } as never, { quoteId: "Q1", days: 15, approveOverLimit: false, issueInvoice });
      expect(rpc).toHaveBeenCalledWith("activate_quote_on_credit", {
        p_quote_id: "Q1", p_credit_days: 15, p_approve_over_limit: false, p_annual_override_reason: null, p_issue_invoice: true,
      });
      expect(r.invoiceId).toBe("INV-1");
    }
  });

  it("false → p_issue_invoice: false is sent, and the result has no invoice", async () => {
    const rpc = ok(NO_INVOICE);
    const r = await activateQuoteOnCredit({ rpc } as never, { quoteId: "Q1", days: 15, approveOverLimit: false, annualOverrideReason: " Known customer ", issueInvoice: false });
    expect(rpc).toHaveBeenCalledWith("activate_quote_on_credit", {
      p_quote_id: "Q1", p_credit_days: 15, p_approve_over_limit: false, p_annual_override_reason: "Known customer", p_issue_invoice: false,
    });
    expect(r).toEqual({ alreadyActive: false, invoiceId: null, dueDate: "2026-10-22", amountDue: 590, subscriptionsCreated: 1, tasksCreated: 3, overLimit: false });
  });

  it("without the invoice at most 30 credit days — refused before the database is called", async () => {
    expect(maxCreditDays(true)).toBe(CREDIT_MAX_DAYS);
    expect(maxCreditDays(false)).toBe(CREDIT_MAX_DAYS_NO_INVOICE);
    expect(CREDIT_MAX_DAYS_NO_INVOICE).toBe(30);
    const rpc = ok(NO_INVOICE);
    await expect(activateQuoteOnCredit({ rpc } as never, { quoteId: "Q1", days: 31, approveOverLimit: false, issueInvoice: false }))
      .rejects.toThrow("Without a GST invoice, credit days can be 1–30. For longer credit, issue the GST invoice now.");
    expect(rpc).not.toHaveBeenCalled();
    await activateQuoteOnCredit({ rpc } as never, { quoteId: "Q1", days: 30, approveOverLimit: false, issueInvoice: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    // With the invoice 31–180 days stay allowed.
    await activateQuoteOnCredit({ rpc } as never, { quoteId: "Q1", days: 180, approveOverLimit: false, issueInvoice: true });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("every call names all five arguments — a request that leaves one out matches neither function", async () => {
    const rpc = ok(WITH_INVOICE);
    for (const input of [
      { quoteId: "Q1", days: 15, approveOverLimit: false },
      { quoteId: "Q1", days: 15, approveOverLimit: true, annualOverrideReason: "   " },
      { quoteId: "Q1", days: 15, approveOverLimit: false, annualOverrideReason: "Known customer", issueInvoice: false },
    ]) {
      await activateQuoteOnCredit({ rpc } as never, input);
      const args = (rpc.mock.calls.at(-1) as unknown as [string, Record<string, unknown>])[1];
      expect(Object.keys(args).sort()).toEqual(["p_annual_override_reason", "p_approve_over_limit", "p_credit_days", "p_issue_invoice", "p_quote_id"]);
      expect(typeof args.p_issue_invoice).toBe("boolean");
    }
  });

  it("a database without the new function → 'needs a database update', never a silent invoice", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.activate_quote_on_credit(p_approve_over_limit, p_credit_days, p_issue_invoice, p_quote_id) in the schema cache" },
    }));
    await expect(activateQuoteOnCredit({ rpc } as never, { quoteId: "Q1", days: 15, approveOverLimit: false, issueInvoice: false }))
      .rejects.toBeInstanceOf(NeedsDatabaseUpdateError);
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

describe("R-2951 — no-invoice activations count, four tasks", () => {
  const q = (id: string, over: Partial<UninvoicedCreditQuote> = {}): UninvoicedCreditQuote => ({
    id, invoice_id: null, credit_activated_at: "2026-10-07T05:30:00Z", subscription_billing_id: null,
    amount: 5900, payment_status: "awaiting", cancelled_at: null, ...over,
  });

  it("an activated quote without an invoice counts quote amount − received payments", () => {
    const rows = uninvoicedCreditDues(
      [q("Q-1"), q("Q-2", { payment_status: "partial" })],
      [
        { quote_id: "Q-2", amount: 1500 }, // part-paid: only the rest
        { quote_id: "Q-2", amount: 500 },
      ],
    );
    expect(rows).toEqual([
      { id: "quote:Q-1", status: "pending", amount: 5900, net_payable: null, paid_amount: 0 },
      { id: "quote:Q-2", status: "pending", amount: 3900, net_payable: null, paid_amount: 0 },
    ]);
    expect(owedOnInvoices(rows)).toBe(9800);
  });

  it("a bulk-first quote paid in full counts 0 (its subscriptions' outstanding is never lowered)", () => {
    // Paid in full: status received → skipped; also the sum itself is 0.
    expect(uninvoicedCreditDues([q("Q-B", { amount: 5664, payment_status: "received" })], [{ quote_id: "Q-B", amount: 5664 }])).toEqual([]);
    expect(uninvoicedCreditDues([q("Q-B", { amount: 5664 })], [{ quote_id: "Q-B", amount: 5664 }])).toEqual([]);
    // Part-paid bulk: only the rest.
    expect(uninvoicedCreditDues([q("Q-B", { amount: 5664, payment_status: "partial" })], [{ quote_id: "Q-B", amount: 2000 }]))
      .toEqual([{ id: "quote:Q-B", status: "pending", amount: 3664, net_payable: null, paid_amount: 0 }]);
  });

  it("never counts a quote twice or one that owes nothing: invoiced, not on credit, part request, cancelled, paid", () => {
    const rows = uninvoicedCreditDues(
      [
        q("Q-INV", { invoice_id: "INV-1" }),           // the invoice counts instead
        q("Q-NOT", { credit_activated_at: null }),     // not activated on credit
        q("Q-PART", { subscription_billing_id: "b1" }), // in open_part_requests already
        q("Q-CAN", { cancelled_at: "2026-10-08T05:30:00Z" }), // cancelled owes nothing
        q("Q-PAID", { payment_status: "received" }),
        q("Q-OVER"),                                    // overpaid → 0, never negative
      ],
      [{ quote_id: "Q-OVER", amount: 6000 }],
    );
    expect(rows).toEqual([]);
  });

  it("screen = database: second activation of Rs 5,900 after a first of Rs 5,900 on a Rs 10,000 limit", () => {
    const openInvoices = uninvoicedCreditDues([q("Q-1")], []);
    const e = creditExposure({ openInvoices, quoteAmount: 5900, quoteInvoiceId: null, creditLimit: 10_000 });
    expect(e).toEqual({ owed: 5900, thisInvoice: 5900, total: 11_800, limit: 10_000, over: true });
    expect(overLimitDecision(e, "owner", fmt)).toEqual({ kind: "owner-approve" });
    const refused = overLimitDecision(e, "sales", fmt, false);
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.reason).toContain("₹5900 this quote = ₹11800");
      expect(refused.reason).not.toMatch(/invoice/i);
    }
    const withInvoice = overLimitDecision(e, "sales", fmt);
    if (withInvoice.kind === "refused") expect(withInvoice.reason).toContain("this invoice");
  });

  it("issue-invoice task: the earlier of the due date and activation + 30 days", () => {
    expect(issueInvoiceTaskDay("2026-10-07", "2026-10-22")).toBe("2026-10-22"); // 15 days → due
    expect(issueInvoiceTaskDay("2026-10-07", "2026-11-05")).toBe("2026-11-05"); // 29 days → due
    expect(issueInvoiceTaskDay("2026-10-07", "2026-11-06")).toBe("2026-11-06"); // 30 days → both
    expect(issueInvoiceTaskDay("2026-10-07", "2026-11-07")).toBe("2026-11-06"); // 31+ (not allowed today) → +30
    expect(issueInvoiceTaskDay("2026-10-07", "2027-04-05")).toBe("2026-11-06");
  });

  it("planCredit without an invoice: four tasks, the fourth on the due date; at most 30 days", () => {
    const p = planCredit(NOW, 15, false);
    expect(p.dueDate).toBe("2026-10-22");
    expect(p.tasks).toEqual([
      { title: "Set up seats (DNS, users)", day: "2026-10-07" },
      { title: `${CREDIT_TASK_PREFIX} send payment link`, day: "2026-10-19" },
      { title: `${CREDIT_TASK_PREFIX} payment not in — stop service?`, day: "2026-11-06" },
      { title: "Credit: due date reached — issue the GST invoice", day: "2026-10-22" },
    ]);
    expect(CREDIT_ISSUE_INVOICE_TASK.startsWith(CREDIT_TASK_PREFIX)).toBe(true);
    expect(planCredit(NOW, 30, false).tasks[3].day).toBe("2026-11-06");
    expect(() => planCredit(NOW, 31, false)).toThrow("Credit days must be 1–30.");
    // With the invoice: three tasks and up to 180 days, as before.
    expect(planCredit(NOW, 15).tasks).toHaveLength(3);
    expect(planCredit(NOW, 15, true).tasks).toHaveLength(3);
    expect(planCredit(NOW, 180).dueDate).toBe("2027-04-05");
  });
});

describe("fetchUninvoicedCreditDues (R-2951)", () => {
  function fakeSupabase(quotes: unknown, subs: unknown, quotesError: unknown = null) {
    const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
    const make = (table: string) => {
      const rec = { table, ops: [] as Array<[string, unknown[]]> };
      calls.push(rec);
      const result = table === "quotes" ? { data: quotes, error: quotesError } : { data: subs, error: null };
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "not", "is", "in"]) {
        chain[op] = (...args: unknown[]) => { rec.ops.push([op, args]); return chain; };
      }
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
      return chain;
    };
    return { client: { from: (t: string) => make(t) } as never, calls };
  }

  it("reads the customer's activated, uninvoiced, open quotes and their received payments", async () => {
    const { client, calls } = fakeSupabase(
      [{ id: "Q-1", invoice_id: null, credit_activated_at: "2026-10-07T05:30:00Z", subscription_billing_id: null,
         amount: 5900, payment_status: "partial", cancelled_at: null }],
      [{ quote_id: "Q-1", amount: 2000 }],
    );
    const rows = await fetchUninvoicedCreditDues(client, "cust-1");
    expect(rows).toEqual([{ id: "quote:Q-1", status: "pending", amount: 3900, net_payable: null, paid_amount: 0 }]);
    expect(calls[0].table).toBe("quotes");
    expect(calls[0].ops).toEqual(expect.arrayContaining([
      ["eq", ["customer_id", "cust-1"]],
      ["not", ["credit_activated_at", "is", null]],
      ["is", ["invoice_id", null]],
      ["is", ["subscription_billing_id", null]],
      ["is", ["cancelled_at", null]],
    ]));
    expect(calls[1].table).toBe("payments");
    expect(calls[1].ops).toEqual(expect.arrayContaining([["in", ["quote_id", ["Q-1"]]], ["eq", ["status", "received"]]]));
  });

  it("a database without the credit columns gives [] (the screen shows invoices only)", async () => {
    const { client } = fakeSupabase(null, null, { code: "42703", message: "column quotes.credit_activated_at does not exist" });
    expect(await fetchUninvoicedCreditDues(client, "cust-1")).toEqual([]);
  });
});
