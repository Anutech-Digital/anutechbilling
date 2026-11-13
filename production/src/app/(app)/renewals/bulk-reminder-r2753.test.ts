/**
 * R-2753 — 14 Nov owner-style audit (job 6): on the Overdue tab the header "Bulk reminder" asked
 * to "Email 2 customers" — SCN Kochi + SCN Delhi from the 8–30 tab, none of the overdue ones, and
 * SCN Kochi has no email; ticking the overdue rows + the bar's "Send reminder" only flashed a toast;
 * two buttons did one job; on a phone a big floating "Bulk reminder" sat over the page.
 *
 * Now: ONE reminder button acting on the ticked rows, else the open tab's rows (its label says
 * which); the dialog lists who gets the email and, apart, who is skipped with the reason.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  reminderPlan, reminderScope, reminderButtonLabel, reminderDialogTitle, groupSkips, REMINDER_SKIP,
  type RenewalRowLike, type RenewalSubLike,
} from "./reminders";

const TODAY = new Date("2026-11-14T06:30:00Z"); // 12:00 IST
const d = (n: number) => new Date(Date.UTC(2026, 10, 14 + n)).toISOString().slice(0, 10);
const row = (id: string, daysUntil: number, p: Partial<RenewalSubLike> = {}): RenewalRowLike => ({
  sub: { id, customer_name: id, renewal_date: d(daysUntil), renewal_state: "pending", term_months: 12, billing_cycle: "yearly", auto_renew: true, ...p },
  daysUntil,
});
const ids = (rows: readonly RenewalRowLike[]) => rows.map((r) => r.sub.id);
const reasonOf = (plan: ReturnType<typeof reminderPlan>, id: string) => plan.skipped.find((s) => s.row.sub.id === id)?.reason;

describe("R-2753 scope + label: the ticked rows, else the open tab", () => {
  it("nothing ticked → the open tab, named on the button", () => {
    const s = reminderScope(0, "Overdue", 3);
    expect(s).toEqual({ kind: "tab", label: "Overdue", count: 3 });
    expect(reminderButtonLabel(s)).toBe("Remind 3 in Overdue");
  });
  it("rows ticked → only those", () => {
    const s = reminderScope(2, "Overdue", 3);
    expect(reminderButtonLabel(s)).toBe("Remind 2 selected");
  });
  it("the dialog title names the scope; nobody due says so (a dialog, not a toast)", () => {
    expect(reminderDialogTitle(1, reminderScope(0, "8–30", 4))).toBe("Email 1 customer · 8–30");
    expect(reminderDialogTitle(0, reminderScope(0, "Overdue", 3))).toBe("No reminder to send · Overdue");
    expect(reminderDialogTitle(2, reminderScope(3, "Overdue", 3))).toBe("Email 2 customers · 3 selected");
  });
});

describe("R-2753 plan: every row in scope is emailed or skipped with its reason", () => {
  const emails: Record<string, string | null> = { "SCN Kochi": null };
  const emailOf = (r: RenewalRowLike) => (r.sub.id in emails ? emails[r.sub.id] : `${r.sub.id}@x.in`);

  it("the audit's 8–30 tab: a customer with no email is skipped — never counted in 'Email N'", () => {
    const plan = reminderPlan([row("SCN Kochi", 12), row("SCN Delhi", 20)], { today: TODAY, emailOf });
    expect(ids(plan.send)).toEqual(["SCN Delhi"]);
    expect(reasonOf(plan, "SCN Kochi")).toBe(REMINDER_SKIP.noEmail);
  });

  it("the audit's Overdue tab (grace 0): the overdue rows are named as past grace — not silently dropped, and no 8–30 row sneaks in", () => {
    const overdue = [row("Late A", -2), row("Late B", -44), row("Late C", -1)];
    const plan = reminderPlan(overdue, { today: TODAY, tenantGraceDays: 0, emailOf });
    expect(plan.send).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([REMINDER_SKIP.pastGrace, REMINDER_SKIP.pastGrace, REMINDER_SKIP.pastGrace]);
    expect(REMINDER_SKIP.pastGrace).toMatch(/Send renewal quote/);
  });

  it("lapsed but still in grace → emailed (R-1124); the row's own +N days counts (R-1621)", () => {
    const plan = reminderPlan([row("In grace", -3), row("Extended", -10, { grace_until: d(5) })], { today: TODAY, tenantGraceDays: 7, emailOf });
    expect(ids(plan.send)).toEqual(["In grace", "Extended"]);
  });

  it("names every other reason: Won't renew, stopped, renewed, paid quote, flex, split-billed, >30 days, reminded today", () => {
    const rows = [
      row("Wont", 5, { auto_renew: false }),
      row("Stopped", -5, { renewal_state: "suspended" }),
      row("PaidQuote", -2),
      row("Flex", 6, { term_months: 1, billing_cycle: "monthly" }),
      row("Quarterly", 10, { billing_cycle: "quarterly" }),
      row("Later", 45),
      row("Today", 9, { last_reminder_sent_at_v2: "2026-11-14T03:00:00Z" }),     // 08:30 IST today
      row("Yesterday", 9, { last_reminder_sent_at_v2: "2026-11-13T10:00:00Z" }), // 15:30 IST yesterday → may go again
      row("Ok", 3),
    ];
    const plan = reminderPlan(rows, { today: TODAY, tenantGraceDays: 7, emailOf, isPaid: (r) => r.sub.id === "PaidQuote" });
    expect(ids(plan.send)).toEqual(["Yesterday", "Ok"]);
    expect(reasonOf(plan, "Wont")).toBe(REMINDER_SKIP.wontRenew);
    expect(reasonOf(plan, "Stopped")).toBe(REMINDER_SKIP.stopped);
    expect(reasonOf(plan, "PaidQuote")).toBe(REMINDER_SKIP.renewed);
    expect(reasonOf(plan, "Flex")).toBe(REMINDER_SKIP.flex);
    expect(reasonOf(plan, "Quarterly")).toBe(REMINDER_SKIP.split);
    expect(reasonOf(plan, "Later")).toBe(REMINDER_SKIP.tooEarly);
    expect(reasonOf(plan, "Today")).toBe(REMINDER_SKIP.remindedToday);
    expect(plan.send.length + plan.skipped.length).toBe(rows.length);   // nobody dropped without a word
  });

  it("contacts not read yet → not counted as 'no email' (the send route still checks)", () => {
    const plan = reminderPlan([row("Unknown", 5)], { today: TODAY, emailOf: () => undefined });
    expect(ids(plan.send)).toEqual(["Unknown"]);
  });

  it("groupSkips: one group per reason, first-seen order", () => {
    const plan = reminderPlan([row("A", 45), row("B", 5, { auto_renew: false }), row("C", 50)], { today: TODAY, emailOf });
    expect(groupSkips(plan.skipped).map((g) => [g.reason, ids(g.rows)])).toEqual([
      [REMINDER_SKIP.tooEarly, ["A", "C"]],
      [REMINDER_SKIP.wontRenew, ["B"]],
    ]);
  });
});

describe("R-2753 page wiring: one button, no floating email button, no 'none due' toast", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/renewals/page.tsx"), "utf8");
  it("the one reminder button acts on the ticked rows, else the open tab's rows", () => {
    expect(page).toContain("reminderScope(selectedRows.length,");
    expect(page).toMatch(/selectedRows\.length > 0 \? selectedRows : visibleRows/);
    expect(page).toContain("reminderButtonLabel(scope)");
    expect(page).not.toContain('"Bulk reminder"');
  });
  it("the ticked-rows bar has no second Send reminder; no FAB on phone", () => {
    expect(page).not.toMatch(/<BulkBarButton[^>]*handleSelectedReminder/);
    expect(page).not.toContain("handleSelectedReminder");
    expect(page).not.toMatch(/<FAB\b/);
  });
  it("the plan reads the row's contact email and paid quote", () => {
    expect(page).toMatch(/reminderPlan\(scopeRows, \{[^}]*emailOf/);
    expect(page).not.toContain('toast.info("No renewals due in the next 30 days');
    expect(page).not.toContain('toast.info("None of the selected renewals is due for a reminder"');
  });
});
