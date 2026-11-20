/**
 * R-2928 — sendTaskReminder with stub clients: who is reminded, once an hour, what is stamped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const db: { tasks: Row[]; users: Row[]; tenants: Row[] } = { tasks: [], users: [], tenants: [] };

/**
 * A tiny PostgREST look-alike: eq / in / is filters over the in-memory rows; an update changes
 * the rows it matched and answers them. `staleTask`: what a caller that read the task a moment
 * too early saw (the race test).
 */
function client(staleTask?: Row) {
  return {
    from(table: keyof typeof db) {
      let rows = db[table].slice();
      let patch: Row | null = null;
      const q = {
        select: () => q,
        update: (p: Row) => { patch = p; return q; },
        eq: (k: string, v: unknown) => { rows = rows.filter((r) => r[k] === v); return q; },
        is: (k: string, v: unknown) => { rows = rows.filter((r) => (r[k] ?? null) === v); return q; },
        in: (k: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[k])); return q; },
        maybeSingle: async () => ({ data: (table === "tasks" && staleTask && rows.length ? staleTask : rows[0]) ?? null, error: null }),
        then: (ok: (v: { data: Row[]; error: null }) => unknown) => {
          if (patch) for (const r of rows) Object.assign(r, patch);
          return Promise.resolve({ data: rows, error: null }).then(ok);
        },
      };
      return q;
    },
  };
}

const sendInternalEmail = vi.fn(async (_m: Row) => ({ status: "sent", providerId: "x", errorMessage: null, provider: "stub" }));
// notifyPeople answers how many notices it wrote (R-2941); 0 = not written.
const notifyPeople = vi.fn(async (_input: Row, _to: { userIds: string[] }): Promise<number> => 1);
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => client() }));
vi.mock("@/lib/messaging", () => ({ sendInternalEmail: (m: Row) => sendInternalEmail(m) }));
vi.mock("@/lib/notifications/notify.server", () => ({ notifyPeople: (i: Row, t: { userIds: string[] }) => notifyPeople(i, t) }));
vi.mock("@/lib/app-url", () => ({ appUrl: () => "https://app.example.test" }));
vi.mock("@/lib/api/with-route", () => ({ mayOpenPage: (role: string | null) => role === "owner" || role === "manager" || role === "sales" }));

import { sendTaskReminder } from "./remind-notice.server";

const T = "t-1", ME = "u-me", HITESH = "u-hitesh", TASK = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-19T10:40:00.000Z");
const run = (over: { taskId?: string; tenantId?: string; now?: Date } = {}) =>
  sendTaskReminder(client() as never, { taskId: TASK, tenantId: T, actorId: ME, now: NOW, ...over });

beforeEach(() => {
  sendInternalEmail.mockClear(); notifyPeople.mockClear();
  db.tenants = [{ id: T, name: "E2E Test Co" }];
  db.users = [
    { id: ME, tenant_id: T, full_name: "Pardeep Sharma", email: "p@example.test", is_active: true, role: "owner" },
    { id: HITESH, tenant_id: T, full_name: "Hitesh", email: "h@example.test", is_active: true, role: "sales" },
  ];
  db.tasks = [{
    id: TASK, tenant_id: T, title: "Call Acme", notes: "Ask for the PO", due_at: "2026-11-19T10:00:00Z", status: "pending",
    owner_id: HITESH, last_followup_at: null, followup_count: 0,
    lead_id: null, quote_id: null, customer_id: "c-1", subscription_id: null, customers: { name: "Acme Pvt Ltd" },
  }];
});

