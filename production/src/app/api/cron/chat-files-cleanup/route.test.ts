/**
 * R-2337 (G-TEAMCHAT): the nightly sweep of team chat files that belong to no message.
 *
 * R-2332 left one gap: a file removed from the composer, or a file of a deleted message, is
 * deleted by the BROWSER; when that delete fails, the object stays in storage. SQL cannot delete
 * storage bytes (storage.protect_delete), so this cron does it with the service role through the
 * Storage API. These tests run the real route against an in-memory storage bucket + tables.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
/* Route logic under test — the automation gate is passed through here; it has its own tests (_lib/automation-gate.test.ts). */
vi.mock("@/lib/automation/cron-gate", () => ({
  gatedCron: (_job: string, h: unknown) => h,
  cronTenantAllowed: () => true,
  isCronDryRun: () => false,
  noteWouldSend: () => {},
  currentCronRun: () => null,
}));
vi.mock("@/lib/ops/heartbeat", () => ({ pingHeartbeat: vi.fn() }));
import { fakePostgrest } from "@/lib/ops/fake-postgrest.testutil";
import { fakeStorage } from "@/lib/team-chat/fake-storage.testutil";

const db = vi.hoisted(() => ({ current: null as null | { client: unknown } }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => db.current!.client }));

import { GET, POST } from "./route";
import { MAX_DELETES_PER_RUN } from "@/lib/team-chat/orphan-sweep";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U = (n: number) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);
const file = (t: string, c: string, n: number, name = "report.pdf") => `${t}/chat/${c}/${U(n)}_${name}`;

const NOW = Date.parse("2026-11-01T20:00:00Z");
const HOURS = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const req = (qs = "", secret: string | null = "s3cret") =>
  new Request(`https://example.invalid/api/cron/chat-files-cleanup${qs}`, {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  });
const ENV = { ...process.env };

function setup(objects: { path: string; created_at: string }[], tables: Record<string, Record<string, unknown>[]> = {}) {
  const storage = fakeStorage({ documents: objects });
  const pg = fakePostgrest({
    tenants: [{ id: T1 }, { id: T2 }],
    chat_attachments: [],
    chat_upload_tickets: [],
    ...tables,
  });
  db.current = { client: { ...pg.client, storage: storage.client } };
  return { storage, pg };
}

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ENV };
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("chat-files-cleanup — what is deleted and what is kept", () => {
  it("deletes an orphan older than a day; keeps an attached file, a fresh file and an open-ticket file", async () => {
    const orphan = file(T1, C1, 1, "left-behind.pdf");
    const attached = file(T1, C1, 2, "on-a-message.pdf");
    const fresh = file(T1, C1, 3, "still-in-composer.pdf");
    const ticket = file(T1, C2, 4, "uploading.pdf");
    const { storage } = setup(
      [
        { path: orphan, created_at: HOURS(30) },
        { path: attached, created_at: HOURS(72) },
        { path: fresh, created_at: HOURS(2) },
        { path: ticket, created_at: HOURS(48) },
      ],
      {
        chat_attachments: [{ tenant_id: T1, channel_id: C1, file_path: attached }],
        chat_upload_tickets: [{ path: ticket, tenant_id: T1 }],
      },
    );

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(storage.removed).toEqual([orphan]);
    expect(storage.paths("documents").sort()).toEqual([attached, fresh, ticket].sort());
    expect(body.deleted).toBe(1);
    expect(body.orphans).toBe(1);
    expect(body.kept_on_message).toBe(1);
    expect(body.kept_open_ticket).toBe(1);
    expect(body.kept_fresh).toBe(1);
    expect(body.dry).toBe(false);
    expect(body.errors).toEqual([]);
    expect(body.per_tenant[T1]).toEqual({ scanned: 4, orphans: 1, deleted: 1 });
  });

  it("a file exactly a few minutes under 24 h is still fresh", async () => {
    const almost = file(T1, C1, 1);
    const { storage } = setup([{ path: almost, created_at: new Date(NOW - 24 * 3600_000 + 60_000).toISOString() }]);
    const body = await (await GET(req())).json();
    expect(storage.removed).toEqual([]);
    expect(body.kept_fresh).toBe(1);
  });

  it("never touches other folders of the documents bucket, or other buckets", async () => {
    const orphan = file(T1, C1, 1);
    const invoice = `${T1}/invoices/${U(9)}_inv.pdf`;
    const rootFile = `${T1}/old.pdf`;
    const chatLookalike = `${T1}/chatter/${C1}/${U(8)}_x.pdf`;
    const otherBucket = `${T1}/chat/${C1}/${U(7)}_y.pdf`;
    const storage = fakeStorage({
      documents: [
        { path: orphan, created_at: HOURS(30) },
        { path: invoice, created_at: HOURS(500) },
        { path: rootFile, created_at: HOURS(500) },
        { path: chatLookalike, created_at: HOURS(500) },
      ],
      "attendance-selfies": [{ path: otherBucket, created_at: HOURS(500) }],
    });
    const pg = fakePostgrest({ tenants: [{ id: T1 }], chat_attachments: [], chat_upload_tickets: [] });
    db.current = { client: { ...pg.client, storage: storage.client } };

    const body = await (await GET(req())).json();
    expect(storage.removed).toEqual([orphan]);
    expect(storage.paths("documents").sort()).toEqual([chatLookalike, invoice, rootFile].sort());
    expect(storage.paths("attendance-selfies")).toEqual([otherBucket]);
    expect(storage.listedPrefixes.every((p) => p.bucket === "documents" && p.prefix.startsWith(`${T1}/chat`))).toBe(true);
    expect(body.deleted).toBe(1);
  });

  it("counts per tenant", async () => {
    setup([
      { path: file(T1, C1, 1), created_at: HOURS(30) },
      { path: file(T1, C1, 2), created_at: HOURS(30) },
      { path: file(T2, C2, 3), created_at: HOURS(30) },
    ]);
    const body = await (await GET(req())).json();
    expect(body.tenants).toBe(2);
    expect(body.per_tenant[T1]).toEqual({ scanned: 2, orphans: 2, deleted: 2 });
    expect(body.per_tenant[T2]).toEqual({ scanned: 1, orphans: 1, deleted: 1 });
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining(`[cron/chat-files-cleanup] ${T1}: scanned 2, orphans 2, deleted 2`));
  });
});

