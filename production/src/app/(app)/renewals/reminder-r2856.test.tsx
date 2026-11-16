// @vitest-environment jsdom
/**
 * R-2856 — coordinator's human test on staging, 16 Nov: the Overdue tab had 8 rows and the header button
 * read "Remind 1 in Overdue"; its dialog listed the 7 it leaves out as ONE comma paragraph ("billed in
 * parts — each part's bill goes out on its own date (7): ITBUZZ …, Ravi Shankar …, Supreme …") — hard to
 * read, and the overdue part-billed customers (46 and 44 days late) got no next step.
 *
 *   · the button says N of M when it leaves rows out ("Remind 1 of 8 in Overdue"), tooltip = why;
 *   · skipped = a list, one line per subscription, under its reason, with how late it is and its own
 *     next step (Open renewal → the row's drawer with Bill next part / Send renewal / Follow up;
 *     Add a contact → the customer page for "no email on file").
 * Extends R-2753 (who is skipped and why) and R-2820 (count only what it can send) — same plan, same words.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { RenewalRemindButton, RenewalReminderDialog } from "./reminder-dialog";
import {
  reminderButton, reminderPlan, reminderScope, reminderRowWhen, skipNextStep, REMINDER_SKIP,
  type RenewalRowLike, type RenewalSubLike,
} from "./reminders";

afterEach(cleanup);

const TODAY = new Date("2026-11-16T06:30:00Z"); // 12:00 IST
const d = (n: number) => new Date(Date.UTC(2026, 10, 16 + n)).toISOString().slice(0, 10);
const row = (id: string, daysUntil: number, p: Partial<RenewalSubLike> = {}): RenewalRowLike => ({
  sub: { id, customer_name: id, renewal_date: d(daysUntil), renewal_state: "pending", term_months: 12, billing_cycle: "yearly", auto_renew: true, ...p },
  daysUntil,
});
const emailOf = (r: RenewalRowLike) => (r.sub.id === "NoMail" ? null : `${r.sub.id}@x.in`);

/** The staging Overdue tab: 1 in grace (can be emailed) + 7 billed in parts. */
const SPLIT_NAMES = ["ITBUZZ", "Ravi Shankar", "Supreme", "Split 4", "Split 5", "Split 6", "Split 7"];
const SPLIT_DAYS = [-3, -46, -44, -5, -6, -7, -8];
const OVERDUE = [
  row("In Grace", -2, { grace_until: d(5) }),
  ...SPLIT_NAMES.map((n, i) => row(n, SPLIT_DAYS[i], { billing_cycle: "quarterly", plan: "Google Workspace" })),
];
const overduePlan = () => reminderPlan(OVERDUE, { today: TODAY, tenantGraceDays: 0, emailOf });

describe("R-2856 the button says N of M when it leaves rows out", () => {
  it("8 rows on Overdue, 1 can be emailed → 'Remind 1 of 8 in Overdue'; the tooltip says why 7 are not included", () => {
    const plan = overduePlan();
    expect(plan.send.map((r) => r.sub.id)).toEqual(["In Grace"]);
    const b = reminderButton(reminderScope(0, "Overdue", OVERDUE.length), plan);
    expect(b.label).toBe("Remind 1 of 8 in Overdue");
    expect(b.disabled).toBe(false);
    expect(b.reason).toBe(`7 not included — 7 ${REMINDER_SKIP.split}.`);
  });

  it("nothing left out → the plain count (R-2820 / R-2767 labels stay)", () => {
    const rows = [row("A", 3), row("B", 12)];
    const plan = reminderPlan(rows, { today: TODAY, emailOf });
    expect(reminderButton(reminderScope(0, "8–30", 2), plan).label).toBe("Remind 2 in 8–30");
    expect(reminderButton(reminderScope(2, "8–30", 2), plan).label).toBe("Remind 2 selected");
  });

  it("a pressed Due tile and ticked rows read the same way", () => {
    const rows = [row("A", 3), row("Wont", 5, { auto_renew: false }), row("NoMail", 6)];
    const plan = reminderPlan(rows, { today: TODAY, emailOf });
    expect(reminderButton(reminderScope(0, "Due in 30 days", 3), plan).label).toBe("Remind 1 of 3 due in 30 days");
    expect(reminderButton(reminderScope(3, "≤7 days", 3), plan).label).toBe("Remind 1 of 3 selected");
  });

  it("RTL: the header button shows the label and carries the reason as its tooltip", () => {
    render(<RenewalRemindButton scope={reminderScope(0, "Overdue", 8)} plan={overduePlan()} onClick={() => {}} />);
    const btn = screen.getByRole("button", { name: /Remind 1 of 8 in Overdue/ });
    expect(btn.getAttribute("title")).toContain("7 not included");
    expect(btn.getAttribute("title")).toContain(REMINDER_SKIP.split);
  });
});

