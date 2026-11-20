/**
 * R-2928 — "Remind" on a teammate's task: who may be reminded, how often, and what they read.
 */
import { describe, expect, it } from "vitest";
import { REMIND_GAP_MS, remindEmail, remindNotification, whyNoReminder } from "./remind-notice";

const NOW = Date.parse("2026-11-19T10:40:00Z"); // 4:10 pm IST
const open = { status: "pending", owner_id: "u-hitesh", last_followup_at: null };
const hitesh = { id: "u-hitesh", is_active: true };
const ask = (over: Partial<Parameters<typeof whyNoReminder>[0]> = {}) =>
  whyNoReminder({ task: open, actorId: "u-me", assignee: hitesh, now: NOW, ...over });

describe("R-2928 whyNoReminder", () => {
  it("a teammate's open task that was never reminded: go", () => {
    expect(ask()).toBeNull();
    expect(ask({ task: { ...open, status: "snoozed" } })).toBeNull();
  });

  it("my own task, a task with no owner, a finished task: no reminder", () => {
    expect(ask({ task: { ...open, owner_id: "u-me" } })).toBe("own task");
    expect(ask({ task: { ...open, owner_id: null }, assignee: null })).toBe("no owner");
    expect(ask({ task: { ...open, status: "done" } })).toBe("task is closed");
    expect(ask({ task: { ...open, status: "cancelled" } })).toBe("task is closed");
  });

  it("an owner who left the company (or is not in it) is not written to", () => {
    expect(ask({ assignee: { ...hitesh, is_active: false } })).toBe("owner not in this company");
    expect(ask({ assignee: null })).toBe("owner not in this company");
  });

  it("once per hour per task: 59 minutes after the last reminder is too soon, 60 is fine", () => {
    const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
    expect(REMIND_GAP_MS).toBe(60 * 60 * 1000);
    expect(ask({ task: { ...open, last_followup_at: at(1) } })).toBe("reminded recently");
    expect(ask({ task: { ...open, last_followup_at: at(59) } })).toBe("reminded recently");
    expect(ask({ task: { ...open, last_followup_at: at(60) } })).toBeNull();
    expect(ask({ task: { ...open, last_followup_at: at(600) } })).toBeNull();
  });
});

describe("R-2928 what the owner of the task reads", () => {
  const task = { id: "T1", title: "Call Acme <b>", notes: "Ask for the PO", due_at: "2026-11-19T10:00:00Z" };

  it("the bell line names who reminded and the task, and opens that task", () => {
    expect(remindNotification({ task, actorName: "Pardeep" })).toEqual({
      kind: "task.reminder", title: "Reminder from Pardeep: Call Acme <b>", body: "Due 19 Nov 2026, 3:30 pm",
      href: "/tasks?tab=all&task=T1", entityId: "T1",
    });
    expect(remindNotification({ task, actorName: "Pardeep", canOpenTasks: false }).href).toBe("/dashboard");
  });

  it("the email says it is a reminder, with the task's details and link (HTML escaped)", () => {
    const mail = remindEmail({
      task, assigneeName: "Hitesh", actorName: "Pardeep", companyName: "E2E Test Co",
      baseUrl: "https://app.example.test/", related: { label: "Customer", name: "Acme", path: "/customers/c-1" },
    });
    expect(mail.subject).toBe("Reminder: Call Acme <b>");
    expect(mail.text).toContain("Pardeep sent you a reminder about this task in E2E Test Co.");
    expect(mail.text).toContain("Due: 19 Nov 2026, 3:30 pm");
    expect(mail.text).toContain("Customer: Acme — https://app.example.test/customers/c-1");
    expect(mail.text).toContain("Open the task: https://app.example.test/tasks?tab=all&task=T1");
    expect(mail.text).not.toContain("gave you a task");
    expect(mail.html).toContain("Call Acme &lt;b&gt;");
    expect(mail.html).not.toContain("<b>");
  });
});