describe("R-2928 sendTaskReminder", () => {
  it("a teammate's open task: bell + email to them, and the task remembers when and how often", async () => {
    expect(await run()).toEqual({ reminded: true, emailed: true, lastFollowupAt: NOW.toISOString() });

    expect(notifyPeople).toHaveBeenCalledTimes(1);
    const [n, to] = notifyPeople.mock.calls[0];
    expect(to).toEqual({ userIds: [HITESH] });
    expect(n).toMatchObject({ tenantId: T, kind: "task.reminder", title: "Reminder from Pardeep Sharma: Call Acme", entityId: TASK, href: `/tasks?tab=all&task=${TASK}` });

    expect(sendInternalEmail).toHaveBeenCalledTimes(1);
    const mail = sendInternalEmail.mock.calls[0][0] as { to: string; subject: string; text: string; route: Row; kind: string };
    expect(mail.to).toBe("h@example.test");
    expect(mail.subject).toBe("Reminder: Call Acme");
    expect(mail.text).toContain("Customer: Acme Pvt Ltd — https://app.example.test/customers/c-1");
    expect(mail.route).toEqual({ tenantId: T });
    expect(mail.kind).toBe("task_reminder");

    expect(db.tasks[0]).toMatchObject({ last_followup_at: NOW.toISOString(), followup_count: 1 });
  });

  it("a second press inside the hour sends nothing and says when the last one went", async () => {
    await run();
    const again = await run({ now: new Date(NOW.getTime() + 59 * 60_000) });
    expect(again).toEqual({ reminded: false, emailed: false, reason: "reminded recently", lastFollowupAt: NOW.toISOString() });
    expect(notifyPeople).toHaveBeenCalledTimes(1);
    expect(sendInternalEmail).toHaveBeenCalledTimes(1);
    expect(db.tasks[0].followup_count).toBe(1);
  });

  it("an hour later it goes again and the count is 2", async () => {
    await run();
    const later = new Date(NOW.getTime() + 60 * 60_000);
    expect(await run({ now: later })).toMatchObject({ reminded: true, lastFollowupAt: later.toISOString() });
    expect(db.tasks[0].followup_count).toBe(2);
    expect(notifyPeople).toHaveBeenCalledTimes(2);
  });

  it("two presses at the same moment: the stamp is taken once, the loser sends nothing", async () => {
    // The loser read the task (never reminded) just before the winner stamped it.
    const readTooEarly = { ...db.tasks[0] };
    const winnerAt = new Date(NOW.getTime() - 1000).toISOString();
    db.tasks[0].last_followup_at = winnerAt;
    db.tasks[0].followup_count = 1;
    const r = await sendTaskReminder(client(readTooEarly) as never, { taskId: TASK, tenantId: T, actorId: ME, now: NOW });
    expect(r).toMatchObject({ reminded: false, emailed: false, reason: "reminded recently" });
    expect(notifyPeople).not.toHaveBeenCalled();
    expect(sendInternalEmail).not.toHaveBeenCalled();
    expect(db.tasks[0]).toMatchObject({ last_followup_at: winnerAt, followup_count: 1 });
  });

  it("my own task, a finished task, a task with no owner: nothing is sent or stamped", async () => {
    db.tasks[0].owner_id = ME;
    expect(await run()).toMatchObject({ reminded: false, reason: "own task" });
    db.tasks[0].owner_id = HITESH; db.tasks[0].status = "done";
    expect(await run()).toMatchObject({ reminded: false, reason: "task is closed" });
    db.tasks[0].status = "pending"; db.tasks[0].owner_id = null;
    expect(await run()).toMatchObject({ reminded: false, reason: "no owner" });
    expect(notifyPeople).not.toHaveBeenCalled();
    expect(sendInternalEmail).not.toHaveBeenCalled();
    expect(db.tasks[0]).toMatchObject({ last_followup_at: null, followup_count: 0 });
  });

  it("a task of another company is not found (the read is pinned to the caller's tenant)", async () => {
    expect(await run({ tenantId: "t-other" })).toMatchObject({ reminded: false, reason: "task not found" });
    expect(notifyPeople).not.toHaveBeenCalled();
    expect(db.tasks[0].last_followup_at).toBeNull();
  });

  it("an owner who is not an active member of this company gets nothing", async () => {
    db.users[1].is_active = false;
    expect(await run()).toMatchObject({ reminded: false, reason: "owner not in this company" });
    db.users[1] = { ...db.users[1], is_active: true, tenant_id: "t-other" };
    expect(await run()).toMatchObject({ reminded: false, reason: "owner not in this company" });
    expect(sendInternalEmail).not.toHaveBeenCalled();
    expect(db.tasks[0].last_followup_at).toBeNull();
  });

  it("an accountant (cannot open Tasks) is reminded with a link they can open", async () => {
    db.users[1].role = "accountant";
    expect(await run()).toMatchObject({ reminded: true });
    expect(notifyPeople.mock.calls[0][0]).toMatchObject({ href: "/dashboard" });
  });

  it("the email failing does not undo the reminder (bell + stamp stay)", async () => {
    sendInternalEmail.mockRejectedValueOnce(new Error("smtp down"));
    expect(await run()).toEqual({ reminded: true, emailed: false, lastFollowupAt: NOW.toISOString() });
    expect(db.tasks[0].followup_count).toBe(1);
  });
});