describe("R-2856 each skip reason has its next step; each row says how late it is", () => {
  it("billed in parts / past grace → open the renewal (its buttons are there); no email → add a contact", () => {
    expect(skipNextStep(REMINDER_SKIP.split)).toEqual({ action: "open-renewal", label: "Open renewal", hint: "Next: Bill next part, or Follow up if a part is late" });
    expect(skipNextStep(REMINDER_SKIP.flex).hint).toBe("Next: Bill next part, or Follow up if a part is late");   // as split — R-2820 calls both "need a part bill"
    expect(skipNextStep(REMINDER_SKIP.wontRenew).hint).toBe("Next: Undo Won't renew if they changed their mind");
    /* past grace: its reason already says "use Send renewal quote, or call them" — not said twice */
    expect(skipNextStep(REMINDER_SKIP.pastGrace)).toEqual({ action: "open-renewal", label: "Open renewal", hint: null });
    expect(skipNextStep(REMINDER_SKIP.noEmail)).toEqual({ action: "add-contact", label: "Add a contact", hint: null });
    /* every reason the plan can give has a step — none falls through without one */
    for (const reason of Object.values(REMINDER_SKIP)) expect(skipNextStep(reason).label).toMatch(/^(Open renewal|Add a contact)$/);
    expect(skipNextStep("something new").action).toBe("open-renewal");
  });

  it("how late: the row chip's own words (last-docs.ts renewalDueText) — 'Overdue 46d' / 'Due today' / 'Due in 12d'; nothing without a date", () => {
    expect(reminderRowWhen(row("x", -46))).toBe("Overdue 46d");
    expect(reminderRowWhen(row("x", 0))).toBe("Due today");
    expect(reminderRowWhen(row("x", 12))).toBe("Due in 12d");
    expect(reminderRowWhen({ sub: { id: "n", customer_name: "n", renewal_date: null }, daysUntil: 0 })).toBe("");
    /* code-review: a row that is renewed / stopped / won't renew has no live due date — no red "Overdue 90d" beside "already renewed" */
    for (const reason of [REMINDER_SKIP.renewed, REMINDER_SKIP.stopped, REMINDER_SKIP.wontRenew]) expect(reminderRowWhen(row("x", -90), reason)).toBe("");
    expect(reminderRowWhen(row("x", -46), REMINDER_SKIP.split)).toBe("Overdue 46d");
  });
});

