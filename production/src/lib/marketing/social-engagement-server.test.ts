/**
 * R-2689: reading comments and sending replies through Meta. fetch and the database are faked;
 * nothing reaches Meta or a real database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/gemini", () => ({ geminiJson: vi.fn(), resolveGeminiConfig: vi.fn() }));
vi.mock("@/lib/integrations/facebook-page", () => ({ readFacebookPage: vi.fn() }));
vi.mock("./social-content", () => ({ metaFollowers: vi.fn(), instagramForPage: vi.fn() }));
const logMock = vi.fn();
vi.mock("./social-activity", () => ({ logSystemActivity: (...a: unknown[]) => logMock(...a) }));

import { fetchComments, sendReply, COMMENT_PERMISSION_HELP } from "./social-engagement.server";

/** A tiny fake of the supabase-js query builder: records every call, answers from `answers`. */
function fakeDb(answers: Record<string, unknown>) {
  const calls: { table: string; op: string; payload?: unknown; filters: [string, unknown][] }[] = [];
  const from = (table: string) => {
    const call = { table, op: "select", payload: undefined as unknown, filters: [] as [string, unknown][] };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: chain, order: chain, limit: chain, gte: chain, not: chain, neq: chain,
      eq: (k: string, v: unknown) => { call.filters.push([k, v]); return b; },
      update: (p: unknown) => { call.op = "update"; call.payload = p; return b; },
      upsert: (p: unknown) => { call.op = "upsert"; call.payload = p; return b; },
      maybeSingle: async () => ({ data: answers[`${table}:single`] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) => res({ data: answers[`${table}:${call.op}`] ?? [], error: null }),
    });
    return b;
  };
  return { db: { from } as never, calls };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const err = (code: number, message: string) => ({ ok: false, status: 400, json: async () => ({ error: { code, message } }) }) as unknown as Response;
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); logMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });
const CONN = { pageId: "999", pageToken: "tok" };
const T = "11111111-1111-4111-8111-111111111111";

describe("R-2689 reading comments", () => {
  it("saves people's comments (not the Page's own replies) with the company's id", async () => {
    const { db, calls } = fakeDb({
      "social_content:select": [{ id: "c1", platform: "facebook", external_id: "999_1" }, { id: "c2", platform: "instagram", external_id: "ig1" }],
      "social_comments:upsert": [{ id: "x" }, { id: "y" }],
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/999_1/comments")) return ok({ data: [{ id: "k1", message: "Price?", from: { id: "55", name: "Ravi" }, created_time: "2026-11-13T05:00:00Z" }, { id: "k2", message: "Thanks!", from: { id: "999", name: "Page" } }] });
      if (url.includes("/ig1/comments")) return ok({ data: [{ id: "k3", text: "Nice", username: "asha" }] });
      return ok({});
    });
    const r = await fetchComments(db, T, CONN);
    expect(r).toEqual({ added: 2, noPermission: false });
    const saved = calls.find((c) => c.table === "social_comments" && c.op === "upsert")!.payload as { external_id: string; tenant_id: string; author: string }[];
    expect(saved.map((s) => s.external_id)).toEqual(["k1", "k3"]);
    expect(saved.every((s) => s.tenant_id === T)).toBe(true);
    expect(saved[1].author).toBe("@asha");
    expect(calls.find((c) => c.table === "social_content")!.filters).toContainEqual(["tenant_id", T]);
  });

  it("missing permission is saved as the plain help text, not a silent empty list", async () => {
    const { db, calls } = fakeDb({ "social_content:select": [{ id: "c1", platform: "facebook", external_id: "999_1" }] });
    fetchMock.mockResolvedValue(err(10, "(#10) This endpoint requires the 'pages_read_user_content' permission"));
    expect(await fetchComments(db, T, CONN)).toEqual({ added: 0, noPermission: true });
    const settings = calls.find((c) => c.table === "social_content_settings")!.payload as { comments_problem: string };
    expect(settings.comments_problem).toBe(COMMENT_PERMISSION_HELP);
  });
});

describe("R-2689 sending a reply", () => {
  it("Facebook: replies under the comment and records who replied", async () => {
    const { db, calls } = fakeDb({ "social_comments:single": { id: "r1", platform: "facebook", external_id: "k1", status: "draft", message: "Price?" } });
    fetchMock.mockResolvedValue(ok({ id: "reply1" }));
    const r = await sendReply(db, T, CONN, "r1", "  Please message us, we will help.  ", { actor: "person", userId: "u1", name: "" });
    expect(r).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/k1\/comments$/);
    expect((init.body as URLSearchParams).get("message")).toBe("Please message us, we will help.");
    const upd = calls.find((c) => c.table === "social_comments" && c.op === "update")!;
    expect(upd.payload).toMatchObject({ status: "replied", replied_by: "person", replied_user: "u1" });
    expect(upd.filters).toContainEqual(["tenant_id", T]);
    expect(logMock.mock.calls[0][2]).toMatchObject({ actor: "person", userId: "u1", action: "Replied to a comment" });
  });

  it("Instagram uses /replies; a comment already answered is never answered twice", async () => {
    const ig = fakeDb({ "social_comments:single": { id: "r2", platform: "instagram", external_id: "k3", status: "draft", message: "Nice" } });
    fetchMock.mockResolvedValue(ok({ id: "rep" }));
    await sendReply(ig.db, T, CONN, "r2", "Thank you!", { actor: "ai" });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/k3\/replies$/);

    fetchMock.mockReset();
    const done = fakeDb({ "social_comments:single": { id: "r3", platform: "facebook", external_id: "k9", status: "replied", message: "x" } });
    expect(await sendReply(done.db, T, CONN, "r3", "Hi", { actor: "ai" })).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