describe("R-2941 a reminder that could not be sent is not lost for an hour", () => {
  it("neither the bell notice nor the email goes: the stamp is put back, and Remind works again at once", async () => {
    notifyPeople.mockResolvedValueOnce(0);
    sendInternalEmail.mockRejectedValueOnce(new Error("smtp down"));
    expect(await run()).toEqual({ reminded: false, emailed: false, reason: "notice not sent", lastFollowupAt: null });
    expect(db.tasks[0]).toMatchObject({ last_followup_at: null, followup_count: 0 });

    // The next press (a second later) goes through — the hour was given back.
    const retry = new Date(NOW.getTime() + 1000);
    expect(await run({ now: retry })).toEqual({ reminded: true, emailed: true, lastFollowupAt: retry.toISOString() });
    expect(db.tasks[0]).toMatchObject({ last_followup_at: retry.toISOString(), followup_count: 1 });
  });

  it("a task reminded before goes back to exactly its earlier stamp and count", async () => {
    const before = new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString();
    db.tasks[0].last_followup_at = before; db.tasks[0].followup_count = 3;
    notifyPeople.mockResolvedValueOnce(0);
    sendInternalEmail.mockResolvedValueOnce({ status: "failed", providerId: "", errorMessage: "No email provider is configured", provider: "stub" });
    expect(await run()).toMatchObject({ reminded: false, reason: "notice not sent", lastFollowupAt: before });
    expect(db.tasks[0]).toMatchObject({ last_followup_at: before, followup_count: 3 });
  });

  it("the bell notice is not written but the email goes: they were reminded — the stamp stays (as before R-2941)", async () => {
    notifyPeople.mockResolvedValueOnce(0);
    expect(await run()).toEqual({ reminded: true, emailed: true, lastFollowupAt: NOW.toISOString() });
    expect(db.tasks[0]).toMatchObject({ last_followup_at: NOW.toISOString(), followup_count: 1 });
  });

  it("an owner with no email address and no bell notice: nothing went, the stamp is put back", async () => {
    db.users[1].email = null;
    notifyPeople.mockResolvedValueOnce(0);
    expect(await run()).toMatchObject({ reminded: false, reason: "notice not sent" });
    expect(db.tasks[0]).toMatchObject({ last_followup_at: null, followup_count: 0 });
  });

  it("a stamp that is no longer ours is left alone, and the message does not promise a retry", async () => {
    sendInternalEmail.mockRejectedValueOnce(new Error("smtp down"));
    const theirs = new Date(NOW.getTime() + 5000).toISOString();
    notifyPeople.mockImplementationOnce(async () => {
      db.tasks[0].last_followup_at = theirs; db.tasks[0].followup_count = 2;
      return 0;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run()).toMatchObject({ reminded: false, reason: "notice not sent, hour kept" });
    expect(db.tasks[0]).toMatchObject({ last_followup_at: theirs, followup_count: 2 });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("could not be put back"), "stamp no longer ours");
    logged.mockRestore();
  });
});
