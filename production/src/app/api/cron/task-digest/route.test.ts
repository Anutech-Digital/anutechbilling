/**
 * R-2929 — the morning task digest cron. The card's check, as a test:
 *   1. a team member has 2 overdue tasks;
 *   2. the cron runs;
 *   3. their email lists both tasks — and a second run the same day sends nothing.
 * Email and WhatsApp are mocked; nothing real is sent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
/* R-897: route logic under test — the automation gate has its own tests (_lib/automation-gate.test.ts). */
const gate = vi.hoisted(() => ({
  allowed: (_t: string) => true as boolean, would: [] as unknown[],
  run: null as null | { allTenants: boolean; tenants: Set<string> },
}));
vi.mock("@/lib/automation/cron-gate", () => ({
  gatedCron: (_job: string, h: unknown) => h,
  cronTenantAllowed: (t: string) => gate.allowed(t),
  isCronDryRun: () => false,
  noteWouldSend: (e: unknown) => { gate.would.push(e); },
  currentCronRun: () => gate.run,
}));
import { fakePostgrest } from "@/lib/ops/fake-postgrest.testutil";

type EmailArg = { to: string; subject: string; text: string; route?: { tenantId: string } };
type WaArg = { tenantId: string; to: string; message: { kind: string; name: string; language: string; components: unknown } };
const db = vi.hoisted(() => ({ current: null as null | { from: (t: string) => unknown } }));
const sendEmail = vi.hoisted(() => vi.fn(async (_m: unknown) => ({ status: "sent", providerId: "p1", errorMessage: null as string | null, provider: "resend" })));
const sendWhatsApp = vi.hoisted(() => vi.fn(async (_o: unknown) => ({ wamid: "w1", status: "sent", raw: null })));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => db.current! }));
vi.mock("@/lib/email/send", () => ({ sendEmail, isEmailConfigured: () => true }));
vi.mock("@/lib/whatsapp/client", () => ({
  sendWhatsApp, resolveWhatsAppCreds: vi.fn(async () => null), toE164: (s: string) => s,
}));
vi.mock("@/lib/ops/heartbeat", () => ({ pingHeartbeat: vi.fn() }));

import { GET } from "./route";

const ENV = { ...process.env };
/* "Now" = 18 Nov 2026, 09:30 IST. */
const NOW = new Date("2026-11-18T04:00:00Z");

type Row = Record<string, unknown>;

/** A seed user row carries its company + role; the route reads those from tenant_memberships. */
function withMemberships(tables: Record<string, Row[]>): Record<string, Row[]> {
  if (tables.tenant_memberships) return tables;
  return {
    ...tables,
    tenant_memberships: (tables.users ?? []).map((u, i) => ({
      id: `m${String(i).padStart(3, "0")}`, user_id: u.id, tenant_id: u.tenant_id, role: u.role,
      is_active: u.is_active, access_ends_on: u.access_ends_on ?? null, ended_at: u.ended_at ?? null,
    })),
  };
}

/** fakePostgrest + the one thing the real table adds: unique (user_id, digest_date, kind). */
function database(seed: Record<string, Row[]>) {
  /* tasks.is_goal is NOT NULL DEFAULT false in the database (R-2957) — a seed row that does not say is a plain task. */
  const tables = { ...seed, ...(seed.tasks ? { tasks: seed.tasks.map((t) => ({ is_goal: false, ...t })) } : {}) };
  const fake = fakePostgrest({ task_digest_log: [], whatsapp_templates: [], whatsapp_opt_outs: [], holidays: [], ...withMemberships(tables) });
  const client = {
    from(table: string) {
      const b = fake.client.from(table) as unknown as { insert: (p: Row) => unknown };
      if (table !== "task_digest_log") return b;
      const insert = b.insert.bind(b);
      b.insert = (p: Row) => {
        const dup = fake.tables.task_digest_log.some((r) =>
          r.tenant_id === p.tenant_id && r.user_id === p.user_id && r.digest_date === p.digest_date && r.kind === p.kind);
        if (dup) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
        return insert(p);
      };
      return b;
    },
  };
  return { client, tables: fake.tables };
}

