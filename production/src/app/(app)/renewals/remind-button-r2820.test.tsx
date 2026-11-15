// @vitest-environment jsdom
/**
 * R-2820 — Renewals 12-question audit, 14 Nov: the header button read "Remind 9 in Overdue" and opened
 * "No reminder to send — skipped 9" (4 billed in parts, 5 past the date and grace). The button promised
 * 9 and sent 0. Now its count is the rows it can REALLY email (reminders.ts reminderPlan — the R-2753
 * plan the dialog uses, one way), the label names the open view, and at 0 it is greyed with the reason.
 * The dialog's skipped list names the product next to the customer (five "CT R2737 Renewals Pvt Ltd"
 * rows told nothing apart).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { RenewalRemindButton, RenewalReminderDialog } from "./reminder-dialog";
import { reminderButton, reminderPlan, reminderScope, REMINDER_SKIP, type RenewalRowLike, type RenewalSubLike } from "./reminders";

afterEach(cleanup);

const TODAY = new Date("2026-11-14T06:30:00Z"); // 12:00 IST
const d = (n: number) => new Date(Date.UTC(2026, 10, 14 + n)).toISOString().slice(0, 10);
const row = (id: string, daysUntil: number, p: Partial<RenewalSubLike> = {}): RenewalRowLike => ({
  sub: { id, customer_name: id, renewal_date: d(daysUntil), renewal_state: "pending", term_months: 12, billing_cycle: "yearly", auto_renew: true, ...p },
  daysUntil,
});
const emailOf = (r: RenewalRowLike) => `${r.sub.id}@x.in`;

/** The audit's Overdue tab: 5 past the date and grace + 4 billed in parts. */
const OVERDUE = [
  ...[1, 2, 3, 4, 5].map((i) => row(`Late ${i}`, -10 - i)),
  ...[1, 2, 3, 4].map((i) => row(`Split ${i}`, -2 - i, { billing_cycle: "quarterly" })),
];

describe("R-2820 reminderButton: counts only rows it can send, names the view, reason at 0", () => {
  it("Overdue tab with nothing sendable → 'Remind 0 · 9 need a call or part bill', disabled, reasons spelt out", () => {
    const plan = reminderPlan(OVERDUE, { today: TODAY, tenantGraceDays: 0, emailOf });
    const b = reminderButton(reminderScope(0, "Overdue", OVERDUE.length), plan);
    expect(b.label).toBe("Remind 0 · 9 need a call or part bill");
    expect(b.disabled).toBe(true);
    expect(b.reason).toContain(`5 ${REMINDER_SKIP.pastGrace}`);
    expect(b.reason).toContain(`4 ${REMINDER_SKIP.split}`);
  });

  it("a view with some sendable rows counts only those and names the view", () => {
    const rows = [row("Due A", 3), row("Due B", 12), row("Late", -20)];
    const plan = reminderPlan(rows, { today: TODAY, tenantGraceDays: 0, emailOf });
    const b = reminderButton(reminderScope(0, "8–30", rows.length), plan);
    expect(b.label).toBe("Remind 2 in 8–30");
    expect(b.disabled).toBe(false);
    expect(b.reason).toContain(`1 ${REMINDER_SKIP.pastGrace}`);
  });

  it("a tab label reads 'in <tab>'; ticked rows read 'of N selected' when some can't go", () => {
    const rows = [row("Due A", 3), row("Wont", 5, { auto_renew: false })];
    const plan = reminderPlan(rows, { today: TODAY, emailOf });
    expect(reminderButton(reminderScope(0, "≤7 days", 2), plan).label).toBe("Remind 1 in ≤7 days");
    expect(reminderButton(reminderScope(2, "≤7 days", 2), plan).label).toBe("Remind 1 of 2 selected");
    const all = reminderPlan([row("Due A", 3)], { today: TODAY, emailOf });
    expect(reminderButton(reminderScope(1, "≤7 days", 2), all).label).toBe("Remind 1 selected");
    /* a pressed Due tile reads as words, not "Remind 1 Due in 30 days" (localhost check) */
    expect(reminderButton(reminderScope(0, "Due in 30 days", 1), all).label).toBe("Remind 1 due in 30 days");
    expect(reminderButton(reminderScope(0, "Due in 61–90 days", 0), { send: [], skipped: [] }).label).toBe("Remind 0 due in 61–90 days");
  });

  it("one reason only → that reason; mixed non-call reasons → 'not due a reminder'; singular grammar", () => {
    const renewed = reminderPlan([row("R", 5, { renewal_state: "suspended" })], { today: TODAY, emailOf });
    expect(reminderButton(reminderScope(0, "Won't renew", 1), renewed).label).toBe("Remind 0 · 1 stopped");
    const one = reminderPlan([row("Late", -20)], { today: TODAY, emailOf });
    expect(reminderButton(reminderScope(0, "Overdue", 1), one).label).toBe("Remind 0 · 1 needs a call");
    const mixed = reminderPlan([row("Later", 45), row("Wont", 5, { auto_renew: false })], { today: TODAY, emailOf });
    expect(reminderButton(reminderScope(0, "Won't renew", 2), mixed).label).toBe("Remind 0 · 2 not due a reminder");
    /* a mix with rows that ARE due but blocked (no email) never says "not due" */
    const blocked = reminderPlan([row("NoMail", 3), row("Later", 45)], { today: TODAY, emailOf: (r) => (r.sub.id === "NoMail" ? null : "x@y.in") });
    expect(reminderButton(reminderScope(0, "≤7 days", 2), blocked).label).toBe("Remind 0 · 2 can't be emailed now");
  });

  it("an empty view → 'Remind 0 in <view>', disabled", () => {
    const b = reminderButton(reminderScope(0, "Overdue", 0), { send: [], skipped: [] });
    expect(b.label).toBe("Remind 0 in Overdue");
    expect(b.disabled).toBe(true);
    expect(b.reason).toBe("Nothing in Overdue to remind.");
  });
});

