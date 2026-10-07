/**
 * GET /api/inbound-emails — keyset pages (S37). Pinned: no params is the same newest-first
 * page as before; the next cursor rides in a header only when there IS a next page; a cursor
 * becomes "strictly older" in (created_at desc, id desc) and is passed through unrounded;
 * half a cursor is a 400, never a silent first page; the tenant filter is always applied.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { INBOX_LIST_MAX_ROWS } from "@/lib/inbound/list-columns";
import { MAIL_FOLDERS } from "@/lib/inbound/folders";

type Call = { method: string; args: unknown[] };
const state = vi.hoisted(() => ({
  calls: [] as { method: string; args: unknown[] }[],
  rows: [] as Record<string, unknown>[],
  user: { id: "U1" } as { id: string } | null,
}));

vi.mock("@/lib/supabase/server", () => {
  const listBuilder = () => {
    const b: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ["select", "eq", "or", "order", "in"]) {
      b[m] = (...args: unknown[]) => { state.calls.push({ method: m, args }); return b; };
    }
    b.limit = (...args: unknown[]) => {
      state.calls.push({ method: "limit", args });
      const n = args[0] as number;
      return Promise.resolve({ data: state.rows.slice(0, n), error: null });
    };
    /* The html-fallback query ends in .in(), which is awaited directly. */
    b.then = (resolve: unknown) => (resolve as (v: unknown) => void)({ data: [], error: null });
    return b;
  };
  return {
    createAdminClient: () => ({ from: () => listBuilder() }),
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: state.user } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { tenant_id: "T1" } }) }) }) }),
    }),
  };
});

import { GET } from "./route";

const mail = (i: number) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  created_at: `2026-09-28T10:00:00.${String(999999 - i).padStart(6, "0")}+00:00`,
  body_text: "hello",
});
const req = (qs = "") => new Request(`https://example.invalid/api/inbound-emails${qs}`);
const calls = (m: string): Call[] => state.calls.filter((c) => c.method === m);

beforeEach(() => {
  state.calls = [];
  state.rows = [];
  state.user = { id: "U1" };
});

describe("GET /api/inbound-emails — pages", () => {
  it("no params: newest first, tenant-scoped, id as tie-breaker, one row over-fetched", async () => {
    state.rows = [mail(1), mail(2)];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(2);
    expect(calls("eq")[0].args).toEqual(["tenant_id", "T1"]);
    expect(calls("or")).toHaveLength(0);
    expect(calls("order").map((c) => c.args)).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(calls("limit")[0].args).toEqual([INBOX_LIST_MAX_ROWS + 1]);
    expect(res.headers.get("x-next-cursor")).toBeNull();
  });

  it("a full page plus one: serves the page and hands back the LAST served row as the cursor", async () => {
    state.rows = Array.from({ length: INBOX_LIST_MAX_ROWS + 1 }, (_, i) => mail(i));
    const res = await GET(req());
    const body = (await res.json()) as { id: string }[];
    expect(body).toHaveLength(INBOX_LIST_MAX_ROWS);
    const last = mail(INBOX_LIST_MAX_ROWS - 1);
    expect(JSON.parse(res.headers.get("x-next-cursor")!)).toEqual({ created_at: last.created_at, id: last.id });
  });

  it("a cursor becomes 'strictly older', with the timestamp passed through unrounded", async () => {
    const c = mail(7);
    const res = await GET(req(`?before=${encodeURIComponent(c.created_at)}&before_id=${c.id}`));
    expect(res.status).toBe(200);
    expect(calls("or")[0].args[0]).toBe(
      `created_at.lt."${c.created_at}",and(created_at.eq."${c.created_at}",id.lt.${c.id})`,
    );
    expect(calls("eq")[0].args).toEqual(["tenant_id", "T1"]);
  });

  it("half a cursor, or a malformed one, is a 400 — not a silent first page", async () => {
    expect((await GET(req("?before=2026-09-28T10:00:00Z"))).status).toBe(400);
    expect((await GET(req("?before_id=00000000-0000-4000-8000-000000000001"))).status).toBe(400);
    expect((await GET(req("?before=nope&before_id=00000000-0000-4000-8000-000000000001"))).status).toBe(400);
    expect((await GET(req("?before=2026-09-28T10:00:00Z&before_id=1),or(tenant_id.neq.x"))).status).toBe(400);
    expect(calls("limit")).toHaveLength(0);
  });

  /* R-363: folders are filtered on the client. A `folder` param (the page URL carries one
     since R-286) must never change the query or turn into an error. */
  it("every folder name is a 200 and the same tenant-scoped first page", async () => {
    state.rows = [mail(1)];
    for (const f of MAIL_FOLDERS.map((x) => x.id)) {
      state.calls = [];
      const res = await GET(req(`?folder=${f}`));
      expect(res.status).toBe(200);
      expect(calls("eq")[0].args).toEqual(["tenant_id", "T1"]);
      expect(calls("or")).toHaveLength(0);
    }
  });

  it("still refuses a signed-out caller", async () => {
    state.user = null;
    expect((await GET(req())).status).toBe(401);
  });
});