const T = "tenant-1";
const USERS: Row[] = [
  { id: "u-owner", tenant_id: T, email: "asha@example.invalid", full_name: "Asha Owner", role: "owner", is_active: true, phone: "9811111111", phone_verified_at: "2026-11-01T00:00:00Z" },
  { id: "u-ravi", tenant_id: T, email: "Ravi@Example.invalid", full_name: "Ravi Kumar", role: "sales", is_active: true, phone: "98222 22222", phone_verified_at: "2026-11-01T00:00:00Z" },
  { id: "u-meena", tenant_id: T, email: "meena@example.invalid", full_name: "Meena Shah", role: "sales", is_active: true, phone: null },
];
const TASKS: Row[] = [
  { id: "t1", tenant_id: T, owner_id: "u-ravi", title: "Call Sharma ji about renewal", due_at: "2026-11-15T06:00:00Z", status: "pending", parent_task_id: "g1" },
  { id: "t2", tenant_id: T, owner_id: "u-ravi", title: "Send revised quote", due_at: "2026-11-17T06:00:00Z", status: "snoozed" },
  /* Not in any digest: finished, dropped, or due later. */
  { id: "t3", tenant_id: T, owner_id: "u-ravi", title: "Already done", due_at: "2026-11-10T06:00:00Z", status: "done" },
  { id: "t4", tenant_id: T, owner_id: "u-ravi", title: "Dropped", due_at: "2026-11-10T06:00:00Z", status: "cancelled" },
  { id: "t5", tenant_id: T, owner_id: "u-meena", title: "Next week", due_at: "2026-11-25T06:00:00Z", status: "pending" },
  /* R-2957: an overdue GOAL row is not in any digest — its sub-tasks are the work (t1 is one of them). */
  { id: "g1", tenant_id: T, owner_id: "u-ravi", title: "Goal row, not work", due_at: "2026-11-14T06:00:00Z", status: "pending", is_goal: true },
];

const req = (qs = "", secret = "s3cret") =>
  new Request(`https://example.invalid/api/cron/task-digest${qs}`, { headers: { authorization: `Bearer ${secret}` } });
const emails = () => sendEmail.mock.calls.map((c) => c[0] as EmailArg);
const emailTo = (to: string) => emails().find((m) => m.to === to);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.CRON_SECRET = "s3cret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.invalid";
  delete process.env.HEARTBEAT_PING_URL;
  gate.allowed = () => true;
  gate.would = [];
  gate.run = null;
  sendEmail.mockClear();
  sendWhatsApp.mockClear();
});
afterEach(() => { vi.useRealTimers(); process.env = { ...ENV }; });

describe("auth — fail closed", () => {
  it("no CRON_SECRET → 503; wrong bearer → 401; nothing read", async () => {
    db.current = { from: () => { throw new Error("database touched"); } };
    expect((await GET(req("", "wrong"))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(req())).status).toBe(503);
  });
});

describe("the card's check: 2 overdue tasks → one email with both", () => {
  it("the member's email lists both overdue tasks; done / cancelled / later tasks are not in it", async () => {
    const d = database({ users: USERS, tasks: TASKS });
    db.current = d.client;
    const body = await (await GET(req())).json();

    expect(body.errors).toEqual([]);
    const mail = emailTo("ravi@example.invalid")!;
    expect(mail.subject).toBe("Your tasks for 18 Nov 2026: 2 overdue");
    expect(mail.text).toContain("- Call Sharma ji about renewal (was due 15 Nov 2026, 3 days late)");
    expect(mail.text).toContain("- Send revised quote (was due 17 Nov 2026, 1 day late)");
    expect(mail.text).toContain("Open your tasks: https://app.example.invalid/tasks");
    expect(mail.text).not.toMatch(/Already done|Dropped|Next week/);
    /* The company's own mail route. */
    expect(mail.route).toEqual({ tenantId: T });
  });

  it("a person with nothing overdue or due today gets nothing; the owner gets ONE team summary", async () => {
    db.current = database({ users: USERS, tasks: TASKS }).client;
    const body = await (await GET(req())).json();

    expect(emails().map((m) => m.to).sort()).toEqual(["asha@example.invalid", "ravi@example.invalid"]);
    const owner = emailTo("asha@example.invalid")!;
    expect(owner.subject).toBe("Team tasks for 18 Nov 2026: 2 overdue");
    expect(owner.text).toContain("- Ravi Kumar: 2 overdue");
    expect(owner.text).not.toContain("Meena");
    expect(body.sent).toBe(2);
    expect(body.considered).toBe(2);
  });

  it("the cron runs twice the same day → the second run sends nothing", async () => {
    const d = database({ users: USERS, tasks: TASKS });
    db.current = d.client;
    await GET(req());
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(d.tables.task_digest_log).toHaveLength(2);
    expect(d.tables.task_digest_log.find((r) => r.user_id === "u-ravi")).toMatchObject({
      tenant_id: T, digest_date: "2026-11-18", kind: "personal", overdue_count: 2, today_count: 0, email_status: "sent",
    });

    const second = await (await GET(req())).json();
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(second.sent).toBe(0);
    expect(second.skipped_already_sent).toBe(2);
    expect(d.tables.task_digest_log).toHaveLength(2);
  });

  it("two runs at the same moment: the unique index stops the second even when its pre-read saw nothing", async () => {
    const d = database({ users: USERS, tasks: TASKS });
    /* The other run's rows land AFTER this run read the log: hide them from the read only. */
    d.tables.task_digest_log.push(
      { tenant_id: T, user_id: "u-ravi", digest_date: "2026-11-18", kind: "personal", hidden: true },
      { tenant_id: T, user_id: "u-owner", digest_date: "2026-11-18", kind: "owner_summary", hidden: true },
    );
    db.current = {
      from(table: string) {
        const b = d.client.from(table) as unknown as { select: (c?: string) => { neq: (c: string, v: unknown) => unknown } };
        if (table !== "task_digest_log") return b;
        const select = b.select.bind(b);
        b.select = (c?: string) => { const q = select(c); q.neq("hidden", true); return q; };
        return b;
      },
    };
    const body = await (await GET(req())).json();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(body.skipped_already_sent).toBe(2);
  });

  it("next day the same overdue tasks are sent again (one a day, not one ever)", async () => {
    const d = database({ users: USERS, tasks: TASKS });
    db.current = d.client;
    await GET(req());
    vi.setSystemTime(new Date("2026-11-19T04:00:00Z"));
    const body = await (await GET(req())).json();
    expect(body.sent).toBe(2);
    expect(emails().at(-1)!.subject).toContain("19 Nov 2026");
  });
});

