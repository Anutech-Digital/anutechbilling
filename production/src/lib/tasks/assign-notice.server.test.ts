/**
 * R-2925 — sendTaskAssignedNotice with stub clients: who is told, once, and what the mail says.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const db: { tasks: Row[]; users: Row[]; notifications: Row[]; tenants: Row[]; updates: { table: string; patch: Row }[] } =
  { tasks: [], users: [], notifications: [], tenants: [], updates: [] };

/** A tiny PostgREST look-alike: eq / in / is filters over the in-memory rows. */
function client() {
  return {
    from(table: keyof Omit<typeof db, "updates">) {
      let rows = [...db[table]];
      let patch: Row | null = null;
      const q = {
        select: () => q,
        update: (p: Row) => { patch = p; return q; },
        eq: (k: string, v: unknown) => { rows = rows.filter((r) => r[k] === v); return q; },
        in: (k: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[k])); return q; },
        order: (k: string) => { rows = [...rows].sort((a, b) => String(b[k]).localeCompare(String(a[k]))); return q; },
        limit: () => q,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (ok: (v: { data: Row[]; error: null }) => unknown) => {
          if (patch) { db.updates.push({ table, patch }); for (const r of rows) Object.assign(r, patch); }
          return Promise.resolve({ data: rows, error: null }).then(ok);
        },
      };
      return q;
    },
  };
}

const sendInternalEmail = vi.fn(async (_m: Row) => ({ status: "sent", providerId: "x", errorMessage: null, provider: "stub" }));
const notifyPeople = vi.fn(async (input: Row, to: { userIds: string[] }) => {
  for (const id of to.userIds) db.notifications.push({ tenant_id: input.tenantId, user_id: id, kind: input.kind, entity_id: input.entityId, read_at: null, title: input.title, href: input.href, created_at: new Date().toISOString() });
});
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => client() }));
vi.mock("@/lib/messaging", () => ({ sendInternalEmail: (m: Row) => sendInternalEmail(m) }));
vi.mock("@/lib/notifications/notify.server", () => ({ notifyPeople: (i: Row, t: { userIds: string[] }) => notifyPeople(i, t) }));
vi.mock("@/lib/app-url", () => ({ appUrl: () => "https://app.example.test" }));
vi.mock("@/lib/api/with-route", () => ({ mayOpenPage: (role: string | null) => role === "owner" || role === "manager" || role === "sales" }));

import { sendTaskAssignedNotice } from "./assign-notice.server";

const T = "t-1", ME = "u-me", HITESH = "u-hitesh", TASK = "11111111-1111-4111-8111-111111111111";
const run = (taskId = TASK, tenantId = T) =>
  sendTaskAssignedNotice(client() as never, { taskId, tenantId, actorId: ME });

beforeEach(() => {
  sendInternalEmail.mockClear(); notifyPeople.mockClear();
  db.updates = [];
  db.notifications = [];
  db.tenants = [{ id: T, name: "E2E Test Co" }];
  db.users = [
    { id: ME, tenant_id: T, full_name: "Pardeep Sharma", email: "p@example.test", is_active: true, role: "owner" },
    { id: HITESH, tenant_id: T, full_name: "Hitesh", email: "h@example.test", is_active: true, role: "sales" },
  ];
  db.tasks = [{
    id: TASK, tenant_id: T, title: "Call Acme", notes: "Ask for the PO", due_at: "2026-11-19T10:00:00Z",
    owner_id: HITESH, delegated_by: ME, delegated_at: new Date(Date.now() - 2000).toISOString(), lead_id: null, quote_id: null, customer_id: "c-1", subscription_id: null, customers: { name: "Acme Pvt Ltd" },
  }];
});

