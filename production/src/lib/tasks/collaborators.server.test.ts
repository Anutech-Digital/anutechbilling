/**
 * R-2933 — setTaskCollaborators with stub clients: what is written, the limit, who is told.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const db: { tasks: Row[]; users: Row[]; tenants: Row[]; task_collaborators: Row[] } =
  { tasks: [], users: [], tenants: [], task_collaborators: [] };
/** The most rows task_collaborators ever held for the task during a call (a swap must never hold 4). */
let peak = 0;
/** R-2941: what the database answers to the next insert (its guard trigger), when set. */
let insertError: { message: string; code?: string } | null = null;

/** A tiny PostgREST look-alike: eq / in filters; insert appends; delete removes the matched rows. */
function client() {
  return {
    from(table: keyof typeof db) {
      let rows = db[table].slice();
      let del = false;
      const q = {
        select: () => q,
        delete: () => { del = true; return q; },
        insert: async (added: Row[]) => {
          if (insertError) { const error = insertError; insertError = null; return { error }; }
          db[table].push(...added.map((r) => ({ ...r })));
          peak = Math.max(peak, db.task_collaborators.length);
          return { error: null };
        },
        eq: (k: string, v: unknown) => { rows = rows.filter((r) => r[k] === v); return q; },
        in: (k: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[k])); return q; },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (ok: (v: { data: Row[]; error: null }) => unknown) => {
          if (del) db[table] = db[table].filter((r) => !rows.includes(r)) as never;
          return Promise.resolve({ data: rows, error: null }).then(ok);
        },
      };
      return q;
    },
  };
}

const sendInternalEmail = vi.fn(async (_m: Row) => ({ status: "sent", providerId: "x", errorMessage: null, provider: "stub" }));
const notifyPeople = vi.fn(async (_input: Row, _to: { userIds: string[] }) => {});
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => client() }));
vi.mock("@/lib/messaging", () => ({ sendInternalEmail: (m: Row) => sendInternalEmail(m) }));
vi.mock("@/lib/notifications/notify.server", () => ({ notifyPeople: (i: Row, t: { userIds: string[] }) => notifyPeople(i, t) }));
vi.mock("@/lib/app-url", () => ({ appUrl: () => "https://app.example.test" }));
vi.mock("@/lib/api/with-route", () => ({ mayOpenPage: (role: string | null) => role === "owner" || role === "manager" || role === "sales" }));

import { setTaskCollaborators } from "./collaborators.server";
import { NOT_AN_ACTIVE_MEMBER } from "./collaborators";

const T = "t-1", ME = "u-me", HITESH = "u-hitesh", PAWAN = "u-pawan", ABHI = "u-abhi", RIYA = "u-riya";
const TASK = "11111111-1111-4111-8111-111111111111";
const run = (userIds: string[], over: { tenantId?: string } = {}) =>
  setTaskCollaborators(client() as never, { taskId: TASK, tenantId: T, actorId: ME, userIds, ...over });
const saved = () => db.task_collaborators.map((r) => r.user_id).sort();
const user = (id: string, name: string, role = "sales") =>
  ({ id, tenant_id: T, full_name: name, email: `${name.toLowerCase()}@example.test`, is_active: true, role });

beforeEach(() => {
  sendInternalEmail.mockClear(); notifyPeople.mockClear(); peak = 0; insertError = null;
  db.tenants = [{ id: T, name: "E2E Test Co" }];
  db.users = [user(ME, "Pardeep", "owner"), user(HITESH, "Hitesh"), user(PAWAN, "Pawan"), user(ABHI, "Abhishek"), user(RIYA, "Riya")];
  db.tasks = [{
    id: TASK, tenant_id: T, title: "Call Acme", notes: null, due_at: "2026-11-19T10:00:00Z", owner_id: HITESH,
    lead_id: null, quote_id: null, customer_id: null, subscription_id: null,
  }];
  db.task_collaborators = [];
});

