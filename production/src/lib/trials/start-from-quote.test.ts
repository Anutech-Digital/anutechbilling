import { describe, it, expect, vi } from "vitest";
import {
  quoteTrialEligibility, defaultTrialUsers, trialUsersWarning, planQuoteTrial, quoteTrialState,
  withTrialStep, startTrialFromQuote, QUOTE_TRIAL_DAYS, GOOGLE_TRIAL_MAX_USERS, TRIAL_TASK_PREFIX,
} from "./start-from-quote";
import { quoteLifecycle } from "@/lib/quotes/lifecycle";

const noTrial = { trial_started_at: null, trial_expires_at: null, trial_converted_at: null, trial_expired_at: null };
// 7 Oct 2026 06:36 IST
const NOW = new Date("2026-10-07T01:06:00Z");

describe("quoteTrialEligibility — accepted + unpaid only", () => {
  it("allows an accepted quote with nothing received", () => {
    expect(quoteTrialEligibility({ status: "accepted", payment_status: "awaiting", received: 0 }, noTrial, NOW)).toEqual({ ok: true });
  });
  it("refuses a draft and a sent quote", () => {
    for (const status of ["draft", "sent", "viewed"] as const) {
      const r = quoteTrialEligibility({ status, payment_status: "none", received: 0 }, noTrial, NOW);
      expect(r.ok).toBe(false);
    }
  });
  it("refuses a paid or part-paid quote", () => {
    expect(quoteTrialEligibility({ status: "accepted", payment_status: "received", received: 38232 }, noTrial, NOW).ok).toBe(false);
    expect(quoteTrialEligibility({ status: "accepted", payment_status: "partial", received: 1000 }, noTrial, NOW).ok).toBe(false);
    // payment_status lags, money does not
    expect(quoteTrialEligibility({ status: "accepted", payment_status: "awaiting", received: 1 }, noTrial, NOW).ok).toBe(false);
  });
  it("refuses a closed quote", () => {
    expect(quoteTrialEligibility({ status: "rejected", payment_status: "none", received: 0 }, noTrial, NOW).ok).toBe(false);
  });
  it("refuses a second trial while one is running", () => {
    const lead = { ...noTrial, trial_started_at: "2026-10-05T05:00:00Z", trial_expires_at: "2026-10-19T18:29:59.999Z" };
    const r = quoteTrialEligibility({ status: "accepted", payment_status: "awaiting", received: 0 }, lead, NOW);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("19 Oct 2026") });
  });
});

describe("users: quote seats, max 10, warning above", () => {
  it("defaults to the quote's seats, capped at 10", () => {
    expect(defaultTrialUsers(3)).toBe(3);
    expect(defaultTrialUsers(25)).toBe(GOOGLE_TRIAL_MAX_USERS);
    expect(defaultTrialUsers(null)).toBe(10);
  });
  it("warns above 10, silent at 10", () => {
    expect(trialUsersWarning(10)).toBeNull();
    expect(trialUsersWarning(11)).toMatch(/at most 10 users/);
  });
});