describe("R-2820 RenewalRemindButton (RTL)", () => {
  it("greyed at 0: disabled, the reason as its description, a click does nothing", () => {
    const onClick = vi.fn();
    const plan = reminderPlan(OVERDUE, { today: TODAY, tenantGraceDays: 0, emailOf });
    render(<RenewalRemindButton scope={reminderScope(0, "Overdue", 9)} plan={plan} onClick={onClick} />);
    const btn = screen.getByRole("button", { name: /Remind 0 · 9 need a call or part bill/ });
    expect(btn).toHaveProperty("disabled", true);
    expect(btn.getAttribute("title")).toContain(REMINDER_SKIP.pastGrace);
    /* a disabled button gets no hover — the tooltip is on its wrapper too */
    expect(screen.getByTestId("renewals-remind-reason").getAttribute("title")).toContain(REMINDER_SKIP.split);
    expect(screen.getByText(new RegExp(`5 ${REMINDER_SKIP.pastGrace.slice(0, 20)}`)).id).toBe(btn.getAttribute("aria-describedby"));
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("sendable rows: enabled, the count it will email, a click opens the dialog", () => {
    const onClick = vi.fn();
    const plan = reminderPlan([row("Due A", 3), row("Due B", 12)], { today: TODAY, emailOf });
    render(<RenewalRemindButton scope={reminderScope(0, "8–30", 2)} plan={plan} onClick={onClick} />);
    const btn = screen.getByRole("button", { name: /Remind 2 in 8–30/ });
    expect(btn).toHaveProperty("disabled", false);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("while the contacts load it waits (disabled, says why); while sending it says Sending…", () => {
    const plan = reminderPlan([row("Due A", 3)], { today: TODAY, emailOf });
    const { rerender } = render(<RenewalRemindButton scope={reminderScope(0, "8–30", 1)} plan={plan} loading onClick={() => {}} />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveProperty("disabled", true);
    expect(btn.getAttribute("title")).toBe("Reading each customer's email…");
    expect(btn.textContent).toBe("Remind…");   // no count until the emails are read
    rerender(<RenewalRemindButton scope={reminderScope(0, "8–30", 1)} plan={plan} busy onClick={() => {}} />);
    expect(screen.getByRole("button").textContent).toContain("Sending…");
  });
});

describe("R-2820 dialog: the skipped list names the product next to the customer", () => {
  it("'CT R2737 Renewals Pvt Ltd · Google Workspace' — five rows of one customer told apart", () => {
    const rows = [
      row("a", -20, { customer_name: "CT R2737 Renewals Pvt Ltd", plan: "Google Workspace" }),
      row("b", -20, { customer_name: "CT R2737 Renewals Pvt Ltd", plan: "Microsoft 365" }),
      row("c", -20, { customer_name: "Solo", plan: null }),
    ];
    const plan = reminderPlan(rows, { today: TODAY, emailOf });
    render(<RenewalReminderDialog state={{ scope: reminderScope(0, "Overdue", 3), ...plan }} onClose={() => {}} onSend={async () => ({ sent: 0, stub: false, failed: [] })} />);
    const skipped = screen.getByRole("region", { name: "Skipped" });
    expect(skipped.textContent).toContain("CT R2737 Renewals Pvt Ltd · Google Workspace, CT R2737 Renewals Pvt Ltd · Microsoft 365, Solo");
  });
});