describe("R-2933 setTaskCollaborators", () => {
  it("adds the people picked (stamped with who added them) and tells each one — bell + email", async () => {
    expect(await run([PAWAN, ABHI])).toEqual({ ok: true, userIds: [PAWAN, ABHI], added: [PAWAN, ABHI], removed: [], notified: 2 });
    expect(saved()).toEqual([ABHI, PAWAN].sort());
    expect(db.task_collaborators[0]).toMatchObject({ tenant_id: T, task_id: TASK, added_by: ME });

    expect(notifyPeople).toHaveBeenCalledTimes(2);
    expect(notifyPeople.mock.calls[0][0]).toMatchObject({ kind: "task.assigned", title: "Pardeep added you to a task: Call Acme", entityId: TASK });
    expect(notifyPeople.mock.calls.map((c) => c[1].userIds[0]).sort()).toEqual([ABHI, PAWAN].sort());
    expect(sendInternalEmail).toHaveBeenCalledTimes(2);
    const mail = sendInternalEmail.mock.calls[0][0] as { to: string; subject: string; text: string; kind: string; route: Row };
    expect(mail).toMatchObject({ to: "pawan@example.test", subject: "Added to a task: Call Acme", kind: "task_collaborator", route: { tenantId: T } });
    expect(mail.text).toContain("(owner: Hitesh)");
  });

  it("saving the same list again writes nothing and tells nobody", async () => {
    await run([PAWAN]);
    notifyPeople.mockClear(); sendInternalEmail.mockClear();
    expect(await run([PAWAN])).toMatchObject({ ok: true, added: [], removed: [], notified: 0 });
    expect(saved()).toEqual([PAWAN]);
    expect(notifyPeople).not.toHaveBeenCalled();
    expect(sendInternalEmail).not.toHaveBeenCalled();
  });

  it("a change tells only the person newly added; the removed person's row goes", async () => {
    await run([PAWAN, ABHI]);
    notifyPeople.mockClear();
    expect(await run([ABHI, RIYA])).toMatchObject({ ok: true, added: [RIYA], removed: [PAWAN], notified: 1 });
    expect(saved()).toEqual([ABHI, RIYA].sort());
    expect(notifyPeople).toHaveBeenCalledTimes(1);
    expect(notifyPeople.mock.calls[0][1]).toEqual({ userIds: [RIYA] });
  });

  it("a 4th person is refused and nothing is written", async () => {
    await run([PAWAN, ABHI, RIYA]);
    notifyPeople.mockClear();
    const r = await run([PAWAN, ABHI, RIYA, ME]);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((r as { error: string }).error).toContain("up to 3 people");
    expect(saved()).toHaveLength(3);
    expect(notifyPeople).not.toHaveBeenCalled();
  });

  it("swapping one person at the limit never holds 4 rows", async () => {
    await run([PAWAN, ABHI, RIYA]);
    peak = 3;
    expect(await run([PAWAN, ABHI, ME])).toMatchObject({ ok: true, added: [ME], removed: [RIYA] });
    expect(peak).toBe(3);
  });

  it("the task's owner is never also a collaborator; adding myself tells nobody", async () => {
    expect(await run([HITESH, ME])).toMatchObject({ ok: true, userIds: [ME], added: [ME], notified: 0 });
    expect(saved()).toEqual([ME]);
    expect(notifyPeople).not.toHaveBeenCalled();
  });

  it("someone from another company, or who has left, is refused", async () => {
    db.users.push({ ...user("u-out", "Outsider"), tenant_id: "t-other" });
    expect(await run(["u-out"])).toMatchObject({ ok: false, status: 409 });
    db.users[2].is_active = false;
    expect(await run([PAWAN])).toMatchObject({ ok: false, status: 409 });
    expect(saved()).toEqual([]);
  });

  it("a task of another company is not found (the read is pinned to the caller's tenant)", async () => {
    expect(await run([PAWAN], { tenantId: "t-other" })).toMatchObject({ ok: false, status: 404 });
    expect(saved()).toEqual([]);
  });

  it("an empty list removes everyone", async () => {
    await run([PAWAN, ABHI]);
    expect(await run([])).toMatchObject({ ok: true, userIds: [], removed: [PAWAN, ABHI] });
    expect(saved()).toEqual([]);
  });

  it("an email that fails does not undo the row or the bell notice", async () => {
    sendInternalEmail.mockRejectedValueOnce(new Error("smtp down"));
    expect(await run([PAWAN])).toMatchObject({ ok: true, added: [PAWAN], notified: 1 });
    expect(saved()).toEqual([PAWAN]);
  });
});

describe("R-2941 the database's own refusals reach the person as plain words", () => {
  it("a 4th person refused by the database (two saves at the same moment) → 409 with the limit message, nobody told", async () => {
    insertError = { code: "23514", message: "R-2941: a task can have up to 3 people working with its owner — remove one to add another" };
    expect(await run([PAWAN])).toEqual({ ok: false, status: 409, error: "A task can have up to 3 people working with its owner — remove one to add another." });
    expect(saved()).toEqual([]);
    expect(notifyPeople).not.toHaveBeenCalled();
  });

  it("a person the database says is not in this company → 409, pick again", async () => {
    insertError = { code: "23503", message: "R-2941: this task or this person is not in this company" };
    expect(await run([PAWAN])).toEqual({ ok: false, status: 409, error: NOT_AN_ACTIVE_MEMBER });
    expect(notifyPeople).not.toHaveBeenCalled();
  });

  it("any other database error is still a crash (500), never a made-up message", async () => {
    insertError = { code: "08006", message: "connection reset" };
    await expect(run([PAWAN])).rejects.toThrow("collaborators insert failed: connection reset");
  });
});