describe("nothing to say → nothing sent", () => {
  it("no overdue or today task in the company → no email, not even to the owner, no log row", async () => {
    const d = database({ users: USERS, tasks: TASKS.filter((t) => t.id === "t5" || t.id === "t3") });
    db.current = d.client;
    const body = await (await GET(req())).json();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(body).toMatchObject({ tenants: 0, sent: 0, considered: 0 });
    expect(d.tables.task_digest_log).toEqual([]);
  });
});

describe("practice run", () => {
  it("?dry=1 lists who would get what, sends nothing, writes nothing", async () => {
    const d = database({ users: USERS, tasks: TASKS });
    db.current = d.client;
    const body = await (await GET(req("?dry=1"))).json();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendWhatsApp).not.toHaveBeenCalled();
    expect(d.tables.task_digest_log).toEqual([]);
    expect(body.dry_run).toBe(true);
    expect(gate.would).toEqual([
      { tenantId: T, to: "ravi@example.invalid", channel: "email", kind: "task_digest_personal" },
      { tenantId: T, to: "asha@example.invalid", channel: "email", kind: "task_digest_owner_summary" },
    ]);
    expect(body.details).toEqual([
      { tenant: T, user: "u-ravi", kind: "personal", to: "ravi@example.invalid", overdue: 2, today: 0, email: "(dry run)", whatsapp: "no_template" },
      { tenant: T, user: "u-owner", kind: "owner_summary", to: "asha@example.invalid", overdue: 0, today: 0, email: "(dry run)", whatsapp: "no_template" },
    ]);
  });

  it("`on` is refused on a live run", async () => {
    db.current = database({ users: USERS, tasks: TASKS }).client;
    expect((await GET(req("?on=2026-11-20"))).status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("WhatsApp copy", () => {
  it("no approved task_daily_digest template → email only, and the result says so", async () => {
    db.current = database({
      users: USERS, tasks: TASKS,
      whatsapp_templates: [{ id: "w0", tenant_id: T, name: "task_daily_digest", language: "en", status: "submitted" }],
    }).client;
    const body = await (await GET(req())).json();
    expect(sendWhatsApp).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(body.whatsapp.no_template).toBe(2);
    expect(body.whatsapp_note).toContain("email only");
    expect(body.whatsapp_note).toContain("task_daily_digest");
  });

  it("approved template + phone → the template goes with name, counts and task names", async () => {
    const d = database({
      users: USERS, tasks: TASKS,
      whatsapp_templates: [{ id: "w1", tenant_id: T, name: "task_daily_digest", language: "en_US", status: "approved" }],
    });
    db.current = d.client;
    const body = await (await GET(req())).json();
    const toRavi = sendWhatsApp.mock.calls.map((c) => c[0] as WaArg).find((o) => o.to === "+919822222222")!;
    expect(toRavi.tenantId).toBe(T);
    expect(toRavi.message).toMatchObject({ kind: "template", name: "task_daily_digest", language: "en_US" });
    expect(JSON.stringify(toRavi.message.components)).toContain("Call Sharma ji about renewal; Send revised quote");
    expect(JSON.stringify(toRavi.message.components)).toContain("2 overdue");
    expect(body.whatsapp.sent).toBe(2);
    expect(body.whatsapp_note).toBeNull();
    expect(d.tables.task_digest_log.find((r) => r.user_id === "u-ravi")).toMatchObject({ whatsapp_status: "sent", whatsapp_skip_reason: null });
  });

  it("a number that said STOP gets the email, not the WhatsApp; no phone → email only", async () => {
    const d = database({
      users: USERS.map((u) => (u.id === "u-owner" ? { ...u, phone: null } : u)), tasks: TASKS,
      whatsapp_templates: [{ id: "w1", tenant_id: T, name: "task_daily_digest", language: "en", status: "approved" }],
      whatsapp_opt_outs: [{ tenant_id: T, phone: "+919822222222", reason: "stop" }],
    });
    db.current = d.client;
    const body = await (await GET(req())).json();
    expect(sendWhatsApp).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(body.whatsapp).toMatchObject({ opted_out: 1, no_phone: 1, sent: 0 });
    expect(d.tables.task_digest_log.find((r) => r.user_id === "u-ravi")).toMatchObject({ whatsapp_status: "skipped", whatsapp_skip_reason: "opted_out" });
  });
});

describe("failures and switches", () => {
  it("one failed email is recorded and does not stop the next person", async () => {
    sendEmail.mockResolvedValueOnce({ status: "failed", providerId: "", errorMessage: "mailbox full", provider: "resend" });
    const d = database({ users: USERS, tasks: TASKS });
    db.current = d.client;
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ sent: 1, failed: 1 });
    expect(body.errors[0].message).toContain("mailbox full");
    /* Nothing went out for Ravi → his claim is released, so a Retry can send it. */
    expect(d.tables.task_digest_log.find((r) => r.user_id === "u-ravi")).toBeUndefined();
    expect(d.tables.task_digest_log.find((r) => r.user_id === "u-owner")).toMatchObject({ email_status: "sent" });

    const retry = await (await GET(req())).json();
    expect(retry).toMatchObject({ sent: 1, failed: 0, skipped_already_sent: 1 });
    expect(emails().at(-1)!.to).toBe("ravi@example.invalid");
    expect(emails().filter((m) => m.to === "asha@example.invalid")).toHaveLength(1);
  });

  it("a company whose switch is off is not read into the run", async () => {
    gate.allowed = (t) => t !== T;
    db.current = database({ users: USERS, tasks: TASKS }).client;
    const body = await (await GET(req())).json();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(body.tenants).toBe(0);
  });

  it("another company's tasks never reach this company's people", async () => {
    db.current = database({
      users: [...USERS, { id: "u-b", tenant_id: "tenant-2", email: "b@example.invalid", full_name: "B Owner", role: "owner", is_active: true, phone: null }],
      tasks: [...TASKS, { id: "x1", tenant_id: "tenant-2", owner_id: "u-b", title: "Other company secret", due_at: "2026-11-16T06:00:00Z", status: "pending" }],
    }).client;
    await GET(req());
    expect(emailTo("b@example.invalid")!.text).toContain("Other company secret");
    for (const m of emails().filter((x) => x.to !== "b@example.invalid")) expect(m.text).not.toContain("Other company secret");
    expect(emailTo("b@example.invalid")!.text).not.toContain("Ravi");
  });
});

describe("review fixes — who counts as the team, and when", () => {
  it("Sunday → nobody is messaged", async () => {
    vi.setSystemTime(new Date("2026-11-22T04:00:00Z")); // Sunday 22 Nov 2026, 09:30 IST
    const d = database({ users: USERS, tasks: TASKS });
    db.current = d.client;
    const body = await (await GET(req())).json();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(body).toMatchObject({ day_off: 1, tenants: 0, sent: 0 });
    expect(d.tables.task_digest_log).toEqual([]);
  });

  it("the company's own holiday → that company is skipped, the other still gets its digest", async () => {
    db.current = database({
      users: [...USERS, { id: "u-b", tenant_id: "tenant-2", email: "b@example.invalid", full_name: "B Owner", role: "owner", is_active: true, phone: null }],
      tasks: [...TASKS, { id: "x1", tenant_id: "tenant-2", owner_id: "u-b", title: "Their task", due_at: "2026-11-16T06:00:00Z", status: "pending" }],
      holidays: [{ id: "h1", tenant_id: T, holiday_date: "2026-11-18" }],
    }).client;
    const body = await (await GET(req())).json();
    expect(emails().map((m) => m.to)).toEqual(["b@example.invalid"]);
    expect(body).toMatchObject({ day_off: 1, tenants: 1, sent: 1 });
  });

  it("one login in two companies gets each company's digest, whichever company it has selected", async () => {
    /* Ravi's users row points at tenant-2 (selected now); his overdue tasks are in tenant-1. */
    const d = database({
      users: [USERS[0], { ...USERS[1], tenant_id: "tenant-2" }],
      tenant_memberships: [
        { id: "m1", user_id: "u-owner", tenant_id: T, role: "owner", is_active: true, access_ends_on: null, ended_at: null },
        { id: "m2", user_id: "u-ravi", tenant_id: T, role: "sales", is_active: true, access_ends_on: null, ended_at: null },
        { id: "m3", user_id: "u-ravi", tenant_id: "tenant-2", role: "owner", is_active: true, access_ends_on: null, ended_at: null },
      ],
      tasks: [...TASKS, { id: "x1", tenant_id: "tenant-2", owner_id: "u-ravi", title: "Second company task", due_at: "2026-11-16T06:00:00Z", status: "pending" }],
    });
    db.current = d.client;
    const body = await (await GET(req())).json();
    const toRavi = emails().filter((m) => m.to === "ravi@example.invalid");
    expect(toRavi.map((m) => m.subject).sort()).toEqual([
      "Team tasks for 18 Nov 2026: 1 overdue",
      "Your tasks for 18 Nov 2026: 2 overdue",
    ]);
    expect(toRavi.find((m) => m.subject.startsWith("Your"))!.text).not.toContain("Second company task");
    expect(body.sent).toBe(3);
    /* Each company has its own once-a-day slot for him. */
    expect(d.tables.task_digest_log.filter((r) => r.user_id === "u-ravi").map((r) => r.tenant_id).sort()).toEqual([T, "tenant-2"]);
  });

  it("a member whose last working day has passed (or whose membership ended) is not messaged; the owner sees them as inactive", async () => {
    db.current = database({
      users: [USERS[0], { ...USERS[1], access_ends_on: "2026-11-10" }, { ...USERS[2], ended_at: "2026-11-01T00:00:00Z" }],
      tasks: [...TASKS, { id: "m1", tenant_id: T, owner_id: "u-meena", title: "Left behind", due_at: "2026-11-12T06:00:00Z", status: "pending" }],
    }).client;
    const body = await (await GET(req())).json();
    expect(emails().map((m) => m.to)).toEqual(["asha@example.invalid"]);
    expect(emails()[0].text).toContain("- Ravi Kumar (inactive): 2 overdue");
    expect(emails()[0].text).toContain("- Meena Shah (inactive): 1 overdue");
    expect(body.not_reachable).toBe(2);
  });

  it("WhatsApp only to an OTP-verified number", async () => {
    db.current = database({
      users: USERS.map((u) => ({ ...u, phone_verified_at: u.id === "u-owner" ? u.phone_verified_at : null })), tasks: TASKS,
      whatsapp_templates: [{ id: "w1", tenant_id: T, name: "task_daily_digest", language: "en", status: "approved" }],
    }).client;
    const body = await (await GET(req())).json();
    expect(sendWhatsApp.mock.calls.map((c) => (c[0] as WaArg).to)).toEqual(["+919811111111"]);
    expect(body.whatsapp).toMatchObject({ sent: 1, no_phone: 1 });
  });

  it("the gate names the companies of this pass → only their tasks are read", async () => {
    gate.run = { allTenants: false, tenants: new Set(["tenant-2"]) };
    gate.allowed = (t) => t === "tenant-2";
    db.current = database({ users: USERS, tasks: TASKS }).client;
    const body = await (await GET(req())).json();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(body.tenants).toBe(0);
  });

  it("`on` must be a real date", async () => {
    db.current = database({ users: USERS, tasks: TASKS }).client;
    expect((await GET(req("?dry=1&on=2026-13-45"))).status).toBe(400);
  });
});