describe("planQuoteTrial — 14 days, IST dates, 3 tasks", () => {
  const plan = planQuoteTrial({ now: NOW, days: QUOTE_TRIAL_DAYS, users: 10, company: "Acme", quoteId: "Q-FBB9-27-0009" });

  it("starts today (IST) and ends 14 days later, covering the whole last IST day", () => {
    expect(plan.startDate).toBe("2026-10-07");
    expect(plan.endDate).toBe("2026-10-21");
    expect(plan.trialStartedAt).toBe(NOW.toISOString());
    expect(plan.trialExpiresAt).toBe("2026-10-21T18:29:59.999Z"); // 23:59:59.999 IST
  });

  it("uses the IST day, not the UTC day, near midnight", () => {
    // 23:00 UTC on 6 Oct is 04:30 IST on 7 Oct
    const p = planQuoteTrial({ now: new Date("2026-10-06T23:00:00Z"), days: 14, users: 5, company: "A", quoteId: "Q" });
    expect(p.startDate).toBe("2026-10-07");
    expect(p.endDate).toBe("2026-10-21");
  });

  it("schedules day 1, end−4 and end day at 10:00 IST", () => {
    expect(plan.tasks.map((t) => t.due_at)).toEqual([
      "2026-10-07T04:30:00.000Z",
      "2026-10-17T04:30:00.000Z",
      "2026-10-21T04:30:00.000Z",
    ]);
  });

  it("day-1 task is due now, not in the past, when started after 10:00 IST", () => {
    const late = new Date("2026-10-07T09:30:00Z"); // 15:00 IST
    const p = planQuoteTrial({ now: late, days: 14, users: 2, company: "A", quoteId: "Q" });
    expect(p.tasks[0].due_at).toBe(late.toISOString());
  });

  it("a short trial never puts the payment-link task before day 1", () => {
    const p = planQuoteTrial({ now: NOW, days: 2, users: 2, company: "A", quoteId: "Q" });
    const due = p.tasks.map((t) => Date.parse(t.due_at));
    expect(due[1]).toBeGreaterThanOrEqual(due[0]);
    expect(due[2]).toBeGreaterThanOrEqual(due[1]);
  });

  it("every task is a reminder only — titled for the payment trigger, promising no auto message or suspension", () => {
    for (const t of plan.tasks) expect(t.title.startsWith(TRIAL_TASK_PREFIX)).toBe(true);
    expect(plan.tasks[1].notes).toMatch(/nothing is sent to the customer automatically/i);
    expect(plan.tasks[2].notes).toMatch(/nothing is suspended automatically/i);
    expect(plan.tasks[2].title).toMatch(/extend, stop or convert/);
  });

  it("refuses an out-of-range length", () => {
    expect(() => planQuoteTrial({ now: NOW, days: 0, users: 1, company: "A", quoteId: "Q" })).toThrow();
    expect(() => planQuoteTrial({ now: NOW, days: 31, users: 1, company: "A", quoteId: "Q" })).toThrow();
  });
});

describe("quoteTrialState", () => {
  const lead = { ...noTrial, trial_started_at: NOW.toISOString(), trial_expires_at: "2026-10-21T18:29:59.999Z" };
  it("counts IST days left", () => {
    expect(quoteTrialState(lead, NOW)).toEqual({ kind: "running", endDate: "2026-10-21", daysLeft: 14 });
    expect(quoteTrialState(lead, new Date("2026-10-21T17:00:00Z"))).toMatchObject({ kind: "running", daysLeft: 0 });
  });
  it("ended after the last IST day", () => {
    expect(quoteTrialState(lead, new Date("2026-10-23T05:00:00Z"))).toMatchObject({ kind: "ended", daysPast: 2 });
  });
  it("converted once trial_converted_at is set", () => {
    expect(quoteTrialState({ ...lead, trial_converted_at: "2026-10-10T05:00:00Z" }, NOW)?.kind).toBe("converted");
  });
});

describe("withTrialStep — TRIAL between SIGNED and PAID", () => {
  const base = quoteLifecycle({ status: "accepted", paymentStatus: "awaiting", invoiceId: null, hasSignature: false, provisionStatus: "pending", paid: false });
  const lead = { ...noTrial, trial_started_at: NOW.toISOString(), trial_expires_at: "2026-10-21T18:29:59.999Z" };

  it("inserts a current TRIAL step with days left, and Paid stops being current", () => {
    const steps = withTrialStep(base.steps, lead, "accepted", NOW);
    expect(steps.map((s) => s.stage)).toEqual(["draft", "sent", "signed", "trial", "paid", "provisioned", "invoiced"]);
    const trial = steps[3];
    expect(trial.label).toBe("Trial · 14 days left");
    expect(trial.state).toBe("current");
    expect(trial.detail).toMatch(/payment due/);
    expect(steps.filter((s) => s.state === "current")).toHaveLength(1);
    expect(steps[4].state).toBe("todo");
  });

  it("leaves the steps alone when the lead has no trial", () => {
    expect(withTrialStep(base.steps, noTrial, "accepted", NOW)).toBe(base.steps);
    expect(withTrialStep(base.steps, null, "accepted", NOW)).toBe(base.steps);
  });

  it("shows a done TRIAL once the quote is paid", () => {
    const paid = quoteLifecycle({ status: "accepted", paymentStatus: "received", invoiceId: null, hasSignature: false, provisionStatus: "pending", paid: true });
    const steps = withTrialStep(paid.steps, { ...lead, trial_converted_at: "2026-10-10T05:00:00Z" }, "accepted", NOW);
    expect(steps[3]).toMatchObject({ stage: "trial", state: "done" });
  });
});