describe("chat-files-cleanup — dry run, cap, failures", () => {
  it("?dry=1 counts the orphans and deletes nothing", async () => {
    const { storage } = setup([{ path: file(T1, C1, 1), created_at: HOURS(30) }]);
    const body = await (await GET(req("?dry=1"))).json();
    expect(storage.removed).toEqual([]);
    expect(storage.removeCalls).toBe(0);
    expect(body.dry).toBe(true);
    expect(body.orphans).toBe(1);
    expect(body.deleted).toBe(0);
  });

  it(`deletes at most ${MAX_DELETES_PER_RUN} per run, in batches, and says it stopped`, async () => {
    const many = Array.from({ length: MAX_DELETES_PER_RUN + 20 }, (_, i) => ({ path: file(T1, C1, i + 1), created_at: HOURS(30) }));
    const { storage } = setup(many);
    const body = await (await GET(req())).json();
    expect(storage.removed).toHaveLength(MAX_DELETES_PER_RUN);
    expect(storage.maxBatch).toBeLessThanOrEqual(100);
    expect(body.deleted).toBe(MAX_DELETES_PER_RUN);
    expect(body.capped).toBe(true);
  });

  it("reads storage folders page by page (more than one page of files)", async () => {
    const many = Array.from({ length: 1205 }, (_, i) => ({ path: file(T1, C1, i + 1), created_at: HOURS(2) }));
    setup(many);
    const body = await (await GET(req())).json();
    expect(body.scanned).toBe(1205);
    expect(body.kept_fresh).toBe(1205);
  });

  it("when the message lookup fails, nothing of that tenant is deleted", async () => {
    const { storage, pg } = setup([{ path: file(T1, C1, 1), created_at: HOURS(30) }]);
    const client = pg.client as { from: (t: string) => unknown };
    db.current = {
      client: {
        storage: storage.client,
        from: (t: string) => (t === "chat_attachments"
          ? { select: () => ({ in: async () => ({ data: null, error: { message: "boom" } }) }) }
          : client.from(t)),
      },
    };
    const body = await (await GET(req())).json();
    expect(storage.removed).toEqual([]);
    expect(body.errors.length).toBe(1);
    expect(body.errors[0]).toContain("boom");
  });

  it("a failed storage delete is reported, not counted as deleted", async () => {
    const { storage } = setup([{ path: file(T1, C1, 1), created_at: HOURS(30) }]);
    storage.failRemove = "storage down";
    const body = await (await GET(req())).json();
    expect(body.deleted).toBe(0);
    expect(body.errors[0]).toContain("storage down");
  });
});

describe("chat-files-cleanup — auth", () => {
  it("refuses without the cron secret, and touches nothing", async () => {
    const { storage } = setup([{ path: file(T1, C1, 1), created_at: HOURS(30) }]);
    const res = await GET(req("", null));
    expect(res.status).toBe(401);
    const wrong = await POST(req("", "nope"));
    expect(wrong.status).toBe(401);
    expect(storage.listedPrefixes).toEqual([]);
    expect(storage.removed).toEqual([]);
  });

  it("503 when CRON_SECRET is not set", async () => {
    delete process.env.CRON_SECRET;
    setup([]);
    expect((await GET(req())).status).toBe(503);
  });
});