describe("R-2925 sendTaskAssignedNotice", () => {
  it("a task I just gave to a teammate: one bell notice to them, one email with the details", async () => {
    expect(await run()).toEqual({ notified: true, emailed: true });

    expect(notifyPeople).toHaveBeenCalledTimes(1);
    const [n, to] = notifyPeople.mock.calls[0];
    expect(to).toEqual({ userIds: [HITESH] });
    expect(n).toMatchObject({ tenantId: T, kind: "task.assigned", title: "New task from Pardeep Sharma: Call Acme", entityId: TASK, href: `/tasks?tab=all&task=${TASK}` });

    expect(sendInternalEmail).toHaveBeenCalledTimes(1);
    const mail = sendInternalEmail.mock.calls[0][0] as { to: string; subject: string; text: string; route: Row; kind: string };
    expect(mail.to).toBe("h@example.test");
    expect(mail.subject).toBe("New task: Call Acme");
    expect(mail.text).toContain("Customer: Acme Pvt Ltd — https://app.example.test/customers/c-1");
    expect(mail.text).toContain(`https://app.example.test/tasks?tab=all&task=${TASK}`);
    expect(mail.route).toEqual({ tenantId: T });
    expect(mail.kind).toBe("task_assigned");

    expect(db.updates).toHaveLength(0); // the server only reads the task — the save itself stamped who handed it over
  });

  it("a task someone ELSE handed over (or nobody did): I cannot have the owner told", async () => {
    db.tasks[0].delegated_by = "u-manager";
    expect(await run()).toMatchObject({ notified: false, reason: "not your assignment" });
    db.tasks[0].delegated_by = null; db.tasks[0].delegated_at = null;
    expect(await run()).toMatchObject({ notified: false, reason: "not your assignment" });
    expect(notifyPeople).not.toHaveBeenCalled();
    expect(sendInternalEmail).not.toHaveBeenCalled();
  });

  it("an old notice from an earlier hand-over does not block this one", async () => {
    db.notifications.push({ tenant_id: T, user_id: HITESH, kind: "task.assigned", entity_id: TASK, read_at: null, created_at: "2026-11-01T00:00:00.000Z" });
    expect(await run()).toEqual({ notified: true, emailed: true });
  });

  it("an accountant (cannot open Tasks) is told, with a link they can open", async () => {
    db.users[1].role = "accountant";
    expect(await run()).toEqual({ notified: true, emailed: true });
    expect(notifyPeople.mock.calls[0][0]).toMatchObject({ href: "/dashboard" });
    expect((sendInternalEmail.mock.calls[0][0] as { text: string }).text).toContain("Open the app: https://app.example.test/dashboard");
  });

  it("a second call for the same hand-over sends nothing more", async () => {
    await run();
    expect(await run()).toMatchObject({ notified: false, reason: "already told" });
    expect(notifyPeople).toHaveBeenCalledTimes(1);
    expect(sendInternalEmail).toHaveBeenCalledTimes(1);
  });

  it("my own task: nothing is sent", async () => {
    db.tasks[0].owner_id = ME;
    expect(await run()).toMatchObject({ notified: false, emailed: false, reason: "own task" });
    expect(notifyPeople).not.toHaveBeenCalled();
    expect(sendInternalEmail).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  it("a task of another company is not found (the read is pinned to the caller's tenant)", async () => {
    expect(await run(TASK, "t-other")).toMatchObject({ notified: false, reason: "task not found" });
    expect(notifyPeople).not.toHaveBeenCalled();
  });

  it("an owner who is not an active member of this company gets nothing", async () => {
    db.users[1].is_active = false;
    expect(await run()).toMatchObject({ notified: false, reason: "owner not in this company" });
    db.users[1] = { ...db.users[1], is_active: true, tenant_id: "t-other" };
    expect(await run()).toMatchObject({ notified: false, reason: "owner not in this company" });
    expect(sendInternalEmail).not.toHaveBeenCalled();
  });

  it("the email failing does not undo the bell notice", async () => {
    sendInternalEmail.mockRejectedValueOnce(new Error("smtp down"));
    expect(await run()).toEqual({ notified: true, emailed: false });
    expect(db.notifications).toHaveLength(1);
  });

  it("an owner with no email still gets the bell notice", async () => {
    db.users[1].email = null;
    expect(await run()).toEqual({ notified: true, emailed: false });
    expect(sendInternalEmail).not.toHaveBeenCalled();
  });
});
