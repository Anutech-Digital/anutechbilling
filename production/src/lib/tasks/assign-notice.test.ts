import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSIGN_NOTICE_WINDOW_MS, assignEmail, assignNotification, formatDueIST, relatedOf, taskAppPath, whyNoNotice } from "./assign-notice";

const TASK = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Call Acme about the renewal",
  notes: "Ask for the PO <today>",
  due_at: "2026-11-19T10:00:00Z", // 3:30 pm IST
  owner_id: "u-hitesh",
  delegated_by: "u-me", delegated_at: "2026-11-18T18:00:00Z",
  lead_id: null, quote_id: null, customer_id: "c-1", subscription_id: null,
};

describe("R-2925 in-app notice for an assigned task", () => {
  it("says who gave it and what it is, and opens that task", () => {
    const n = assignNotification({ task: TASK, actorName: "Pardeep" });
    expect(n.kind).toBe("task.assigned");
    expect(n.title).toBe("New task from Pardeep: Call Acme about the renewal");
    expect(n.body).toContain("Due 19 Nov 2026");
    expect(n.href).toBe(`/tasks?tab=all&task=${TASK.id}`);
    expect(n.entityId).toBe(TASK.id);
  });

  it("the due time is shown in IST", () => {
    expect(formatDueIST("2026-11-19T10:00:00Z")).toMatch(/19 Nov 2026, 3:30 pm/i);
    expect(formatDueIST("2026-11-19T20:00:00Z")).toMatch(/20 Nov 2026, 1:30 am/i); // next IST day
  });

  it("the same path the team-chat task notice uses", () => {
    expect(taskAppPath("abc")).toBe("/tasks?tab=all&task=abc");
  });
});

describe("R-2925 who gets no notice", () => {
  const NOW = Date.parse("2026-11-18T18:00:05Z");
  const base = { task: TASK, actorId: "u-me", assignee: { id: "u-hitesh", is_active: true }, lastToldAt: null as string | null, now: NOW };
  it("a task with an active teammate as owner: notice goes", () => {
    expect(whyNoNotice(base)).toBeNull();
  });
  it("my own task", () => {
    expect(whyNoNotice({ ...base, task: { ...TASK, owner_id: "u-me" } })).toBe("own task");
  });
  it("no owner", () => {
    expect(whyNoNotice({ ...base, task: { ...TASK, owner_id: null } })).toBe("no owner");
  });
  it("the owner is not an active member of this company", () => {
    expect(whyNoNotice({ ...base, assignee: null })).toBe("owner not in this company");
    expect(whyNoNotice({ ...base, assignee: { id: "u-hitesh", is_active: false } })).toBe("owner not in this company");
  });
  it("this hand-over already has its notice (double click / repeated call)", () => {
    expect(whyNoNotice({ ...base, lastToldAt: "2026-11-18T18:00:02Z" })).toBe("already told");
  });
  it("an OLD notice (the task was theirs before, went away and came back) does not block the new one", () => {
    expect(whyNoNotice({ ...base, lastToldAt: "2026-11-10T09:00:00Z" })).toBeNull();
  });
  it("someone who did not hand the task over cannot have the owner told", () => {
    expect(whyNoNotice({ ...base, actorId: "u-sales" })).toBe("not your assignment");
    expect(whyNoNotice({ ...base, task: { ...TASK, delegated_by: null, delegated_at: null } })).toBe("not your assignment");
  });
  it("a hand-over from long ago cannot be announced again", () => {
    expect(whyNoNotice({ ...base, now: NOW + ASSIGN_NOTICE_WINDOW_MS + 60_000 })).toBe("not your assignment");
  });
});

describe("R-2925 the email", () => {
  const mail = assignEmail({
    task: TASK, assigneeName: "Hitesh", actorName: "Pardeep", companyName: "E2E Test Co",
    baseUrl: "https://app.example.test", related: relatedOf(TASK, { customer: "Acme Pvt Ltd" }),
  });

  it("subject names the task", () => {
    expect(mail.subject).toBe("New task: Call Acme about the renewal");
  });

  it("text has the name, notes, due date, the related customer with its link, and the app link", () => {
    expect(mail.text).toContain("Hi Hitesh");
    expect(mail.text).toContain("Pardeep gave you a task in E2E Test Co");
    expect(mail.text).toContain("Call Acme about the renewal");
    expect(mail.text).toContain("Ask for the PO <today>");
    expect(mail.text).toMatch(/Due: 19 Nov 2026, 3:30 pm/i);
    expect(mail.text).toContain("Customer: Acme Pvt Ltd — https://app.example.test/customers/c-1");
    expect(mail.text).toContain(`Open the task: https://app.example.test/tasks?tab=all&task=${TASK.id}`);
  });

  it("html escapes what people typed", () => {
    expect(mail.html).toContain("Ask for the PO &lt;today&gt;");
    expect(mail.html).not.toContain("<today>");
    expect(mail.html).toContain(`href="https://app.example.test/tasks?tab=all&amp;task=${TASK.id}"`);
  });

  it("a lead task links the lead; a task about nothing has no related line", () => {
    const lead = relatedOf({ ...TASK, customer_id: null, lead_id: "L-9" }, { lead: "Beta Traders" });
    expect(lead).toEqual({ label: "Lead", name: "Beta Traders", path: "/leads?lead=L-9" });
    expect(relatedOf({ ...TASK, customer_id: null }, {})).toBeNull();
    expect(relatedOf({ ...TASK, customer_id: null, subscription_id: "s-1" }, {})).toEqual({ label: "Subscription", name: "Subscriptions", path: "/subscriptions" });
    const plain = assignEmail({ task: TASK, assigneeName: "Hitesh", actorName: "Pardeep", companyName: "X", baseUrl: "https://a.test", related: null });
    expect(plain.text).not.toMatch(/Customer:|Lead:|Deal:/);
  });
});

describe("R-2925 a role that cannot open Tasks (accountant, billing…)", () => {
  it("the bell notice opens the dashboard and the mail links the app, not a page that refuses them", () => {
    expect(assignNotification({ task: TASK, actorName: "Pardeep", canOpenTasks: false }).href).toBe("/dashboard");
    const mail = assignEmail({ task: TASK, assigneeName: "Asha", actorName: "Pardeep", companyName: "X", baseUrl: "https://a.test", related: null, canOpenTasks: false });
    expect(mail.text).toContain("Open the app: https://a.test/dashboard");
    expect(mail.text).not.toContain("/tasks?");
    expect(mail.text).toContain("Call Acme about the renewal"); // the details are still in the mail
  });
});

describe("R-2925 the server side", () => {
  const server = readFileSync(join(__dirname, "assign-notice.server.ts"), "utf8");
  const route = readFileSync(join(__dirname, "../../app/api/tasks/assigned/route.ts"), "utf8");

  it("reads the task through the caller's own session (RLS = same company), never by id alone", () => {
    expect(server).toMatch(/supabase\s*\.from\("tasks"\)[\s\S]*?\.eq\("tenant_id", tenantId\)/);
  });
  it("mail goes through the app's internal mail door with the company's route", () => {
    expect(server).toMatch(/sendInternalEmail\(/);
    expect(server).toMatch(/route: \{ tenantId/);
    expect(server).toMatch(/kind: "task_assigned"/);
  });
  it("a failed email never fails the request (the in-app notice is already written)", () => {
    expect(server).toMatch(/catch/);
  });
  it("the route is open to the roles that can open Tasks", () => {
    expect(route).toMatch(/pages: \["\/tasks"\]/);
  });
});