describe("startTrialFromQuote — writes the lead + 3 tasks, never the quote's status or amount", () => {
  function fakeSupabase() {
    const calls: { table: string; op: string; payload: unknown }[] = [];
    const chain = (table: string, op: string, payload: unknown) => {
      calls.push({ table, op, payload });
      const result = { error: null };
      const c: Record<string, unknown> = { eq: () => c, then: (r: (v: typeof result) => unknown) => Promise.resolve(result).then(r) };
      return c;
    };
    const client = {
      from: (table: string) => ({
        update: (p: unknown) => chain(table, "update", p),
        insert: (p: unknown) => chain(table, "insert", p),
      }),
    };
    return { client, calls };
  }

  it("existing lead → stage trial with dates; three tasks for the owner on the lead and quote", async () => {
    const { client, calls } = fakeSupabase();
    const res = await startTrialFromQuote(client as never, {
      quote: { id: "Q-1", tenant_id: "t1", lead_id: "L-1", customer_id: "c1", customer_name: "Acme", domain: "acme.in" },
      lead: { id: "L-1", notes: "old" },
      days: 14, users: 10, ownerId: "u1", now: NOW,
    });
    expect(res).toEqual({ leadId: "L-1", endDate: "2026-10-21", tasksCreated: 3 });
    const leadUpd = calls.find((c) => c.table === "leads")!.payload as Record<string, unknown>;
    expect(leadUpd).toMatchObject({ stage: "trial", trial_expires_at: "2026-10-21T18:29:59.999Z", trial_converted_at: null });
    expect(String(leadUpd.notes)).toMatch(/^old\nTRIAL from quote Q-1/);
    expect(calls.some((c) => c.table === "quotes")).toBe(false);
    const tasks = calls.find((c) => c.table === "tasks")!.payload as Record<string, unknown>[];
    expect(tasks).toHaveLength(3);
    for (const t of tasks) {
      expect(t).toMatchObject({ tenant_id: "t1", lead_id: "L-1", owner_id: "u1" });
      // tasks_one_link_only: a task may link ONE of lead/quote/customer/subscription
      expect(t).not.toHaveProperty("quote_id");
      expect(String(t.notes)).toContain("Q-1");
    }
  });

  it("quote with no lead → a lead is created for the customer and only lead_id is set on the quote", async () => {
    const { client, calls } = fakeSupabase();
    const res = await startTrialFromQuote(client as never, {
      quote: { id: "Q-2", tenant_id: "t1", lead_id: null, customer_id: "c1", customer_name: "Acme", domain: null },
      lead: null,
      customer: { contact_name: "Raj", contact_email: "raj@acme.in", contact_phone: null, domain: "acme.in" },
      days: 14, users: 4, ownerId: "u1", now: NOW,
    });
    expect(res.leadId).toMatch(/^L-/);
    expect(calls.find((c) => c.table === "leads" && c.op === "insert")!.payload).toMatchObject({ customer_id: "c1", stage: "trial", domain: "acme.in" });
    expect(calls.find((c) => c.table === "quotes")!.payload).toEqual({ lead_id: res.leadId });
  });

  it("throws when the lead write fails, before any task is written", async () => {
    const client = {
      from: vi.fn((table: string) => ({
        update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: { message: "rls" } }) }) }),
        insert: () => { throw new Error(`should not insert into ${table}`); },
      })),
    };
    await expect(startTrialFromQuote(client as never, {
      quote: { id: "Q-1", tenant_id: "t1", lead_id: "L-1", customer_id: "c1", customer_name: "Acme", domain: null },
      lead: { id: "L-1", notes: null }, days: 14, users: 10, ownerId: "u1", now: NOW,
    })).rejects.toThrow(/lead could not be updated/);
  });
});
