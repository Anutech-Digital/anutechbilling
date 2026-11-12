/**
 * R-2706: reading a post's results from Meta. fetch is mocked; nothing reaches Meta.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({ withTenant: vi.fn() }));

import { facebookPostStats, instagramPostStats } from "./social-stats.server";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const err = (code: number, message: string) => ({ ok: false, status: 400, json: async () => ({ error: { code, message } }) }) as unknown as Response;
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });
const route = (map: Record<string, Response>) => fetchMock.mockImplementation(async (url: string) => {
  const path = new URL(url).pathname.replace(/^\/v[\d.]+\//, "");
  return map[path] ?? err(100, "unknown path " + path);
});

describe("R-2706 Facebook results", () => {
  it("a photo post: finds its post, reads reactions, comments, shares and reach", async () => {
    route({
      "123": ok({ page_story_id: "999_123" }),
      "999_123": ok({ reactions: { summary: { total_count: 18 } }, comments: { summary: { total_count: 4 } }, shares: { count: 2 } }),
      "999_123/insights": ok({ data: [{ name: "post_impressions_unique", values: [{ value: 420 }] }] }),
    });
    const r = await facebookPostStats("123", "tok");
    expect(r).toEqual({ stats: { likes: 18, comments: 4, shares: 2, saves: null, reach: 420 }, noPermission: false });
  });

  it("no shares field means 0 shares; missing read_insights → counts kept, reach null, says reconnect", async () => {
    route({
      "999_5": ok({ reactions: { summary: { total_count: 3 } }, comments: { summary: { total_count: 0 } } }),
      "999_5/insights": err(10, "(#10) Requires read_insights permission"),
    });
    const r = await facebookPostStats("999_5", "tok");
    expect(r.stats).toEqual({ likes: 3, comments: 0, shares: 0, saves: null, reach: null });
    expect(r.noPermission).toBe(true);
  });
});

describe("R-2706 Instagram results", () => {
  it("reads likes, comments, reach, saves and shares", async () => {
    route({
      "777": ok({ like_count: 40, comments_count: 5 }),
      "777/insights": ok({ data: [{ name: "reach", values: [{ value: 900 }] }, { name: "saved", values: [{ value: 12 }] }, { name: "shares", total_value: { value: 3 } }] }),
    });
    expect((await instagramPostStats("777", "tok")).stats).toEqual({ likes: 40, comments: 5, reach: 900, saves: 12, shares: 3 });
  });

  it("Meta down → nothing invented", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    const r = await instagramPostStats("777", "tok");
    expect(r.stats).toEqual({ likes: null, comments: null, reach: null, saves: null, shares: null });
    expect(r.noPermission).toBe(false);
  });
});