describe("R-2856 dialog: skipped is a list — one line per subscription, with its next step", () => {
  const openDialog = (rows: RenewalRowLike[], extra: Partial<React.ComponentProps<typeof RenewalReminderDialog<RenewalRowLike>>> = {}) => {
    const plan = reminderPlan(rows, { today: TODAY, tenantGraceDays: 0, emailOf });
    render(
      <RenewalReminderDialog
        state={{ scope: reminderScope(0, "Overdue", rows.length), ...plan }}
        onClose={() => {}} onSend={async () => ({ sent: 0, stub: false, failed: [] })} emailOf={emailOf} {...extra}
      />,
    );
    return screen.getByRole("region", { name: "Skipped" });
  };

  it("7 billed in parts → one group with the reason once, then 7 lines (name · plan, Overdue Nd, Open renewal)", () => {
    const skipped = openDialog(OVERDUE, { onOpenRow: () => {} });
    const group = within(skipped).getByTestId("reminder-skip-group");
    expect(group.textContent).toContain(`${REMINDER_SKIP.split} (7)`);
    expect(group.textContent).toContain("Next: Bill next part, or Follow up if a part is late");
    const lines = within(group).getAllByTestId("reminder-skip-row");
    expect(lines).toHaveLength(7);
    expect(lines[1].textContent).toContain("Ravi Shankar · Google Workspace");
    expect(lines[1].textContent).toContain("Overdue 46d");
    expect(lines[2].textContent).toContain("Supreme · Google Workspace");
    expect(lines[2].textContent).toContain("Overdue 44d");
    /* no comma paragraph: no line carries two customers */
    expect(skipped.textContent).not.toContain("ITBUZZ · Google Workspace, Ravi Shankar");
    for (const li of lines) expect(within(li).getByRole("button", { name: /^Open renewal — / })).toBeTruthy();
  });

  it("Open renewal hands THAT row to the page (it closes the dialog and opens the row's drawer)", () => {
    const onOpenRow = vi.fn();
    const skipped = openDialog(OVERDUE, { onOpenRow });
    fireEvent.click(within(skipped).getByRole("button", { name: "Open renewal — Ravi Shankar · Google Workspace" }));
    expect(onOpenRow).toHaveBeenCalledTimes(1);
    expect(onOpenRow.mock.calls[0][0].sub.id).toBe("Ravi Shankar");
  });

  it("no email on file → 'Add a contact' is a link to that customer's page; past grace rows open the renewal", () => {
    const rows = [row("Due", 3), row("NoMail", 6, { plan: "M365" }), row("Late", -20)];
    const skipped = openDialog(rows, { onOpenRow: () => {}, customerHref: (r) => `/customers/c-${r.sub.id}` });
    const groups = within(skipped).getAllByTestId("reminder-skip-group");
    expect(groups).toHaveLength(2);
    const link = within(skipped).getByRole("link", { name: "Add a contact — NoMail · M365" });
    expect(link.getAttribute("href")).toBe("/customers/c-NoMail");
    expect(within(skipped).getByRole("button", { name: "Open renewal — Late" })).toBeTruthy();
    expect(skipped.textContent).toContain(REMINDER_SKIP.pastGrace);
  });

  it("without the page's handlers (another screen) the lines still list — just no dead button", () => {
    const skipped = openDialog(OVERDUE);
    expect(within(skipped).getAllByTestId("reminder-skip-row")).toHaveLength(7);
    expect(within(skipped).queryByRole("button")).toBeNull();
  });

  it("while the emails are going out no next step can take the owner away (the result — who got it, Retry failed — would be lost)", async () => {
    let done: (v: { sent: number; stub: boolean; failed: [] }) => void = () => {};
    const rows = [row("Due", 3), row("NoMail", 6), row("Late", -20), row("Wont", 5, { auto_renew: false })];
    const skipped = openDialog(rows, {
      onOpenRow: () => {}, customerHref: (r) => `/customers/c-${r.sub.id}`,
      onSend: () => new Promise((res) => { done = res; }),
    });
    /* a Won't renew row has no live due date — its line shows no "Due in 5d" (the row chip says "ends <date>") */
    const wont = within(skipped).getAllByTestId("reminder-skip-row").find((li) => li.textContent?.includes("Wont"));
    expect(wont?.textContent).toBe("WontOpen renewal");
    fireEvent.click(screen.getByRole("button", { name: "Email 1 customer" }));
    await waitFor(() => expect(within(skipped).queryByRole("link")).toBeNull());
    expect(within(skipped).getByText("Add a contact").getAttribute("aria-disabled")).toBe("true");
    expect(within(skipped).getByRole("button", { name: "Open renewal — Late" })).toHaveProperty("disabled", true);
    done({ sent: 1, stub: false, failed: [] });
    await waitFor(() => expect(screen.getByText("Reminded 1 customer")).toBeTruthy());
  });
});
